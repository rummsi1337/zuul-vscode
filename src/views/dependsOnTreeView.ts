import * as vscode from 'vscode';
import { type SearchItem } from '../clients/gheTypes';
import { type QueuedRef } from '../clients/zuulTypes';
import { buildTenantProjectSet } from '../services/dependsOnCandidates';
import { type DependsOnRef, formatPrRef, parseDependsOn } from '../services/dependsOnParser';
import {
  formatDownstreamLabel,
  extractRemovalCoordinates,
  formatUpstreamDescription,
  formatUpstreamLabel,
  formatUpstreamTooltip,
  getUpstreamIconId,
  resolveUpstreamUrl,
} from '../services/dependsOnPresentation';
import {
  applyRemoveDependsOn,
  DependsOnService,
  type SyncState,
  syncState,
  type UpstreamDep,
} from '../services/dependsOnService';
import { KeyedAsyncCache } from '../services/keyedAsyncCache';
import { type PrSnapshot, type ZuulContextSource } from '../services/prTracker';
import { NO_PR_MESSAGE } from '../services/triggerService';
import { type Logger } from '../util/logger';

export const DEPENDS_ON_REFRESH_TTL_MS = 60_000;
export const OPEN_DEPENDENCY_PR_COMMAND = 'zuul.openDependencyPr';
export const CONFIRM_REMOVE_ACTION = 'Remove';

interface OutOfSyncRootNode {
  readonly kind: 'out-of-sync-root';
  readonly sync: SyncState;
}

interface OutOfSyncChildNode {
  readonly kind: 'out-of-sync-item';
  readonly direction: 'missing' | 'extra';
  readonly ref: string;
}

interface DependsOnGroupNode {
  readonly kind: 'depends-on-group';
  readonly items: readonly UpstreamDep[];
  readonly host?: string;
}

interface NeededByGroupNode {
  readonly kind: 'needed-by-group';
  readonly items: readonly SearchItem[];
  readonly host?: string;
}

interface LoadErrorNode {
  readonly kind: 'load-error';
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
  | DownstreamDepNode
  | LoadErrorNode;

export interface DependsOnTrackerSource {
  readonly snapshot: PrSnapshot | undefined;
  readonly onDidChange: vscode.Event<PrSnapshot | undefined>;
  refresh(): Promise<void>;
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
  if (!url || !/^https?:\/\//i.test(url)) {
    return;
  }
  await openExternal(vscode.Uri.parse(url));
}

export class DependsOnTreeDataProvider
  implements vscode.TreeDataProvider<DependsOnTreeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<DependsOnTreeNode | undefined | void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly ctx: ZuulContextSource;
  private readonly tracker: DependsOnTrackerSource;
  private readonly logger: Logger;
  private readonly cache: KeyedAsyncCache<void>;
  private readonly openExternal: (uri: vscode.Uri) => Thenable<boolean>;

  private cachedPrKey: string | undefined;
  private cachedBody: string | undefined;
  private upstream: UpstreamDep[] = [];
  private downstream: SearchItem[] = [];
  private queueAhead: QueuedRef[] | undefined;
  private transitiveUpstream: Set<string> | undefined;
  private hasLoadedOnceForPr = false;
  private loadFailed = false;
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
    this.cache = new KeyedAsyncCache<void>(DEPENDS_ON_REFRESH_TTL_MS, now);
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
    this.cache.invalidate();
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
      void vscode.window.showInformationMessage(NO_PR_MESSAGE);
      return false;
    }

    let coords = extractRemovalCoordinates(target);
    if (!coords) {
      const refs = parseDependsOn(snapshot.pr.body).filter(
        (r): r is DependsOnRef & { owner: string; repo: string; number: number } =>
          Boolean(r.owner && r.repo && r.number !== undefined),
      );
      if (refs.length === 0) {
        void vscode.window.showInformationMessage(
          'This pull request has no Depends-On lines to remove.',
        );
        return false;
      }
      const picked = await vscode.window.showQuickPick(
        refs.map((r) => ({
          label: formatPrRef({ owner: r.owner, repo: r.repo, number: r.number }),
          description: r.raw,
          coords: {
            owner: r.owner,
            repo: r.repo,
            number: r.number,
            ...(r.host ? { host: r.host } : {}),
          },
        })),
        { placeHolder: 'Select Depends-On reference to remove' },
      );
      coords = picked?.coords;
    }

    if (!coords) {
      return false;
    }

    const message = `Remove Depends-On ${formatPrRef(coords)} from ${formatPrRef({ owner: currentCtx.owner, repo: currentCtx.repo, number: snapshot.pr.number })}?`;
    const choice = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      CONFIRM_REMOVE_ACTION,
    );
    if (choice !== CONFIRM_REMOVE_ACTION || this.disposed) {
      return false;
    }

    const changed = await applyRemoveDependsOn(
      currentCtx.ghe,
      { owner: currentCtx.owner, repo: currentCtx.repo, number: snapshot.pr.number },
      coords,
    );

    const prLabel = formatPrRef({
      owner: currentCtx.owner,
      repo: currentCtx.repo,
      number: snapshot.pr.number,
    });
    if (changed) {
      this.logger.info(`[DependsOn] Removed Depends-On ${formatPrRef(coords)} from ${prLabel}`);
    } else {
      this.logger.warn(
        `[DependsOn] Depends-On ${formatPrRef(coords)} was not removed from ${prLabel}: the body did not change`,
      );
    }

    this.invalidateCache();
    await this.tracker.refresh();
    return true;
  }

  private getPrKey(snapshot: PrSnapshot): string | undefined {
    const currentCtx = this.ctx.current;
    if (!currentCtx) {
      return undefined;
    }
    return `${currentCtx.zuul?.tenant ?? ''}:${currentCtx.project}#${snapshot.pr.number}`;
  }

  private getCacheKey(snapshot: PrSnapshot): string | undefined {
    const prKey = this.getPrKey(snapshot);
    if (prKey === undefined) {
      return undefined;
    }
    const zuulPart = snapshot.zuul.kind === 'ok' && this.ctx.current?.zuul ? 'zuul' : 'no-zuul';
    return `${prKey}\n${zuulPart}\n${snapshot.pr.body ?? ''}`;
  }

  private needsFetch(snapshot: PrSnapshot): boolean {
    const key = this.getCacheKey(snapshot);
    return key !== undefined && !this.cache.isFresh(key);
  }

  private handleSnapshotChange(): void {
    if (this.disposed) {
      return;
    }

    const snapshot = this.tracker.snapshot;
    const currentCtx = this.ctx.current;
    if (!snapshot || !currentCtx) {
      this.cache.invalidate();
      this.cachedPrKey = undefined;
      this.cachedBody = undefined;
      this.upstream = [];
      this.downstream = [];
      this.queueAhead = undefined;
      this.transitiveUpstream = undefined;
      this.hasLoadedOnceForPr = false;
      this.loadFailed = false;
      this.emitter.fire();
      return;
    }

    const prKey = this.getPrKey(snapshot);
    if (this.cachedPrKey !== prKey) {
      this.upstream = [];
      this.downstream = [];
      this.queueAhead = undefined;
      this.transitiveUpstream = undefined;
      this.hasLoadedOnceForPr = false;
      this.loadFailed = false;
    }

    // No fetch here: a hidden view never calls getChildren, so it loads nothing.
    this.emitter.fire();
  }

  private ensureDataLoaded(snapshot: PrSnapshot): Promise<void> {
    const currentCtx = this.ctx.current;
    const key = this.getCacheKey(snapshot);
    if (!currentCtx || this.disposed || key === undefined) {
      return Promise.resolve();
    }
    const prKey = this.getPrKey(snapshot);
    const body = snapshot.pr.body ?? '';

    return this.cache.get(key, async (isCurrent) => {
      this.cachedPrKey = prKey;
      this.cachedBody = body;
      try {
        // When Zuul is failing, only the poll talks to it.
        const zuul = snapshot.zuul.kind === 'ok' ? currentCtx.zuul : undefined;
        const service = new DependsOnService(
          currentCtx.ghe,
          zuul?.client,
          zuul?.tenant,
          zuul
            ? async () => {
                const projects = await zuul.client.listProjects(zuul.tenant);
                return buildTenantProjectSet(projects, currentCtx.project);
              }
            : undefined,
        );

        const [upstream, downstream] = await Promise.all([
          service.getUpstream(snapshot.pr),
          service.getDownstream(snapshot.pr),
        ]);

        // Only ask Zuul for the queue when there is something to compare it with.
        let queueAhead: QueuedRef[] | undefined;
        let transitiveUpstream: Set<string> | undefined;
        if (parseDependsOn(snapshot.pr.body).length > 0 && snapshot.statuses.length > 0 && zuul) {
          try {
            [queueAhead, transitiveUpstream] = await Promise.all([
              service.getQueueAhead(snapshot.pr),
              service.getTransitiveUpstreamKeys(snapshot.pr),
            ]);
          } catch (err) {
            this.logger.warn(`[DependsOn] Could not read the Zuul queue: ${String(err)}`);
          }
        }

        if (this.disposed || !isCurrent()) {
          return;
        }

        this.upstream = upstream;
        this.downstream = downstream;
        this.queueAhead = queueAhead;
        this.transitiveUpstream = transitiveUpstream;
        this.hasLoadedOnceForPr = true;
        this.loadFailed = false;
        this.emitter.fire();
      } catch (err) {
        if (this.disposed || !isCurrent()) {
          return;
        }
        this.logger.error('[DependsOn] Failed to load dependencies', err);
        this.loadFailed = true;
        this.emitter.fire();
      }
    });
  }

  private computeSyncState(snapshot: PrSnapshot): SyncState {
    if (this.hasLoadedOnceForPr && this.cachedBody === (snapshot.pr.body ?? '')) {
      const normalizedUpstream = this.upstream.map((dep) =>
        dep.state === 'missing' ? { ...dep, state: 'open' as const } : dep,
      );
      return syncState(normalizedUpstream, this.queueAhead, undefined, this.transitiveUpstream);
    }
    return syncState(snapshot.pr, undefined);
  }

  getTreeItem(element: DependsOnTreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'load-error': {
        const item = new vscode.TreeItem(
          'Could not load dependencies, click to retry',
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon('error');
        item.contextValue = 'zuulDependsOnLoadError';
        item.command = { command: 'zuul.refresh', title: 'Retry' };
        return item;
      }

      case 'out-of-sync-root': {
        const item = new vscode.TreeItem(
          'Out of sync with Zuul',
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon('warning');
        item.id = 'dependencies/out-of-sync';
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
        item.id = 'dependencies/depends-on';
        item.contextValue = 'zuulDependsOnGroup';
        return item;
      }

      case 'needed-by-group': {
        const item = new vscode.TreeItem(
          `Needed By (${element.items.length})`,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = 'dependencies/needed-by';
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
        const label = formatDownstreamLabel(element.item);
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
      }

      if (this.loadFailed) {
        return [{ kind: 'load-error' }];
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
