import * as vscode from 'vscode';
import { readWorkspaceSettings, type TriggerComment } from '../config/settings';
import { type Logger } from '../util/logger';
import { type PrSnapshot, type ZuulContextSource } from './prTracker';

export const WATCH_DURATION_MS = 45_000;
export const TIMEOUT_MESSAGE = 'Zuul has not picked up the comment yet.';
export const CONFIRM_POST_ACTION = 'Post';
export const HAS_PR_CONTEXT_KEY = 'zuul.hasPr';

export interface TriggerTrackerSource {
  readonly snapshot: PrSnapshot | undefined;
  readonly onDidChange: vscode.Event<PrSnapshot | undefined>;
  watchFor(ms: number): void;
}

export interface TriggerQuickPickItem extends vscode.QuickPickItem {
  readonly label: string;
  readonly detail: string;
  readonly comment: string;
}

export interface PostTriggerOptions {
  confirm?: boolean;
}

export function formatTriggerConfirmationMessage(
  comment: string,
  owner: string,
  repo: string,
  prNumber: number,
): string {
  return `Post "${comment}" on ${owner}/${repo}#${prNumber}?`;
}

export function buildTriggerQuickPickItems(
  comments: readonly TriggerComment[],
): TriggerQuickPickItem[] {
  return comments.map((item) => {
    const icon = item.icon?.trim();
    const prefix = icon ? (icon.startsWith('$(') ? `${icon} ` : `$(${icon}) `) : '';
    return {
      label: `${prefix}${item.label}`,
      detail: item.comment,
      comment: item.comment,
    };
  });
}

export class TriggerService implements vscode.Disposable {
  private readonly waitingEmitter = new vscode.EventEmitter<boolean>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly ctx: ZuulContextSource;
  private readonly tracker: TriggerTrackerSource;
  private readonly logger: Logger;
  private readonly now: () => number;

  private _waiting = false;
  private knownEnqueueTimes = new Set<number>();
  private knownBuildUuids = new Set<string>();
  private watchDeadline: number | undefined;
  private timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  readonly onDidChangeWaiting: vscode.Event<boolean> = this.waitingEmitter.event;

  constructor(
    ctx: ZuulContextSource,
    tracker: TriggerTrackerSource,
    logger: Logger,
    now: () => number = Date.now,
  ) {
    this.ctx = ctx;
    this.tracker = tracker;
    this.logger = logger;
    this.now = now;

    this.updateHasPrContext(this.tracker.snapshot);

    this.disposables.push(
      this.tracker.onDidChange((snapshot) => {
        this.handleSnapshotChange(snapshot);
      }),
    );
  }

  get waiting(): boolean {
    return this._waiting;
  }

  async post(comment: string, options?: PostTriggerOptions): Promise<boolean> {
    if (this.disposed) {
      return false;
    }

    const trimmed = comment.trim();
    if (!trimmed) {
      return false;
    }

    const currentCtx = this.ctx.current;
    const snapshot = this.tracker.snapshot;
    if (!currentCtx || !snapshot) {
      this.logger.warn('[Zuul] Cannot post trigger comment: no active pull request');
      return false;
    }

    const { owner, repo, ghe } = currentCtx;
    const prNumber = snapshot.pr.number;

    if (options?.confirm !== false) {
      const message = formatTriggerConfirmationMessage(trimmed, owner, repo, prNumber);
      const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        CONFIRM_POST_ACTION,
      );
      if (choice !== CONFIRM_POST_ACTION || this.disposed) {
        return false;
      }
    }

    await ghe.postIssueComment(owner, repo, prNumber, trimmed);
    if (this.disposed) {
      return false;
    }

    this.logger.info(`[Zuul] Posted trigger comment "${trimmed}" on ${owner}/${repo}#${prNumber}`);

    this.rememberBaseline(this.tracker.snapshot ?? snapshot);
    this.watchDeadline = this.now() + WATCH_DURATION_MS;
    this.tracker.watchFor(WATCH_DURATION_MS);
    this.setWaiting(true);
    this.scheduleTimeout();

    return true;
  }

  async pickAndPostTrigger(triggerComments?: readonly TriggerComment[]): Promise<boolean> {
    if (this.disposed) {
      return false;
    }

    const comments = triggerComments ?? readWorkspaceSettings().triggerComments;
    const items = buildTriggerQuickPickItems(comments);
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a trigger comment to post',
    });
    if (!picked) {
      return false;
    }

    const comment = (picked as Partial<TriggerQuickPickItem>).comment ?? picked.detail;
    if (!comment) {
      return false;
    }

    return this.post(comment);
  }

  async promptAndPostCustomTrigger(): Promise<boolean> {
    if (this.disposed) {
      return false;
    }

    const input = await vscode.window.showInputBox({
      prompt: 'Enter trigger comment to post',
      placeHolder: 'recheck',
      validateInput: (value: string) =>
        value.trim().length === 0 ? 'Trigger comment cannot be empty' : undefined,
    });
    const trimmed = input?.trim();
    if (!trimmed) {
      return false;
    }

    return this.post(trimmed);
  }

  private updateHasPrContext(snapshot: PrSnapshot | undefined): void {
    void vscode.commands.executeCommand('setContext', HAS_PR_CONTEXT_KEY, snapshot !== undefined);
  }

  private rememberBaseline(snapshot: PrSnapshot | undefined): void {
    this.knownEnqueueTimes = new Set<number>();
    this.knownBuildUuids = new Set<string>();
    if (!snapshot) {
      return;
    }

    for (const status of snapshot.statuses) {
      if (status.enqueueTime !== undefined) {
        this.knownEnqueueTimes.add(status.enqueueTime);
      }
      for (const job of status.jobs) {
        if (job.uuid) {
          this.knownBuildUuids.add(job.uuid);
        }
      }
    }

    for (const build of snapshot.builds) {
      if (build.uuid) {
        this.knownBuildUuids.add(build.uuid);
      }
    }
  }

  private hasNewActivity(snapshot: PrSnapshot | undefined): boolean {
    if (!snapshot) {
      return false;
    }

    for (const status of snapshot.statuses) {
      if (status.enqueueTime !== undefined && !this.knownEnqueueTimes.has(status.enqueueTime)) {
        return true;
      }
      for (const job of status.jobs) {
        if (job.uuid && !this.knownBuildUuids.has(job.uuid)) {
          return true;
        }
      }
    }

    for (const build of snapshot.builds) {
      if (build.uuid && !this.knownBuildUuids.has(build.uuid)) {
        return true;
      }
    }

    return false;
  }

  private handleSnapshotChange(snapshot: PrSnapshot | undefined): void {
    this.updateHasPrContext(snapshot);

    if (!this._waiting || this.disposed) {
      return;
    }

    if (this.hasNewActivity(snapshot)) {
      this.logger.info('[Zuul] Detected Zuul activity after trigger comment');
      this.stopWaiting();
      return;
    }

    if (this.watchDeadline !== undefined && this.now() >= this.watchDeadline) {
      this.handleWatchTimeout();
    }
  }

  private scheduleTimeout(): void {
    this.clearTimeoutTimer();
    this.timeoutHandle = setTimeout(() => {
      this.timeoutHandle = undefined;
      this.handleWatchTimeout();
    }, WATCH_DURATION_MS);
  }

  private clearTimeoutTimer(): void {
    if (this.timeoutHandle !== undefined) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }

  private handleWatchTimeout(): void {
    if (!this._waiting || this.disposed) {
      return;
    }
    this.stopWaiting();
    this.logger.info('[Zuul] Trigger comment watch timed out after 45s');
    void vscode.window.showInformationMessage(TIMEOUT_MESSAGE);
  }

  private stopWaiting(): void {
    this.clearTimeoutTimer();
    this.watchDeadline = undefined;
    this.knownEnqueueTimes.clear();
    this.knownBuildUuids.clear();
    this.setWaiting(false);
  }

  private setWaiting(next: boolean): void {
    const changed = this._waiting !== next;
    this._waiting = next;
    if (changed) {
      this.waitingEmitter.fire(next);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimeoutTimer();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.waitingEmitter.dispose();
  }
}
