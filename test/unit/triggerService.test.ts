import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type GheClient } from '../../src/clients/gheClient';
import { type PullRequest } from '../../src/clients/gheTypes';
import { type ZuulClient } from '../../src/clients/zuulClient';
import { type Build, type ChangeStatus } from '../../src/clients/zuulTypes';
import { type ResolvedContext } from '../../src/context/zuulContext';
import { type PrSnapshot, type ZuulContextSource } from '../../src/services/prTracker';
import {
  buildTriggerQuickPickItems,
  CONFIRM_POST_ACTION,
  formatTriggerConfirmationMessage,
  HAS_PR_CONTEXT_KEY,
  TIMEOUT_MESSAGE,
  TriggerService,
  type TriggerTrackerSource,
  WATCH_DURATION_MS,
} from '../../src/services/triggerService';
import { type Logger } from '../../src/util/logger';
import { commands, EventEmitter, window } from '../mocks/vscode';

function createFakeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 42,
    html_url: 'https://ghe.example.com/acme/service/pull/42',
    title: 'Add feature X',
    state: 'open',
    draft: false,
    merged: false,
    body: 'PR description',
    head: {
      sha: 'pr-head-sha-1',
      ref: 'feat/x',
      repo: { full_name: 'acme/service' },
    },
    base: {
      ref: 'main',
      repo: { full_name: 'acme/service' },
    },
    user: { login: 'alice' },
    labels: [],
    ...overrides,
  };
}

function makeStatus(overrides: Partial<ChangeStatus> = {}): ChangeStatus {
  return {
    pipeline: 'check',
    queue: 'shared',
    live: true,
    enqueueTime: 1_700_000_000_000,
    remainingTimeMs: 60_000,
    jobs: [{ name: 'unit-tests', uuid: 'job-uuid-1', running: true }],
    itemsAhead: [],
    ...overrides,
  };
}

function makeBuild(overrides: Partial<Build> = {}): Build {
  return {
    uuid: 'build-1',
    jobName: 'unit-tests',
    result: 'SUCCESS',
    pipeline: 'check',
    logUrl: 'https://logs.example.com/1/',
    artifacts: [],
    ...overrides,
  };
}

function createHarness(initialSnapshot?: PrSnapshot) {
  const postIssueComment = vi
    .fn<GheClient['postIssueComment']>()
    .mockResolvedValue({ id: 1, body: 'recheck' });
  const ghe = { postIssueComment } as unknown as GheClient;
  const zuul = {} as unknown as ZuulClient;

  let currentCtx: ResolvedContext | undefined = {
    repoRoot: '/workspace/service',
    host: 'ghe.example.com',
    owner: 'acme',
    repo: 'service',
    branch: 'feat/x',
    headSha: 'pr-head-sha-1',
    zuulUrl: 'https://zuul.example.com',
    tenant: 'main',
    project: 'acme/service',
    ghe,
    zuul,
  };
  const ctxEmitter = new EventEmitter<ResolvedContext | undefined>();
  const ctx: ZuulContextSource = {
    get current() {
      return currentCtx;
    },
    onDidChange: ctxEmitter.event,
  };

  let snapshot = initialSnapshot;
  const snapshotEmitter = new EventEmitter<PrSnapshot | undefined>();
  const watchFor = vi.fn<(ms: number) => void>();
  const tracker: TriggerTrackerSource = {
    get snapshot() {
      return snapshot;
    },
    onDidChange: snapshotEmitter.event,
    watchFor,
  };

  const emitSnapshot = (next: PrSnapshot | undefined): void => {
    snapshot = next;
    snapshotEmitter.fire(next);
  };

  const setContext = (next: ResolvedContext | undefined): void => {
    currentCtx = next;
    ctxEmitter.fire(next);
  };

  return {
    ctx,
    tracker,
    postIssueComment,
    watchFor,
    emitSnapshot,
    setContext,
  };
}

describe('TriggerService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.clearAllMocks();
    window.showWarningMessage.mockResolvedValue(CONFIRM_POST_ACTION);
    window.showInformationMessage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts comment after modal confirmation, starts 45s watch, and stops waiting on a new enqueueTime', async () => {
    const initialSnapshot: PrSnapshot = {
      pr: makePr(),
      statuses: [makeStatus({ enqueueTime: 1_700_000_000_000 })],
      builds: [],
      fetchedAt: 1_000_000,
    };
    const { ctx, tracker, postIssueComment, watchFor, emitSnapshot } =
      createHarness(initialSnapshot);
    const logger = createFakeLogger();
    const service = new TriggerService(ctx, tracker, logger, Date.now);

    const waitingEvents: boolean[] = [];
    service.onDidChangeWaiting((w) => waitingEvents.push(w));

    const posted = await service.post('recheck');

    expect(posted).toBe(true);
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      'Post "recheck" on acme/service#42?',
      { modal: true },
      CONFIRM_POST_ACTION,
    );
    expect(postIssueComment).toHaveBeenCalledWith('acme', 'service', 42, 'recheck');
    expect(watchFor).toHaveBeenCalledWith(WATCH_DURATION_MS);
    expect(service.waiting).toBe(true);
    expect(waitingEvents).toEqual([true]);

    // Snapshot with the same enqueueTime does not end waiting
    emitSnapshot({
      pr: makePr(),
      statuses: [makeStatus({ enqueueTime: 1_700_000_000_000 })],
      builds: [],
      fetchedAt: 1_003_000,
    });
    expect(service.waiting).toBe(true);

    // Snapshot with a new enqueueTime ends waiting and cancels the timeout
    emitSnapshot({
      pr: makePr(),
      statuses: [makeStatus({ enqueueTime: 1_700_000_005_000 })],
      builds: [],
      fetchedAt: 1_006_000,
    });
    expect(service.waiting).toBe(false);
    expect(waitingEvents).toEqual([true, false]);

    // Advancing past 45s should not show the timeout message
    await vi.advanceTimersByTimeAsync(WATCH_DURATION_MS);
    expect(window.showInformationMessage).not.toHaveBeenCalled();

    service.dispose();
  });

  it('stops waiting when a snapshot contains a new build UUID', async () => {
    const initialSnapshot: PrSnapshot = {
      pr: makePr(),
      statuses: [],
      builds: [makeBuild({ uuid: 'build-old' })],
      fetchedAt: 1_000_000,
    };
    const { ctx, tracker, emitSnapshot } = createHarness(initialSnapshot);
    const logger = createFakeLogger();
    const service = new TriggerService(ctx, tracker, logger, Date.now);

    const waitingEvents: boolean[] = [];
    service.onDidChangeWaiting((w) => waitingEvents.push(w));

    await service.post('recheck');
    expect(service.waiting).toBe(true);

    // Same build UUID -> still waiting
    emitSnapshot({
      pr: makePr(),
      statuses: [],
      builds: [makeBuild({ uuid: 'build-old' })],
      fetchedAt: 1_003_000,
    });
    expect(service.waiting).toBe(true);

    // New build UUID -> stops waiting
    emitSnapshot({
      pr: makePr(),
      statuses: [],
      builds: [makeBuild({ uuid: 'build-old' }), makeBuild({ uuid: 'build-new' })],
      fetchedAt: 1_006_000,
    });
    expect(service.waiting).toBe(false);
    expect(waitingEvents).toEqual([true, false]);

    await vi.advanceTimersByTimeAsync(WATCH_DURATION_MS);
    expect(window.showInformationMessage).not.toHaveBeenCalled();

    service.dispose();
  });

  it('stops waiting and shows info message after 45s timeout when Zuul has not picked up the comment', async () => {
    const initialSnapshot: PrSnapshot = {
      pr: makePr(),
      statuses: [],
      builds: [makeBuild({ uuid: 'build-1' })],
      fetchedAt: 1_000_000,
    };
    const { ctx, tracker, emitSnapshot } = createHarness(initialSnapshot);
    const logger = createFakeLogger();
    const service = new TriggerService(ctx, tracker, logger, Date.now);

    const waitingEvents: boolean[] = [];
    service.onDidChangeWaiting((w) => waitingEvents.push(w));

    await service.post('recheck');
    expect(service.waiting).toBe(true);

    // Before 45s, still waiting
    await vi.advanceTimersByTimeAsync(44_900);
    emitSnapshot({
      pr: makePr(),
      statuses: [],
      builds: [makeBuild({ uuid: 'build-1' })],
      fetchedAt: 1_044_900,
    });
    expect(service.waiting).toBe(true);
    expect(window.showInformationMessage).not.toHaveBeenCalled();

    // At 45s, timeout fires
    await vi.advanceTimersByTimeAsync(100);
    expect(service.waiting).toBe(false);
    expect(waitingEvents).toEqual([true, false]);
    expect(window.showInformationMessage).toHaveBeenCalledWith(TIMEOUT_MESSAGE);

    service.dispose();
  });

  it('does not post comment if user cancels modal confirmation', async () => {
    window.showWarningMessage.mockResolvedValue(undefined);
    const initialSnapshot: PrSnapshot = {
      pr: makePr(),
      statuses: [],
      builds: [],
      fetchedAt: 1_000_000,
    };
    const { ctx, tracker, postIssueComment, watchFor } = createHarness(initialSnapshot);
    const logger = createFakeLogger();
    const service = new TriggerService(ctx, tracker, logger, Date.now);

    const posted = await service.post('recheck');

    expect(posted).toBe(false);
    expect(postIssueComment).not.toHaveBeenCalled();
    expect(watchFor).not.toHaveBeenCalled();
    expect(service.waiting).toBe(false);

    service.dispose();
  });

  it('pickAndPostTrigger builds QuickPick items with $(icon) prefix and comment detail', async () => {
    const initialSnapshot: PrSnapshot = {
      pr: makePr(),
      statuses: [],
      builds: [],
      fetchedAt: 1_000_000,
    };
    const { ctx, tracker, postIssueComment } = createHarness(initialSnapshot);
    const logger = createFakeLogger();
    const service = new TriggerService(ctx, tracker, logger, Date.now);

    const items = buildTriggerQuickPickItems([
      { label: 'Recheck', comment: 'recheck', icon: 'refresh' },
      { label: 'Regate', comment: 'regate' },
    ]);
    expect(items).toEqual([
      { label: '$(refresh) Recheck', detail: 'recheck', comment: 'recheck' },
      { label: 'Regate', detail: 'regate', comment: 'regate' },
    ]);

    window.showQuickPick.mockResolvedValue(items[0]);

    const posted = await service.pickAndPostTrigger([
      { label: 'Recheck', comment: 'recheck', icon: 'refresh' },
      { label: 'Regate', comment: 'regate' },
    ]);

    expect(posted).toBe(true);
    expect(window.showQuickPick).toHaveBeenCalledWith(items, {
      placeHolder: 'Select a trigger comment to post',
    });
    expect(postIssueComment).toHaveBeenCalledWith('acme', 'service', 42, 'recheck');

    service.dispose();
  });

  it('promptAndPostCustomTrigger validates non-empty input and confirms before posting', async () => {
    const initialSnapshot: PrSnapshot = {
      pr: makePr(),
      statuses: [],
      builds: [],
      fetchedAt: 1_000_000,
    };
    const { ctx, tracker, postIssueComment } = createHarness(initialSnapshot);
    const logger = createFakeLogger();
    const service = new TriggerService(ctx, tracker, logger, Date.now);

    window.showInputBox.mockImplementation(
      async (opts?: { validateInput?: (v: string) => string | undefined }) => {
        expect(opts?.validateInput?.('   ')).toBeTruthy();
        expect(opts?.validateInput?.('recheck smoke')).toBeUndefined();
        return '  recheck smoke  ';
      },
    );

    const posted = await service.promptAndPostCustomTrigger();

    expect(posted).toBe(true);
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      formatTriggerConfirmationMessage('recheck smoke', 'acme', 'service', 42),
      { modal: true },
      CONFIRM_POST_ACTION,
    );
    expect(postIssueComment).toHaveBeenCalledWith('acme', 'service', 42, 'recheck smoke');

    service.dispose();
  });

  it('updates zuul.hasPr context key when snapshot changes', () => {
    const { ctx, tracker, emitSnapshot } = createHarness(undefined);
    const logger = createFakeLogger();
    const service = new TriggerService(ctx, tracker, logger, Date.now);

    expect(commands.executeCommand).toHaveBeenCalledWith('setContext', HAS_PR_CONTEXT_KEY, false);

    emitSnapshot({
      pr: makePr(),
      statuses: [],
      builds: [],
      fetchedAt: 1_000_000,
    });
    expect(commands.executeCommand).toHaveBeenLastCalledWith(
      'setContext',
      HAS_PR_CONTEXT_KEY,
      true,
    );

    emitSnapshot(undefined);
    expect(commands.executeCommand).toHaveBeenLastCalledWith(
      'setContext',
      HAS_PR_CONTEXT_KEY,
      false,
    );

    service.dispose();
  });

  it('stops waiting when a status job gets a new UUID and handles edge cases', async () => {
    const initialSnapshot: PrSnapshot = {
      pr: makePr(),
      statuses: [makeStatus({ enqueueTime: undefined })],
      builds: [],
      fetchedAt: 1_000_000,
    };
    const { ctx, tracker, postIssueComment, emitSnapshot, setContext } =
      createHarness(initialSnapshot);
    const logger = createFakeLogger();
    const service = new TriggerService(ctx, tracker, logger, Date.now);

    // Empty comment returns false
    expect(await service.post('   ')).toBe(false);

    // Post without modal confirmation and then re-post while already waiting (resets timer)
    expect(await service.post('recheck', { confirm: false })).toBe(true);
    expect(await service.post('recheck', { confirm: false })).toBe(true);
    expect(service.waiting).toBe(true);

    // Status job with new UUID stops waiting
    emitSnapshot({
      pr: makePr(),
      statuses: [
        makeStatus({
          enqueueTime: undefined,
          jobs: [{ name: 'unit-tests', uuid: 'job-uuid-2', running: true }],
        }),
      ],
      builds: [],
      fetchedAt: 1_003_000,
    });
    expect(service.waiting).toBe(false);

    // Cancelled QuickPick and InputBox return false
    window.showQuickPick.mockResolvedValueOnce(undefined);
    expect(
      await service.pickAndPostTrigger([
        { label: 'Recheck', comment: 'recheck', icon: '$(refresh)' },
      ]),
    ).toBe(false);
    window.showInputBox.mockResolvedValueOnce(undefined);
    expect(await service.promptAndPostCustomTrigger()).toBe(false);

    // Missing context returns false
    setContext(undefined);
    expect(await service.post('recheck')).toBe(false);
    expect(postIssueComment).toHaveBeenCalledTimes(2);

    service.dispose();
    expect(await service.post('recheck')).toBe(false);
    expect(await service.pickAndPostTrigger()).toBe(false);
    expect(await service.promptAndPostCustomTrigger()).toBe(false);
  });
});
