import * as vscode from 'vscode';
import { type PullRequest } from '../clients/gheTypes';
import { type Build, type ChangeStatus } from '../clients/zuulTypes';
import { type ResolvedContext } from '../context/zuulContext';
import { type Logger } from '../util/logger';
import { nextPollDelayMs } from './pollSchedule';

export interface PrSnapshot {
  pr: PullRequest;
  statuses: ChangeStatus[];
  builds: Build[];
  fetchedAt: number;
}

export interface PollError {
  message: string;
  at: number;
  lastSuccessAt?: number;
}

export interface ZuulContextSource {
  readonly current: ResolvedContext | undefined;
  readonly onDidChange: vscode.Event<ResolvedContext | undefined>;
}

export interface FocusEvents {
  readonly state: { readonly focused: boolean };
  readonly onDidChangeWindowState: vscode.Event<{ readonly focused: boolean }>;
}

export type SetTimerFn = (callback: () => void, ms: number) => unknown;
export type ClearTimerFn = (handle: unknown) => void;

const PR_REFETCH_INTERVAL_TICKS = 4;

export class PrTracker implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<PrSnapshot | undefined>();
  private readonly pollErrorEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly ctx: ZuulContextSource;
  private readonly logger: Logger;
  private readonly setTimer: SetTimerFn;
  private readonly clearTimer: ClearTimerFn;
  private readonly now: () => number;
  private readonly focusEvents: FocusEvents;

  private _snapshot: PrSnapshot | undefined;
  private _pollError: PollError | undefined;
  private lastSuccessAt: number | undefined;
  private currentPr: PullRequest | undefined;
  private fastUntil: number | undefined;
  private pollCount = 0;
  private sessionSeq = 0;
  private pollRunSeq = 0;
  private timerSeq = 0;
  private timerHandle: unknown;
  private polling = false;
  private focused: boolean;
  private lastObservedStateFocused: boolean;
  private hasEmittedForContext = false;
  private lastContextKey: string | undefined;
  private disposed = false;

  readonly onDidChange: vscode.Event<PrSnapshot | undefined> = this.emitter.event;
  readonly onDidChangePollError: vscode.Event<void> = this.pollErrorEmitter.event;

  constructor(
    ctx: ZuulContextSource,
    logger: Logger,
    setTimer: SetTimerFn = setTimeout,
    now: () => number = Date.now,
    focusEvents: FocusEvents = vscode.window,
    clearTimer: ClearTimerFn = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  ) {
    this.ctx = ctx;
    this.logger = logger;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.focusEvents = focusEvents;
    this.focused = focusEvents.state.focused;
    this.lastObservedStateFocused = focusEvents.state.focused;

    this.disposables.push(
      this.ctx.onDidChange(() => {
        this.handleContextChange();
      }),
      this.focusEvents.onDidChangeWindowState((state) => {
        this.handleFocusChange(state.focused);
      }),
    );

    if (this.ctx.current) {
      this.handleContextChange();
    }
  }

  get snapshot(): PrSnapshot | undefined {
    return this._snapshot;
  }

  get pollError(): PollError | undefined {
    return this._pollError;
  }

  private setPollError(next: PollError | undefined): void {
    if (next === undefined && this._pollError === undefined) {
      return;
    }
    this._pollError = next;
    this.pollErrorEmitter.fire();
  }

  watchFor(ms: number): void {
    if (this.disposed) {
      return;
    }
    this.fastUntil = this.now() + ms;
    if (!this.polling && this.isFocused() && this.ctx.current?.branch) {
      this.scheduleNext(this.sessionSeq);
    }
  }

  async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.clearPendingTimer();
    this.pollCount = 0;
    await this.poll(this.sessionSeq, true);
  }

  private isFocused(): boolean {
    if (this.focusEvents.state.focused !== this.lastObservedStateFocused) {
      this.lastObservedStateFocused = this.focusEvents.state.focused;
      this.focused = this.focusEvents.state.focused;
    }
    return this.focused;
  }

  private handleFocusChange(focused: boolean): void {
    if (this.disposed) {
      return;
    }
    this.focused = focused;
    this.lastObservedStateFocused = this.focusEvents.state.focused;

    if (!focused) {
      this.clearPendingTimer();
      return;
    }

    if (this.ctx.current?.branch) {
      void this.refresh();
    }
  }

  private handleContextChange(): void {
    if (this.disposed) {
      return;
    }
    this.clearPendingTimer();
    const seq = ++this.sessionSeq;
    this.pollRunSeq += 1;
    this.polling = false;
    this.currentPr = undefined;
    this.pollCount = 0;
    this.hasEmittedForContext = false;
    this.lastSuccessAt = undefined;
    this.setPollError(undefined);

    const currentCtx = this.ctx.current;
    const contextKey = currentCtx
      ? [currentCtx.host, currentCtx.owner, currentCtx.repo, currentCtx.branch].join('\n')
      : undefined;
    const contextChanged = contextKey !== this.lastContextKey;
    this.lastContextKey = contextKey;

    if (!currentCtx?.branch) {
      this.updateSnapshot(undefined, true);
      return;
    }

    if (contextChanged && this._snapshot !== undefined) {
      // Never show the old branch's pull request while the new one loads.
      this.updateSnapshot(undefined, true);
    }

    if (this.isFocused()) {
      void this.poll(seq, true);
    }
  }

  private updateSnapshot(next: PrSnapshot | undefined, forceEmit = false): void {
    const shouldEmit =
      forceEmit || next !== undefined || this._snapshot !== undefined || !this.hasEmittedForContext;
    this._snapshot = next;
    if (shouldEmit) {
      this.hasEmittedForContext = true;
      this.emitter.fire(next);
    }
  }

  private clearPendingTimer(): void {
    this.timerSeq += 1;
    if (this.timerHandle !== undefined) {
      const handle = this.timerHandle;
      this.timerHandle = undefined;
      this.clearTimer(handle);
    }
  }

  private scheduleNext(seq: number): void {
    this.clearPendingTimer();
    if (
      this.disposed ||
      seq !== this.sessionSeq ||
      !this.isFocused() ||
      !this.ctx.current?.branch
    ) {
      return;
    }

    const delay = nextPollDelayMs(this._snapshot, this.fastUntil, this.now());
    const token = this.timerSeq;
    this.timerHandle = this.setTimer(() => {
      if (this.disposed || token !== this.timerSeq || seq !== this.sessionSeq) {
        return;
      }
      this.timerHandle = undefined;
      if (!this.isFocused()) {
        return;
      }
      void this.poll(seq, false);
    }, delay);
  }

  private async poll(seq: number, forcePrFetch: boolean): Promise<void> {
    this.clearPendingTimer();
    if (this.disposed || seq !== this.sessionSeq) {
      return;
    }

    const currentCtx = this.ctx.current;
    if (!currentCtx?.branch) {
      this.updateSnapshot(undefined);
      return;
    }

    const pollRunId = ++this.pollRunSeq;
    this.polling = true;

    try {
      const tickIndex = this.pollCount++;
      const shouldFetchPr =
        forcePrFetch || !this.currentPr || tickIndex % PR_REFETCH_INTERVAL_TICKS === 0;

      let pr = this.currentPr;
      if (shouldFetchPr) {
        this.logger.info(
          `[Poll] Polling open PR for branch="${currentCtx.branch}" on ${currentCtx.owner}/${currentCtx.repo}`,
        );
        pr = await currentCtx.ghe.findOpenPrForBranch(
          currentCtx.owner,
          currentCtx.repo,
          currentCtx.branch,
        );
        if (this.disposed || seq !== this.sessionSeq || pollRunId !== this.pollRunSeq) {
          return;
        }
        this.currentPr = pr;
      }

      if (!pr) {
        this.logger.info(
          `[Poll] No open PR found for branch="${currentCtx.branch}" on ${currentCtx.owner}/${currentCtx.repo}`,
        );
        this.lastSuccessAt = this.now();
        this.setPollError(undefined);
        this.updateSnapshot(undefined);
        return;
      }

      this.logger.info(
        `[Poll] Fetching change status for PR #${pr.number} (head=${pr.head.sha}) on tenant="${currentCtx.tenant}"`,
      );
      const statuses = await currentCtx.zuul.getChangeStatus(
        currentCtx.tenant,
        pr.number,
        pr.head.sha,
      );
      if (this.disposed || seq !== this.sessionSeq || pollRunId !== this.pollRunSeq) {
        return;
      }

      let builds: Build[] = [];
      if (statuses.every((s) => !s.live)) {
        this.logger.info(
          `[Poll] No live pipeline for PR #${pr.number}; fetching completed builds for project="${currentCtx.project}" change=${pr.number} patchset=${pr.head.sha}`,
        );
        builds = await currentCtx.zuul.listBuilds(currentCtx.tenant, {
          project: currentCtx.project,
          change: pr.number,
          patchset: pr.head.sha,
        });
        if (this.disposed || seq !== this.sessionSeq || pollRunId !== this.pollRunSeq) {
          return;
        }
      }

      const snapshot: PrSnapshot = {
        pr,
        statuses,
        builds,
        fetchedAt: this.now(),
      };
      this.lastSuccessAt = this.now();
      this.setPollError(undefined);
      this.updateSnapshot(snapshot, true);
    } catch (err) {
      if (this.disposed || seq !== this.sessionSeq || pollRunId !== this.pollRunSeq) {
        return;
      }
      this.logger.error(
        `[Poll] Failed to poll PR status for branch="${currentCtx.branch}" on ${currentCtx.owner}/${currentCtx.repo} (PR #${this.currentPr?.number ?? 'none'})`,
        err,
      );
      this.setPollError({
        message: err instanceof Error ? err.message : String(err),
        at: this.now(),
        ...(this.lastSuccessAt !== undefined ? { lastSuccessAt: this.lastSuccessAt } : {}),
      });
    } finally {
      if (!this.disposed && seq === this.sessionSeq && pollRunId === this.pollRunSeq) {
        this.polling = false;
        this.scheduleNext(seq);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearPendingTimer();
    for (const sub of this.disposables) {
      sub.dispose();
    }
    this.disposables.length = 0;
    this.emitter.dispose();
    this.pollErrorEmitter.dispose();
  }
}
