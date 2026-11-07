import * as vscode from 'vscode';
import {
  buildTree,
  formatDuration,
  type JobNode,
  type JobState,
  type PipelineNode,
} from '../services/buildsModel';
import { type PrSnapshot } from '../services/prTracker';

export type BuildsTreeNode = PipelineNode | JobNode;

export const OPEN_BUILD_LOG_COMMAND = 'zuul.openBuildLog';

export interface BuildsTrackerSource {
  readonly snapshot: PrSnapshot | undefined;
  readonly onDidChange: vscode.Event<PrSnapshot | undefined>;
}

export function isPipelineNode(node: BuildsTreeNode): node is PipelineNode {
  return 'jobs' in node;
}

export function getJobIconId(state: JobState): string {
  switch (state) {
    case 'failure':
      return 'error';
    case 'running':
      return 'sync~spin';
    case 'queued':
      return 'clock';
    case 'success':
      return 'pass';
    case 'skipped':
    case 'other':
      return 'circle-slash';
  }
}

export async function openBuildLogExternally(
  target?: string | JobNode,
  openExternal: (uri: vscode.Uri) => Thenable<boolean> = (uri) => vscode.env.openExternal(uri),
): Promise<void> {
  const logUrl = typeof target === 'string' ? target : target?.logUrl;
  if (!logUrl) {
    return;
  }
  await openExternal(vscode.Uri.parse(logUrl));
}

export class BuildsTreeDataProvider
  implements vscode.TreeDataProvider<BuildsTreeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<BuildsTreeNode | undefined | void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly tracker: BuildsTrackerSource;
  private readonly openExternal: (uri: vscode.Uri) => Thenable<boolean>;

  readonly onDidChangeTreeData: vscode.Event<BuildsTreeNode | undefined | void> =
    this.emitter.event;

  constructor(
    tracker: BuildsTrackerSource,
    openExternal: (uri: vscode.Uri) => Thenable<boolean> = (uri) => vscode.env.openExternal(uri),
  ) {
    this.tracker = tracker;
    this.openExternal = openExternal;

    this.disposables.push(
      this.tracker.onDidChange(() => {
        this.refresh();
      }),
    );
  }

  refresh(): void {
    this.emitter.fire();
  }

  async openJobLog(target?: string | JobNode): Promise<void> {
    await openBuildLogExternally(target, this.openExternal);
  }

  getTreeItem(element: BuildsTreeNode): vscode.TreeItem {
    if (isPipelineNode(element)) {
      const item = new vscode.TreeItem(element.pipeline, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'zuulPipeline';
      return item;
    }

    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(getJobIconId(element.state));

    const description =
      element.result ??
      (element.durationMs !== undefined ? formatDuration(element.durationMs) : undefined);
    if (description !== undefined) {
      item.description = description;
    }

    item.contextValue = `zuulJob.${element.state}`;

    if (element.logUrl) {
      item.command = {
        command: OPEN_BUILD_LOG_COMMAND,
        title: 'Open Build Log',
        arguments: [element.logUrl],
      };
    }

    return item;
  }

  getChildren(element?: BuildsTreeNode): BuildsTreeNode[] {
    if (!element) {
      return buildTree(this.tracker.snapshot);
    }
    if (isPipelineNode(element)) {
      return element.jobs;
    }
    return [];
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.emitter.dispose();
  }
}
