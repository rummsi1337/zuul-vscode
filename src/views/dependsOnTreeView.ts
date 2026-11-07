import * as vscode from 'vscode';
import { type SearchItem } from '../clients/gheTypes';
import { type ChangeStatus } from '../clients/zuulTypes';
import { classifyJobResult } from '../services/buildsModel';
import {
  type DependsOnRef,
  parseDependsOn,
  removeDependsOn,
  toPrUrl,
} from '../services/dependsOnParser';
import {
  DependsOnService,
  type SyncState,
  syncState,
  type UpstreamDep,
  type UpstreamState,
} from '../services/dependsOnService';
import { type PrSnapshot, type ZuulContextSource } from '../services/prTracker';
import { type Logger } from '../util/logger';
import { buildTenantProjectSet, searchItemToCandidate } from './addDependsOnPick';

export const DEPENDS_ON_REFRESH_TTL_MS = 60_000;
export const OPEN_DEPENDENCY_PR_COMMAND = 'zuul.openDependencyPr';
export const CONFIRM_REMOVE_ACTION = 'Remove';

export interface OutOfSyncRootNode {
  readonly kind: 'out-of-sync-root';
  readonly sync: SyncState;
}

export interface OutOfSyncChildNode {
  readonly kind: 'out-of-sync-item';
  readonly direction: 'missing' | 'extra';
  readonly ref: string;
}

export interface DependsOnGroupNode {
  readonly kind: 'depends-on-group';
  readonly items: readonly UpstreamDep[];
  readonly host?: string;
}

export interface NeededByGroupNode {
  readonly kind: 'needed-by-group';
  readonly items: readonly SearchItem[];
  readonly host?: string;
}

export interface UpstreamDepNode {
  readonly kind: 'upstream-dep';
  readonly dep: UpstreamDep;
  readonly host?: string;
}

export interface DownstreamDepNode {
  readonly kind: 'downstream-dep';
  readonly item: SearchItem;
  readonly host?: string;
}

export type DependsOnTreeNode =
  | OutOfSyncRootNode
  | OutOfSyncChildNode
  | DependsOnGroupNode
  | NeededByGroupNode
  | UpstreamDepNode
  | DownstreamDepNode;

export interface DependsOnTrackerSource {
  readonly snapshot: PrSnapshot | undefined;
  readonly onDidChange: vscode.Event<PrSnapshot | undefined>;
  refresh(): Promise<void>;
}

export function getUpstreamIconId(state: UpstreamState): string {
  switch (state) {
    case 'open':
      return 'git-pull-request';
    case 'merged':
      return 'git-merge';
    case 'closed':
      return 'git-pull-request-closed';
    case 'missing':
      return 'warning';
  }
}

export function formatUpstreamLabel(dep: UpstreamDep): string {
  if (dep.ref.owner && dep.ref.repo && dep.ref.number !== undefined) {
    return `${dep.ref.owner}/${dep.ref.repo}#${dep.ref.number}`;
  }
  return dep.ref.raw;
}

function selectPrimaryStatus(statuses: readonly ChangeStatus[]): ChangeStatus | undefined {
  const gate = statuses.find((s) => s.pipeline.toLowerCase() === 'gate');
  if (gate) {
    return gate;
  }
  const check = statuses.find((s) => s.pipeline.toLowerCase() === 'check');
  if (check) {
    return check;
  }
  return statuses[0];
}

export function formatUpstreamZuulSummary(zuul: readonly ChangeStatus[] | undefined): string {
  if (!zuul || zuul.length === 0) {
    return 'not in Zuul';
  }

  const status = selectPrimaryStatus(zuul);
  if (!status) {
    return 'not in Zuul';
  }

  const pipeline = status.pipeline || 'check';
  const jobs = status.jobs ?? [];
  if (jobs.length === 0) {
    return `${pipeline}: queued`;
  }

  let doneCount = 0;
  for (const job of jobs) {
    const trimmed = job.result?.trim();
    if (trimmed) {
      doneCount += 1;
      if (classifyJobResult(trimmed) === 'failure') {
        return `${pipeline}: FAILURE`;
      }
    }
  }

  if (doneCount === jobs.length) {
    return `${pipeline}: SUCCESS`;
  }

  return `${pipeline}: ${doneCount}/${jobs.length}`;
}

export function formatUpstreamDescription(dep: UpstreamDep): string {
  return `${dep.state} · ${formatUpstreamZuulSummary(dep.zuul)}`;
}

export function formatUpstreamTooltip(dep: UpstreamDep): string {
  const lines: string[] = [];
  const label = formatUpstreamLabel(dep);
  if (dep.pr?.title) {
    lines.push(`${label}: ${dep.pr.title}`);
  } else {
    lines.push(label);
  }
  lines.push(`State: ${dep.state}`);
  lines.push(`Zuul: ${formatUpstreamZuulSummary(dep.zuul)}`);
  if (dep.warning) {
    lines.push(`Warning: ${dep.warning}`);
  }
  return lines.join('\n');
}

export function resolveUpstreamUrl(dep: UpstreamDep, fallbackHost?: string): string | undefined {
  if (dep.pr?.html_url) {
    return dep.pr.html_url;
  }
  if (dep.ref.url) {
    return dep.ref.url;
  }
  const host = dep.ref.host ?? fallbackHost;
  if (host && dep.ref.owner && dep.ref.repo && dep.ref.number !== undefined) {
    return toPrUrl(host, dep.ref.owner, dep.ref.repo, dep.ref.number);
  }
  return undefined;
}

export function formatDownstreamLabel(item: SearchItem, fallbackHost = 'github.com'): string {
  const candidate = searchItemToCandidate(item, fallbackHost);
  if (candidate) {
    return `${candidate.owner}/${candidate.repo}#${candidate.number}`;
  }
  return `#${item.number}`;
}

export async function openDependencyPrExternally(
  target?: string | UpstreamDepNode | DownstreamDepNode,
  openExternal: (uri: vscode.Uri) => Thenable<boolean> = (uri) => vscode.env.openExternal(uri),
): Promise<void> {
  let url: string | undefined;
  if (typeof target === 'string') {
    url = target;
  } else if (target?.kind === 'upstream-dep') {
    url = resolveUpstreamUrl(target.dep, target.host);
  } else if (target?.kind === 'downstream-dep') {
    url = target.item.html_url;
  }
  if (!url) {
    return;
  }
  await openExternal(vscode.Uri.parse(url));
}

function extractRemovalCoordinates(
  target: unknown,
): { owner: string; repo: string; number: number } | undefined {
  if (!target || typeof target !== 'object') {
    return undefined;
  }
  const obj = target as Record<string, unknown>;
  if (obj.kind === 'upstream-dep' && obj.dep && typeof obj.dep === 'object') {
    return extractRemovalCoordinates(obj.dep);
  }
  if (obj.ref && typeof obj.ref === 'object') {
    return extractRemovalCoordinates(obj.ref);
  }
  if (
    typeof obj.owner === 'string' &&
    typeof obj.repo === 'string' &&
    typeof obj.number === 'number'
  ) {
    return {
      owner: obj.owner,
      repo: obj.repo,
      number: obj.number,
    };
  }
  return undefined;
}

export class DependsOnTreeDataProvider
  implements vscode.TreeDataProvider<DependsOnTreeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<DependsOnTreeNode | undefined | void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly ctx: ZuulContextSource;
  private readonly tracker: DependsOnTrackerSource;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly openExternal: (uri: vscode.Uri) => Thenable<boolean>;

  private cachedPrKey: string | undefined;
  private cachedBody: string | undefined;
  private lastFetchedAt: number | undefined;
  private upstream: UpstreamDep[] = [];
  private downstream: SearchItem[] = [];
  private hasLoadedOnceForPr = false;
  private inFlightPromise: Promise<void> | undefined;
  private fetchSeq = 0;
  private disposed = false;

  readonly onDidChangeTreeData: vscode.Event<DependsOnTreeNode | undefined | void> =
    this.emitter.event;

  constructor(
    ctx: ZuulContextSource,
    tracker: DependsOnTrackerSource,
    logger: Logger,
    now: () => number = Date.now,
    openExternal: (uri: vscode.Uri) => Thenable<boolean> = (uri) => vscode.env.openExternal(uri),
  ) {
    this.ctx = ctx;
    this.tracker = tracker;
    this.logger = logger;
    this.now = now;
    this.openExternal = openExternal;

    this.disposables.push(
      this.tracker.onDidChange(() => {
        this.handleSnapshotChange();
      }),
    );

    if (this.tracker.snapshot) {
      this.handleSnapshotChange();
    }
  }

  invalidateCache(): void {
    this.lastFetchedAt = undefined;
    this.cachedBody = undefined;
  }

  refresh(): void {
    this.invalidateCache();
    this.handleSnapshotChange();
  }

  async openPr(target?: string | UpstreamDepNode | DownstreamDepNode): Promise<void> {
    await openDependencyPrExternally(target, this.openExternal);
  }

  async removeDependsOn(target?: unknown): Promise<boolean> {
    if (this.disposed) {
      return false;
    }

    const currentCtx = this.ctx.current;
    const snapshot = this.tracker.snapshot;
    if (!currentCtx || !snapshot) {
      this.logger.warn('[DependsOn] Cannot remove Depends-On: no active pull request');
      return false;
    }

    let coords = extractRemovalCoordinates(target);
    if (!coords) {
      const refs = parseDependsOn(snapshot.pr.body).filter(
        (r): r is DependsOnRef & { owner: string; repo: string; number: number } =>
          Boolean(r.owner && r.repo && r.number !== undefined),
      );
      if (refs.length === 0) {
        return false;
      }
      const picked = await vscode.window.showQuickPick(
        refs.map((r) => ({
          label: `${r.owner}/${r.repo}#${r.number}`,
          description: r.raw,
          coords: { owner: r.owner, repo: r.repo, number: r.number },
        })),
        { placeHolder: 'Select Depends-On reference to remove' },
      );
      coords = picked?.coords;
    }

    if (!coords) {
      return false;
    }

    const message = `Remove Depends-On ${coords.owner}/${coords.repo}#${coords.number} from ${currentCtx.owner}/${currentCtx.repo}#${snapshot.pr.number}?`;
    const choice = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      CONFIRM_REMOVE_ACTION,
    );
    if (choice !== CONFIRM_REMOVE_ACTION || this.disposed) {
      return false;
    }

    const freshPr = await currentCtx.ghe.getPr(
      currentCtx.owner,
      currentCtx.repo,
      snapshot.pr.number,
    );
    if (this.disposed) {
      return false;
    }

    const nextBody = removeDependsOn(freshPr.body, coords);
    await currentCtx.ghe.updatePrBody(
      currentCtx.owner,
      currentCtx.repo,
      snapshot.pr.number,
      nextBody,
    );

    this.logger.info(
      `[DependsOn] Removed Depends-On ${coords.owner}/${coords.repo}#${coords.number} from ${currentCtx.owner}/${currentCtx.repo}#${snapshot.pr.number}`,
    );

    this.invalidateCache();
    await this.tracker.refresh();
    return true;
  }

  private getPrKey(snapshot: PrSnapshot): string | undefined {
    const currentCtx = this.ctx.current;
    if (!currentCtx) {
      return undefined;
    }
    return `${currentCtx.tenant}:${currentCtx.project}#${snapshot.pr.number}`;
  }

  private needsFetch(snapshot: PrSnapshot): boolean {
    const prKey = this.getPrKey(snapshot);
    if (!prKey) {
      return false;
    }
    const body = snapshot.pr.body ?? '';
    if (
      this.cachedPrKey !== prKey ||
      this.cachedBody !== body ||
      this.lastFetchedAt === undefined
    ) {
      return true;
    }
    return this.now() - this.lastFetchedAt >= DEPENDS_ON_REFRESH_TTL_MS;
  }

  private handleSnapshotChange(): void {
    if (this.disposed) {
      return;
    }

    const snapshot = this.tracker.snapshot;
    const currentCtx = this.ctx.current;
    if (!snapshot || !currentCtx) {
      this.fetchSeq += 1;
      this.inFlightPromise = undefined;
      this.cachedPrKey = undefined;
      this.cachedBody = undefined;
      this.lastFetchedAt = undefined;
      this.upstream = [];
      this.downstream = [];
      this.hasLoadedOnceForPr = false;
      this.emitter.fire();
      return;
    }

    const prKey = this.getPrKey(snapshot);
    if (this.cachedPrKey !== prKey) {
      this.upstream = [];
      this.downstream = [];
      this.hasLoadedOnceForPr = false;
    }

    this.emitter.fire();

    if (this.needsFetch(snapshot)) {
      void this.ensureDataLoaded(snapshot);
    }
  }

  private ensureDataLoaded(snapshot: PrSnapshot): Promise<void> {
    const currentCtx = this.ctx.current;
    if (!currentCtx || this.disposed) {
      return Promise.resolve();
    }

    if (!this.needsFetch(snapshot)) {
      return Promise.resolve();
    }

    const prKey = this.getPrKey(snapshot);
    const body = snapshot.pr.body ?? '';
    if (this.inFlightPromise && this.cachedPrKey === prKey && this.cachedBody === body) {
      return this.inFlightPromise;
    }

    this.cachedPrKey = prKey;
    this.cachedBody = body;
    this.lastFetchedAt = this.now();
    const seq = ++this.fetchSeq;

    const promise = (async () => {
      try {
        const service = new DependsOnService(
          currentCtx.ghe,
          currentCtx.zuul,
          currentCtx.tenant,
          async () => {
            const projects = await currentCtx.zuul.listProjects(currentCtx.tenant);
            return buildTenantProjectSet(projects, currentCtx.project);
          },
        );

        const [upstream, downstream] = await Promise.all([
          service.getUpstream(snapshot.pr),
          service.getDownstream(snapshot.pr),
        ]);

        if (this.disposed || seq !== this.fetchSeq) {
          return;
        }

        this.upstream = upstream;
        this.downstream = downstream;
        this.hasLoadedOnceForPr = true;
        this.emitter.fire();
      } catch (err) {
        if (this.disposed || seq !== this.fetchSeq) {
          return;
        }
        this.logger.error('[DependsOn] Failed to load dependencies', err);
      } finally {
        if (seq === this.fetchSeq) {
          this.inFlightPromise = undefined;
        }
      }
    })();

    this.inFlightPromise = promise;
    return promise;
  }

  private computeSyncState(snapshot: PrSnapshot): SyncState {
    if (this.hasLoadedOnceForPr && this.cachedBody === (snapshot.pr.body ?? '')) {
      const normalizedUpstream = this.upstream.map((dep) =>
        dep.state === 'missing' ? { ...dep, state: 'open' as const } : dep,
      );
      return syncState(normalizedUpstream, snapshot.statuses);
    }
    return syncState(snapshot.pr, snapshot.statuses);
  }

  getTreeItem(element: DependsOnTreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'out-of-sync-root': {
        const item = new vscode.TreeItem(
          '$(warning) Out of sync with Zuul',
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon('warning');
        item.contextValue = 'zuulOutOfSync';
        const details: string[] = [];
        if (element.sync.missingInZuul.length > 0) {
          details.push(`Missing in Zuul: ${element.sync.missingInZuul.join(', ')}`);
        }
        if (element.sync.extraInZuul.length > 0) {
          details.push(`Extra in Zuul: ${element.sync.extraInZuul.join(', ')}`);
        }
        item.tooltip = details.join('\n');
        return item;
      }

      case 'out-of-sync-item': {
        const prefix = element.direction === 'missing' ? 'Missing in Zuul' : 'Extra in Zuul';
        const item = new vscode.TreeItem(
          `${prefix}: ${element.ref}`,
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon(
          element.direction === 'missing' ? 'diff-removed' : 'diff-added',
        );
        item.contextValue = 'zuulOutOfSyncItem';
        return item;
      }

      case 'depends-on-group': {
        const item = new vscode.TreeItem(
          `Depends On (${element.items.length})`,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.contextValue = 'zuulDependsOnGroup';
        return item;
      }

      case 'needed-by-group': {
        const item = new vscode.TreeItem(
          `Needed By (${element.items.length})`,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.contextValue = 'zuulNeededByGroup';
        return item;
      }

      case 'upstream-dep': {
        const label = formatUpstreamLabel(element.dep);
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = formatUpstreamDescription(element.dep);
        item.iconPath = new vscode.ThemeIcon(getUpstreamIconId(element.dep.state));
        item.tooltip = formatUpstreamTooltip(element.dep);
        item.contextValue = 'zuulUpstreamDep';

        const url = resolveUpstreamUrl(element.dep, element.host);
        if (url) {
          item.command = {
            command: OPEN_DEPENDENCY_PR_COMMAND,
            title: 'Open Pull Request',
            arguments: [url],
          };
        }
        return item;
      }

      case 'downstream-dep': {
        const label = formatDownstreamLabel(element.item, element.host);
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = element.item.title;
        item.iconPath = new vscode.ThemeIcon('git-pull-request');
        item.tooltip = `${label}: ${element.item.title}`;
        item.contextValue = 'zuulDownstreamDep';

        if (element.item.html_url) {
          item.command = {
            command: OPEN_DEPENDENCY_PR_COMMAND,
            title: 'Open Pull Request',
            arguments: [element.item.html_url],
          };
        }
        return item;
      }
    }
  }

  async getChildren(element?: DependsOnTreeNode): Promise<DependsOnTreeNode[]> {
    const snapshot = this.tracker.snapshot;
    const currentCtx = this.ctx.current;
    if (!snapshot || !currentCtx) {
      return [];
    }

    if (!element) {
      if (this.needsFetch(snapshot)) {
        await this.ensureDataLoaded(snapshot);
      } else if (this.inFlightPromise) {
        await this.inFlightPromise;
      }

      const nodes: DependsOnTreeNode[] = [];
      const sync = this.computeSyncState(snapshot);
      if (!sync.inSync) {
        nodes.push({
          kind: 'out-of-sync-root',
          sync,
        });
      }

      nodes.push(
        {
          kind: 'depends-on-group',
          items: this.upstream,
          host: currentCtx.host,
        },
        {
          kind: 'needed-by-group',
          items: this.downstream,
          host: currentCtx.host,
        },
      );

      return nodes;
    }

    switch (element.kind) {
      case 'out-of-sync-root': {
        const children: OutOfSyncChildNode[] = [];
        for (const ref of element.sync.missingInZuul) {
          children.push({
            kind: 'out-of-sync-item',
            direction: 'missing',
            ref,
          });
        }
        for (const ref of element.sync.extraInZuul) {
          children.push({
            kind: 'out-of-sync-item',
            direction: 'extra',
            ref,
          });
        }
        return children;
      }

      case 'depends-on-group':
        return element.items.map((dep) => ({
          kind: 'upstream-dep',
          dep,
          host: element.host,
        }));

      case 'needed-by-group':
        return element.items.map((item) => ({
          kind: 'downstream-dep',
          item,
          host: element.host,
        }));

      default:
        return [];
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.emitter.dispose();
  }
}
