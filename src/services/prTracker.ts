import * as vscode from 'vscode';
import { type PullRequest } from '../clients/gheTypes';
import { type Build, type ChangeStatus } from '../clients/zuulTypes';
import { HttpError, NoTokenError } from '../clients/http';
import { RateLimitedError } from '../clients/rateLimit';
import { type ResolvedContext, type ZuulProblem } from '../context/zuulContext';
import { type Logger } from '../util/logger';
import { nextPollDelayMs, RETRY_DELAYS_MS } from './pollSchedule';

export interface ZuulUnavailable {
  kind: 'unavailable';
  reason: 'needs-token' | 'no-access' | 'unreachable';
  message: string;
  /** True once the poll has given up on Zuul, and when the context has no Zuul at all. */
  stopped: boolean;
}

export type ZuulAvailability = { kind: 'ok' } | ZuulUnavailable;

export interface PrSnapshot {
  pr: PullRequest;
  statuses: ChangeStatus[];
  builds: Build[];
  fetchedAt: number;
  zuul: ZuulAvailability;
}

function zuulUnavailable(err: unknown, stopped: boolean): ZuulUnavailable {
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof HttpError ? err.status : undefined;
  const reason = status === 401 ? 'needs-token' : status === 403 ? 'no-access' : 'unreachable';
  return { kind: 'unavailable', reason, message, stopped };
}

export type PollStatus =
  | { kind: 'active' }
  | { kind: 'retrying'; message: string }
  | { kind: 'no-pr' }
  | { kind: 'rate-limited'; until: number; message: string }
  | { kind: 'stopped'; reason: 'auth' | 'failed'; message: string };

export interface ZuulContextSource {
  readonly current: ResolvedContext | undefined;
  readonly zuulProblem?: ZuulProblem | undefined;
  readonly onDidChange: vscode.Event<ResolvedContext | undefined>;
}

export interface FocusEvents {
  readonly state: { readonly focused: boolean };
  readonly onDidChangeWindowState: vscode.Event<{ readonly focused: boolean }>;
}

export type SetTimerFn = (callback: () => void, ms: number) => unknown;
export type ClearTimerFn = (handle: unknown) => void;

export interface PrTrackerOptions {
  setTimer?: SetTimerFn;
  now?: () => number;
  focusEvents?: FocusEvents;
  clearTimer?: ClearTimerFn;
  getPollIntervalMs?: () => number;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;

export class PrTracker implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<PrSnapshot | undefined>();
  private readonly pollStatusEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly ctx: ZuulContextSource;
  private readonly logger: Logger;
  private readonly setTimer: SetTimerFn;
  private readonly clearTimer: ClearTimerFn;
  private readonly now: () => number;
  private readonly focusEvents: FocusEvents;
  private readonly getPollIntervalMs: () => number;

  private _snapshot: PrSnapshot | undefined;
  private _pollStatus: PollStatus = { kind: 'active' };
  private gheFailures = 0;
  private zuulFailures = 0;
  /** Set once Zuul has stopped: `poll` then skips Zuul and reuses this result. */
  private stoppedZuul: ZuulUnavailable | undefined;
  private currentPr: PullRequest | undefined;
  private fastUntil: number | undefined;
  private lastPollAt: number | undefined;
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
  readonly onDidChangePollStatus: vscode.Event<void> = this.pollStatusEmitter.event;

  constructor(ctx: ZuulContextSource, logger: Logger, options: PrTrackerOptions = {}) {
    this.getPollIntervalMs = options.getPollIntervalMs ?? (() => DEFAULT_POLL_INTERVAL_MS);
    this.ctx = ctx;
    this.logger = logger;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.now = options.now ?? Date.now;
    this.focusEvents = options.focusEvents ?? vscode.window;
    this.focused = this.focusEvents.state.focused;
    this.lastObservedStateFocused = this.focusEvents.state.focused;

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

  get pollStatus(): PollStatus {
    return this._pollStatus;
  }

  private setPollStatus(next: PollStatus): void {
    if (next.kind === this._pollStatus.kind && (next.kind === 'active' || next.kind === 'no-pr')) {
      return;
    }
    this._pollStatus = next;
    this.pollStatusEmitter.fire();
  }

  private resetPollState(): void {
    this.gheFailures = 0;
    this.zuulFailures = 0;
    this.stoppedZuul = undefined;
    // Without a branch there is nothing to poll, so say so instead of staying blank.
    this.setPollStatus(this.ctx.current?.branch ? { kind: 'active' } : { kind: 'no-pr' });
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
    this.resetPollState();
    await this.poll(this.sessionSeq);
  }

  /** Applies a changed poll interval now, instead of after the timer that is already waiting. */
  applyPollInterval(): void {
    this.handleFocusChange(this.isFocused());
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

    if (!this.ctx.current?.branch) {
      return;
    }
    const status = this._pollStatus.kind;
    if (status === 'stopped') {
      return;
    }
    if (status === 'rate-limited') {
      this.scheduleNext(this.sessionSeq);
      return;
    }
    const elapsed = this.lastPollAt === undefined ? Infinity : this.now() - this.lastPollAt;
    if (status === 'no-pr') {
      if (elapsed >= this.getPollIntervalMs()) {
        void this.poll(this.sessionSeq);
      }
      return;
    }
    const delay = this.currentDelayMs();
    if (elapsed >= delay) {
      void this.poll(this.sessionSeq);
    } else {
      this.scheduleNext(this.sessionSeq, delay - elapsed);
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
    this.lastPollAt = undefined;
    this.hasEmittedForContext = false;
    this.resetPollState();

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
      void this.poll(seq);
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

  /** The delay while polling is active: a retry delay after a failure, otherwise the schedule. */
  private currentDelayMs(): number {
    const failures = this.gheFailures || this.zuulFailures;
    if (failures > 0) {
      return RETRY_DELAYS_MS[failures - 1];
    }
    return nextPollDelayMs(this._snapshot, this.getPollIntervalMs(), this.fastUntil, this.now());
  }

  /** How long until the next poll, or `undefined` when polling has stopped. */
  private nextTimerDelayMs(): number | undefined {
    switch (this._pollStatus.kind) {
      case 'active':
      case 'retrying':
        return this.currentDelayMs();
      case 'rate-limited':
        return Math.max(0, this._pollStatus.until - this.now());
      default:
        return undefined;
    }
  }

  private scheduleNext(seq: number, delayOverride?: number): void {
    this.clearPendingTimer();
    if (
      this.disposed ||
      seq !== this.sessionSeq ||
      !this.isFocused() ||
      !this.ctx.current?.branch
    ) {
      return;
    }

    const delay = delayOverride ?? this.nextTimerDelayMs();
    if (delay === undefined) {
      return;
    }
    const token = this.timerSeq;
    this.timerHandle = this.setTimer(() => {
      if (this.disposed || token !== this.timerSeq || seq !== this.sessionSeq) {
        return;
      }
      this.timerHandle = undefined;
      if (!this.isFocused()) {
        return;
      }
      void this.poll(seq);
    }, delay);
  }

  private async poll(seq: number): Promise<void> {
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
      this.lastPollAt = this.now();
      this.logger.info(
        `[Poll] Polling open PR for branch="${currentCtx.branch}" on ${currentCtx.owner}/${currentCtx.repo}`,
      );
      const pr = await currentCtx.ghe.findOpenPrForBranch(
        currentCtx.owner,
        currentCtx.repo,
        currentCtx.branch,
      );
      if (this.disposed || seq !== this.sessionSeq || pollRunId !== this.pollRunSeq) {
        return;
      }
      this.currentPr = pr;
      this.gheFailures = 0;

      if (!pr) {
        this.logger.info(
          `[Poll] No open PR found for branch="${currentCtx.branch}" on ${currentCtx.owner}/${currentCtx.repo}`,
        );
        this.setPollStatus({ kind: 'no-pr' });
        this.updateSnapshot(undefined);
        return;
      }

      let statuses: ChangeStatus[] = [];
      let builds: Build[] = [];
      let zuulState: ZuulAvailability = { kind: 'ok' };
      const zuul = currentCtx.zuul;
      if (!zuul) {
        zuulState =
          this.ctx.zuulProblem === 'zuul-auth'
            ? {
                kind: 'unavailable',
                reason: 'needs-token',
                message: 'Zuul did not accept the token',
                stopped: true,
              }
            : {
                kind: 'unavailable',
                reason: 'unreachable',
                message: 'Zuul could not be reached',
                stopped: true,
              };
      } else if (this.stoppedZuul) {
        zuulState = this.stoppedZuul;
      } else {
        try {
          this.logger.info(
            `[Poll] Fetching change status for PR #${pr.number} (head=${pr.head.sha}) on tenant="${zuul.tenant}"`,
          );
          statuses = await zuul.client.getChangeStatus(zuul.tenant, pr.number, pr.head.sha);
          if (this.disposed || seq !== this.sessionSeq || pollRunId !== this.pollRunSeq) {
            return;
          }

          if (statuses.every((s) => !s.live)) {
            this.logger.info(
              `[Poll] No live pipeline for PR #${pr.number}; fetching completed builds for project="${currentCtx.project}" change=${pr.number} patchset=${pr.head.sha}`,
            );
            builds = await zuul.client.listBuilds(zuul.tenant, {
              project: currentCtx.project,
              change: pr.number,
              patchset: pr.head.sha,
            });
            if (this.disposed || seq !== this.sessionSeq || pollRunId !== this.pollRunSeq) {
              return;
            }
          }
          this.zuulFailures = 0;
        } catch (zuulErr) {
          if (this.disposed || seq !== this.sessionSeq || pollRunId !== this.pollRunSeq) {
            return;
          }
          this.logger.warn(
            `[Poll] Zuul is unavailable for PR #${pr.number}: ${zuulErr instanceof Error ? zuulErr.message : String(zuulErr)}`,
          );
          statuses = [];
          builds = [];
          zuulState = this.recordZuulFailure(zuulErr);
        }
      }

      const snapshot: PrSnapshot = {
        pr,
        statuses,
        builds,
        fetchedAt: this.now(),
        zuul: zuulState,
      };
      this.setPollStatus({ kind: 'active' });
      this.updateSnapshot(snapshot, true);
    } catch (err) {
      if (this.disposed || seq !== this.sessionSeq || pollRunId !== this.pollRunSeq) {
        return;
      }
      this.logger.error(
        `[Poll] Failed to poll PR status for branch="${currentCtx.branch}" on ${currentCtx.owner}/${currentCtx.repo} (PR #${this.currentPr?.number ?? 'none'})`,
        err,
      );
      this.recordGitHubFailure(err);
    } finally {
      if (!this.disposed && seq === this.sessionSeq && pollRunId === this.pollRunSeq) {
        this.polling = false;
        this.scheduleNext(seq);
      }
    }
  }

  private recordGitHubFailure(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RateLimitedError) {
      // Never sooner than the first retry, so `Retry-After: 0` or a past reset time can't loop.
      const until = Math.max(err.retryAt, this.now() + RETRY_DELAYS_MS[0]);
      this.setPollStatus({ kind: 'rate-limited', until, message });
      return;
    }
    // Reading a token can fail briefly (a slow `gh`), so that is retried. A refused token isn't.
    const noToken = err instanceof NoTokenError;
    if (!noToken && err instanceof HttpError && [401, 403, 404].includes(err.status)) {
      this.setPollStatus({ kind: 'stopped', reason: 'auth', message });
      return;
    }
    this.gheFailures += 1;
    if (this.gheFailures > RETRY_DELAYS_MS.length) {
      this.setPollStatus({ kind: 'stopped', reason: noToken ? 'auth' : 'failed', message });
      return;
    }
    this.setPollStatus({ kind: 'retrying', message });
  }

  private recordZuulFailure(err: unknown): ZuulUnavailable {
    const status = err instanceof HttpError ? err.status : undefined;
    const refused = status === 401 || status === 403;
    if (!refused) {
      this.zuulFailures += 1;
    }
    const stopped = refused || this.zuulFailures > RETRY_DELAYS_MS.length;
    const state = zuulUnavailable(err, stopped);
    if (stopped) {
      this.stoppedZuul = state;
      this.zuulFailures = 0;
    }
    return state;
  }

  dispose(): void {
    this.disposed = true;
    this.clearPendingTimer();
    for (const sub of this.disposables) {
      sub.dispose();
    }
    this.disposables.length = 0;
    this.emitter.dispose();
    this.pollStatusEmitter.dispose();
  }
}
