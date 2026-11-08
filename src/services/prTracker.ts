import * as vscode from 'vscode';
import { type PullRequest } from '../clients/gheTypes';
import { type Build, type ChangeStatus } from '../clients/zuulTypes';
import { HttpError } from '../clients/http';
import { type ResolvedContext, type ZuulProblem } from '../context/zuulContext';
import { type Logger } from '../util/logger';
import { nextPollDelayMs } from './pollSchedule';

export type ZuulAvailability =
  | { kind: 'ok' }
  | { kind: 'unavailable'; reason: 'needs-token' | 'no-access' | 'unreachable'; message: string };

export interface PrSnapshot {
  pr: PullRequest;
  statuses: ChangeStatus[];
  builds: Build[];
  fetchedAt: number;
  zuul: ZuulAvailability;
}

function zuulUnavailable(err: unknown): ZuulAvailability {
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof HttpError ? err.status : undefined;
  const reason = status === 401 ? 'needs-token' : status === 403 ? 'no-access' : 'unreachable';
  return { kind: 'unavailable', reason, message };
}

export interface PollError {
  message: string;
  at: number;
  lastSuccessAt?: number;
}

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
  private readonly pollErrorEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly ctx: ZuulContextSource;
  private readonly logger: Logger;
  private readonly setTimer: SetTimerFn;
  private readonly clearTimer: ClearTimerFn;
  private readonly now: () => number;
  private readonly focusEvents: FocusEvents;
  private readonly getPollIntervalMs: () => number;

  private _snapshot: PrSnapshot | undefined;
  private _pollError: PollError | undefined;
  private lastSuccessAt: number | undefined;
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
  readonly onDidChangePollError: vscode.Event<void> = this.pollErrorEmitter.event;

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
    await this.poll(this.sessionSeq);
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
    const delay = this.currentDelayMs();
    const elapsed = this.lastPollAt === undefined ? Infinity : this.now() - this.lastPollAt;
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

  private currentDelayMs(): number {
    return nextPollDelayMs(this._snapshot, this.getPollIntervalMs(), this.fastUntil, this.now());
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

    const delay = delayOverride ?? this.currentDelayMs();
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

      if (!pr) {
        this.logger.info(
          `[Poll] No open PR found for branch="${currentCtx.branch}" on ${currentCtx.owner}/${currentCtx.repo}`,
        );
        this.lastSuccessAt = this.now();
        this.setPollError(undefined);
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
              }
            : {
                kind: 'unavailable',
                reason: 'unreachable',
                message: 'Zuul could not be reached',
              };
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
        } catch (zuulErr) {
          if (this.disposed || seq !== this.sessionSeq || pollRunId !== this.pollRunSeq) {
            return;
          }
          this.logger.warn(
            `[Poll] Zuul is unavailable for PR #${pr.number}: ${zuulErr instanceof Error ? zuulErr.message : String(zuulErr)}`,
          );
          statuses = [];
          builds = [];
          zuulState = zuulUnavailable(zuulErr);
        }
      }

      const snapshot: PrSnapshot = {
        pr,
        statuses,
        builds,
        fetchedAt: this.now(),
        zuul: zuulState,
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
