import * as vscode from 'vscode';
import { type ResolvedContext } from '../context/zuulContext';
import { collectGateFacts, collectUpstreamFacts } from '../services/gateFacts';
import { evaluateGate, type GateReport, type GateRules } from '../services/gateReadiness';
import { type PrSnapshot } from '../services/prTracker';
import { type Logger } from '../util/logger';

export const GATE_REFRESH_MIN_INTERVAL_MS = 30_000;

export interface GateHeaderNode {
  readonly kind: 'header';
  readonly report: GateReport;
}

export interface GatePrNode {
  readonly kind: 'pr';
  readonly pr: string;
  readonly isRoot: boolean;
  readonly report: GateReport;
}

export interface GateCheckNode {
  readonly kind: 'check';
  readonly label: string;
  readonly ok: boolean;
  readonly message?: string;
}

export type GateTreeNode = GateHeaderNode | GatePrNode | GateCheckNode;

export interface GateTrackerSource {
  readonly snapshot: PrSnapshot | undefined;
  readonly onDidChange: vscode.Event<PrSnapshot | undefined>;
}

export interface GateContextSource {
  readonly current: ResolvedContext | undefined;
}

export function formatGateHeader(report: GateReport): { label: string; icon: string } {
  if (report.ready) {
    return { label: 'Ready for gate', icon: 'pass-filled' };
  }
  const n = report.blockers.length;
  return { label: `Not ready: ${n} blocker(s)`, icon: 'circle-slash' };
}

export function buildGateChildren(
  element: GateTreeNode | undefined,
  report: GateReport,
): GateTreeNode[] {
  if (!element) {
    const nodes: GateTreeNode[] = [{ kind: 'header', report }];
    report.items.forEach((item, index) => {
      nodes.push({ kind: 'pr', pr: item.pr, isRoot: index === 0, report });
    });
    return nodes;
  }
  if (element.kind !== 'pr') {
    return [];
  }
  const item = element.report.items.find((i) => i.pr === element.pr);
  const children: GateCheckNode[] = (item?.checks ?? []).map((c) => ({
    kind: 'check',
    label: c.label,
    ok: c.ok,
    ...(c.message !== undefined ? { message: c.message } : {}),
  }));
  if (element.isRoot) {
    for (const b of element.report.blockers) {
      if (b.kind === 'upstream') {
        children.push({ kind: 'check', label: b.pr, ok: false, message: b.message });
      }
    }
  }
  return children;
}

interface CachedReport {
  readonly key: string;
  readonly at: number;
  readonly report: GateReport;
}

export class PrGateTreeDataProvider
  implements vscode.TreeDataProvider<GateTreeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<GateTreeNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private cached: CachedReport | undefined;
  private inflight: { key: string; promise: Promise<GateReport | undefined> } | undefined;

  readonly onDidChangeTreeData: vscode.Event<GateTreeNode | undefined> = this.emitter.event;

  constructor(
    private readonly tracker: GateTrackerSource,
    private readonly ctx: GateContextSource,
    private readonly getRules: () => GateRules,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.disposables.push(
      this.tracker.onDidChange(() => {
        this.emitter.fire(undefined);
      }),
    );
  }

  invalidateCache(): void {
    this.cached = undefined;
  }

  private async getReport(): Promise<GateReport | undefined> {
    const snapshot = this.tracker.snapshot;
    const rc = this.ctx.current;
    if (!snapshot || !rc) {
      return undefined;
    }
    const key = `${rc.tenant}|${snapshot.pr.number}|${snapshot.pr.head.sha}|${snapshot.pr.updated_at ?? ''}`;
    if (
      this.cached &&
      this.cached.key === key &&
      this.now() - this.cached.at < GATE_REFRESH_MIN_INTERVAL_MS
    ) {
      return this.cached.report;
    }
    if (this.inflight?.key === key) {
      return this.inflight.promise;
    }
    const promise = (async (): Promise<GateReport | undefined> => {
      try {
        const [root, upstream] = await Promise.all([
          collectGateFacts(rc.ghe, rc.zuul, rc.tenant, snapshot.pr),
          collectUpstreamFacts(rc.ghe, rc.zuul, rc.tenant, snapshot.pr),
        ]);
        const report = evaluateGate(root, upstream, this.getRules());
        this.cached = { key, at: this.now(), report };
        return report;
      } catch (err) {
        this.logger.warn(
          `[Gate] Failed to collect gate facts: ${err instanceof Error ? err.message : String(err)}`,
        );
        return this.cached?.key === key ? this.cached.report : undefined;
      } finally {
        this.inflight = undefined;
      }
    })();
    this.inflight = { key, promise };
    return promise;
  }

  getTreeItem(element: GateTreeNode): vscode.TreeItem {
    if (element.kind === 'header') {
      const { label, icon } = formatGateHeader(element.report);
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(icon);
      item.contextValue = 'zuulGateHeader';
      return item;
    }
    if (element.kind === 'pr') {
      const item = new vscode.TreeItem(element.pr, vscode.TreeItemCollapsibleState.Expanded);
      item.description = element.isRoot ? 'this PR' : 'upstream';
      item.contextValue = 'zuulGatePr';
      return item;
    }
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(element.ok ? 'check' : 'x');
    if (element.message) {
      item.description = element.message;
      item.tooltip = `${element.label}: ${element.message}`;
    }
    item.contextValue = element.ok ? 'zuulGateCheckOk' : 'zuulGateCheckFailed';
    return item;
  }

  async getChildren(element?: GateTreeNode): Promise<GateTreeNode[]> {
    if (element) {
      return buildGateChildren(element, element.kind === 'pr' ? element.report : emptyReport());
    }
    const report = await this.getReport();
    if (!report) {
      return [];
    }
    return buildGateChildren(undefined, report);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.emitter.dispose();
  }
}

function emptyReport(): GateReport {
  return { ready: false, items: [], blockers: [] };
}
