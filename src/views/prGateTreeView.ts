import * as vscode from 'vscode';
import { onSettingsChanged, readWorkspaceSettings } from '../config/settings';
import { type ResolvedContext } from '../context/zuulContext';
import { collectGateFacts, collectUpstreamFacts } from '../services/gateFacts';
import {
  buildGateChildren,
  formatGateHeader,
  type GateTreeNode,
} from '../services/gatePresentation';
import {
  evaluateGate,
  type GateReport,
  type GateRules,
  gateLoadFailureReport,
  resolveGateRules,
} from '../services/gateReadiness';
import { KeyedAsyncCache } from '../services/keyedAsyncCache';
import { type PrSnapshot } from '../services/prTracker';
import { type Logger } from '../util/logger';
import { OPEN_DEPENDENCY_PR_COMMAND } from './dependsOnTreeView';
import { uniqueIds } from '../util/treeIds';

export const GATE_REFRESH_MIN_INTERVAL_MS = 30_000;

export interface GateTrackerSource {
  readonly snapshot: PrSnapshot | undefined;
  readonly onDidChange: vscode.Event<PrSnapshot | undefined>;
}

export interface GateContextSource {
  readonly current: ResolvedContext | undefined;
}

export class PrGateTreeDataProvider
  implements vscode.TreeDataProvider<GateTreeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<GateTreeNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly cache: KeyedAsyncCache<GateReport>;
  private readonly prIds = new WeakMap<GateTreeNode, string>();

  readonly onDidChangeTreeData: vscode.Event<GateTreeNode | undefined> = this.emitter.event;

  constructor(
    private readonly tracker: GateTrackerSource,
    private readonly ctx: GateContextSource,
    private readonly getRules: () => GateRules,
    private readonly logger: Logger,
    now: () => number = Date.now,
  ) {
    this.cache = new KeyedAsyncCache<GateReport>(GATE_REFRESH_MIN_INTERVAL_MS, now);
    this.disposables.push(
      this.tracker.onDidChange(() => {
        this.emitter.fire(undefined);
      }),
      onSettingsChanged(() => {
        this.emitter.fire(undefined);
      }),
    );
  }

  invalidateCache(): void {
    this.cache.invalidate();
  }

  private async getReport(): Promise<GateReport | undefined> {
    const snapshot = this.tracker.snapshot;
    const rc = this.ctx.current;
    if (!snapshot || !rc) {
      return undefined;
    }
    const rules = resolveGateRules(this.getRules(), rc.zuul?.tenant);
    // When Zuul is failing, only the poll talks to it.
    const zuul = snapshot.zuul.kind === 'ok' ? rc.zuul : undefined;
    const key = JSON.stringify([
      rc.host,
      rc.owner,
      rc.repo,
      rc.zuul?.tenant ?? '',
      zuul ? 'zuul' : 'no-zuul',
      snapshot.pr.number,
      snapshot.pr.head.sha,
      snapshot.pr.updated_at ?? '',
      rules,
    ]);
    try {
      return await this.cache.get(key, async () => {
        try {
          const [root, upstream] = await Promise.all([
            collectGateFacts(rc.ghe, zuul?.client, zuul?.tenant, snapshot.pr),
            collectUpstreamFacts(rc.ghe, zuul?.client, zuul?.tenant, snapshot.pr),
          ]);
          return evaluateGate(root, upstream, rules);
        } catch (err) {
          this.logger.warn(
            `[Gate] Failed to collect gate facts: ${err instanceof Error ? err.message : String(err)}`,
          );
          throw err;
        }
      });
    } catch (err) {
      // Never fall back to an older (possibly "Ready") report.
      return gateLoadFailureReport(
        `${snapshot.pr.base.repo.full_name}#${snapshot.pr.number}`,
        err instanceof Error ? err.message : String(err),
      );
    }
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
      const id = this.prIds.get(element);
      if (id !== undefined) {
        item.id = id;
      }
      item.contextValue = 'zuulGatePr';
      const url = element.url;
      if (url) {
        item.tooltip = url;
        item.command = {
          command: OPEN_DEPENDENCY_PR_COMMAND,
          title: 'Open Pull Request',
          arguments: [url],
        };
      }
      return item;
    }
    if (element.kind === 'triggers') {
      const item = new vscode.TreeItem('Triggers', vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'gate/triggers';
      item.contextValue = 'zuulGateTriggers';
      return item;
    }
    if (element.kind === 'trigger') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.description = element.comment;
      item.iconPath = new vscode.ThemeIcon(element.icon);
      item.contextValue = 'zuulGateTrigger';
      item.command = {
        command: 'zuul.postTrigger',
        title: 'Post Trigger Comment',
        arguments: [element.comment],
      };
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
    const nodes = buildGateChildren(undefined, report, readWorkspaceSettings().triggerComments);
    const prNodes = nodes.filter((n) => n.kind === 'pr');
    const ids = uniqueIds(prNodes.map((n) => `gate/pr/${n.pr}`));
    prNodes.forEach((n, i) => this.prIds.set(n, ids[i]));
    return nodes;
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
