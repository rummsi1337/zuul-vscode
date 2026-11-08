import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type GheClient } from '../../src/clients/gheClient';
import { HttpError } from '../../src/clients/http';
import { type PullRequest } from '../../src/clients/gheTypes';
import { RateLimitGuard, RateLimitedError } from '../../src/clients/rateLimit';
import { ZuulClient } from '../../src/clients/zuulClient';
import { type Build, type ChangeStatus } from '../../src/clients/zuulTypes';
import { type ResolvedContext } from '../../src/context/zuulContext';
import {
  type FocusEvents,
  type PrSnapshot,
  PrTracker,
  type ZuulContextSource,
} from '../../src/services/prTracker';
import { createFakeLogger, makePr, makeResolvedContext as makeBaseContext } from '../helpers';
import { EventEmitter } from '../mocks/vscode';

function makeStatus(overrides: Partial<ChangeStatus> = {}): ChangeStatus {
  return {
    pipeline: 'check',
    queue: 'shared',
    live: true,
    enqueueTime: 1_700_000_000_000,
    remainingTimeMs: 60_000,
    jobs: [{ name: 'unit-tests', running: true }],
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

function createFakeContextSource(initial?: ResolvedContext): {
  source: ZuulContextSource;
  setContext: (ctx: ResolvedContext | undefined) => void;
} {
  let current = initial;
  const emitter = new EventEmitter<ResolvedContext | undefined>();
  return {
    source: {
      get current() {
        return current;
      },
      onDidChange: emitter.event,
    },
    setContext: (ctx) => {
      current = ctx;
      emitter.fire(ctx);
    },
  };
}

function createFakeFocusEvents(initialFocused = true): {
  focusEvents: FocusEvents;
  setFocused: (focused: boolean) => void;
} {
  const state = { focused: initialFocused };
  const emitter = new EventEmitter<{ readonly focused: boolean }>();
  return {
    focusEvents: {
      state,
      onDidChangeWindowState: emitter.event,
    },
    setFocused: (focused: boolean) => {
      state.focused = focused;
      emitter.fire({ focused });
    },
  };
}

function createMockClients() {
  const findOpenPrForBranch = vi.fn<GheClient['findOpenPrForBranch']>();
  const getChangeStatus = vi.fn<ZuulClient['getChangeStatus']>();
  const listBuilds = vi.fn<ZuulClient['listBuilds']>();

  const ghe = {
    findOpenPrForBranch,
  } as unknown as GheClient;

  const zuul = {
    getChangeStatus,
    listBuilds,
  } as unknown as ZuulClient;

  const makeResolvedContext = (overrides: Partial<ResolvedContext> = {}): ResolvedContext =>
    makeBaseContext({
      ghe,
      zuul: { url: 'https://zuul.example.com', tenant: 'main', client: zuul },
      ...overrides,
    });

  return {
    findOpenPrForBranch,
    getChangeStatus,
    listBuilds,
    ghe,
    zuul,
    makeResolvedContext,
  };
}

describe('PrTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses PR head SHA from GHE (not local HEAD) and polls at the interval when a status is live', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    const pr = makePr({
      head: {
        sha: 'remote-ghe-sha-999',
        ref: 'feat/x',
        repo: { full_name: 'acme/service' },
      },
    });
    const status = makeStatus();

    findOpenPrForBranch.mockResolvedValue(pr);
    getChangeStatus.mockResolvedValue([status]);
    listBuilds.mockResolvedValue([]);

    const ctx = makeResolvedContext({ headSha: 'local-unpushed-sha-000' });
    const { source } = createFakeContextSource(ctx);
    const { focusEvents } = createFakeFocusEvents(true);
    const logger = createFakeLogger();
    const snapshots: (PrSnapshot | undefined)[] = [];

    const tracker = new PrTracker(source, logger, {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });
    tracker.onDidChange((s) => snapshots.push(s));

    await vi.advanceTimersByTimeAsync(0);

    expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);
    expect(findOpenPrForBranch).toHaveBeenCalledWith('acme', 'service', 'feat/x');
    expect(getChangeStatus).toHaveBeenCalledTimes(1);
    expect(getChangeStatus).toHaveBeenCalledWith('main', 42, 'remote-ghe-sha-999');
    expect(listBuilds).not.toHaveBeenCalled();
    expect(tracker.snapshot).toEqual({
      pr,
      statuses: [status],
      builds: [],
      fetchedAt: 1_000_000,
      zuul: { kind: 'ok' },
    });
    expect(snapshots).toHaveLength(1);

    // Should not poll at 59.9s, should poll at 60s
    await vi.advanceTimersByTimeAsync(59_900);
    expect(getChangeStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(getChangeStatus).toHaveBeenCalledTimes(2);
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);

    tracker.dispose();
  });

  it('still makes a snapshot, without calling Zuul, when the context has no Zuul', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    const pr = makePr();
    findOpenPrForBranch.mockResolvedValue(pr);

    const { source } = createFakeContextSource(makeResolvedContext({ zuul: undefined }));
    const { focusEvents } = createFakeFocusEvents(true);
    const tracker = new PrTracker(source, createFakeLogger(), {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(getChangeStatus).not.toHaveBeenCalled();
    expect(listBuilds).not.toHaveBeenCalled();
    expect(tracker.snapshot).toEqual({
      pr,
      statuses: [],
      builds: [],
      fetchedAt: 1_000_000,
      zuul: {
        kind: 'unavailable',
        reason: 'unreachable',
        message: 'Zuul could not be reached',
        stopped: true,
      },
    });
    tracker.dispose();
  });

  it.each([
    [401, 'needs-token'],
    [403, 'no-access'],
    [500, 'unreachable'],
  ] as const)(
    'still makes a snapshot with empty Zuul data when Zuul answers %i',
    async (status, reason) => {
      const { findOpenPrForBranch, getChangeStatus, makeResolvedContext } = createMockClients();
      const pr = makePr();
      findOpenPrForBranch.mockResolvedValue(pr);
      getChangeStatus.mockRejectedValue(new HttpError(status, 'nope'));

      const { source } = createFakeContextSource(makeResolvedContext());
      const { focusEvents } = createFakeFocusEvents(true);
      const logger = createFakeLogger();
      const tracker = new PrTracker(source, logger, {
        setTimer: setTimeout,
        now: Date.now,
        focusEvents,
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(tracker.snapshot).toMatchObject({
        pr,
        statuses: [],
        builds: [],
        zuul: { kind: 'unavailable', reason },
      });
      expect(tracker.pollStatus).toEqual({ kind: 'active' });
      expect(logger.errors).toHaveLength(0);
      tracker.dispose();
    },
  );

  it('falls back to listBuilds when every status is non-live', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    findOpenPrForBranch.mockResolvedValue(makePr());
    getChangeStatus.mockResolvedValue([makeStatus({ live: false, jobs: [] })]);
    listBuilds.mockResolvedValue([makeBuild()]);

    const { source } = createFakeContextSource(makeResolvedContext());
    const { focusEvents } = createFakeFocusEvents(true);
    const tracker = new PrTracker(source, createFakeLogger(), {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(listBuilds).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });

  it('skips listBuilds when one status is live among non-live ones', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    findOpenPrForBranch.mockResolvedValue(makePr());
    getChangeStatus.mockResolvedValue([
      makeStatus({ live: false, jobs: [] }),
      makeStatus({ live: true }),
    ]);
    listBuilds.mockResolvedValue([]);

    const { source } = createFakeContextSource(makeResolvedContext());
    const { focusEvents } = createFakeFocusEvents(true);
    const tracker = new PrTracker(source, createFakeLogger(), {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(listBuilds).not.toHaveBeenCalled();
    tracker.dispose();
  });

  it('falls back to listBuilds when getChangeStatus returns empty and polls every 5 minutes', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    const pr = makePr();
    const build = makeBuild();

    findOpenPrForBranch.mockResolvedValue(pr);
    getChangeStatus.mockResolvedValue([]);
    listBuilds.mockResolvedValue([build]);

    const { source } = createFakeContextSource(makeResolvedContext());
    const { focusEvents } = createFakeFocusEvents(true);
    const logger = createFakeLogger();

    const tracker = new PrTracker(source, logger, {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(getChangeStatus).toHaveBeenCalledTimes(1);
    expect(listBuilds).toHaveBeenCalledTimes(1);
    expect(listBuilds).toHaveBeenCalledWith('main', {
      project: 'acme/service',
      change: 42,
      patchset: 'pr-head-sha-1',
    });
    expect(tracker.snapshot).toEqual({
      pr,
      statuses: [],
      builds: [build],
      fetchedAt: 1_000_000,
      zuul: { kind: 'ok' },
    });

    // Should not poll at 60s (idle cadence is 5 times the interval)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(240_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(2);
    expect(listBuilds).toHaveBeenCalledTimes(2);

    tracker.dispose();
  });

  it('switches to 15s cadence during watchFor(ms) and returns to normal cadence afterwards', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    const pr = makePr();

    findOpenPrForBranch.mockResolvedValue(pr);
    getChangeStatus.mockResolvedValue([]);
    listBuilds.mockResolvedValue([]);

    const { source } = createFakeContextSource(makeResolvedContext());
    const { focusEvents } = createFakeFocusEvents(true);
    const logger = createFakeLogger();

    const tracker = new PrTracker(source, logger, {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(getChangeStatus).toHaveBeenCalledTimes(1);

    // Start fast watch for 40s (should reschedule the idle timer to 15s)
    tracker.watchFor(40_000);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(3);

    // fastUntil (t + 40s) is still in the future at t + 30s -> one more 15s poll
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(4);

    // fastUntil has expired -> cadence is 5 minutes
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(285_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(5);

    tracker.dispose();
  });

  it('re-fetches the PR on every tick to detect new pushes', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    const prV1 = makePr({
      head: { sha: 'sha-v1', ref: 'feat/x', repo: { full_name: 'acme/service' } },
    });
    const prV2 = makePr({
      head: { sha: 'sha-v2', ref: 'feat/x', repo: { full_name: 'acme/service' } },
    });

    findOpenPrForBranch.mockResolvedValueOnce(prV1).mockResolvedValueOnce(prV2);
    getChangeStatus.mockResolvedValue([makeStatus()]);
    listBuilds.mockResolvedValue([]);

    const { source } = createFakeContextSource(makeResolvedContext());
    const { focusEvents } = createFakeFocusEvents(true);
    const logger = createFakeLogger();

    const tracker = new PrTracker(source, logger, {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });

    // Tick 0 (initial): fetches PR (sha-v1) + status
    await vi.advanceTimersByTimeAsync(0);
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);
    expect(getChangeStatus).toHaveBeenLastCalledWith('main', 42, 'sha-v1');

    // Tick 1: PR is fetched again and the new SHA is used for the status
    await vi.advanceTimersByTimeAsync(60_000);
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);
    expect(getChangeStatus).toHaveBeenCalledTimes(2);
    expect(getChangeStatus).toHaveBeenLastCalledWith('main', 42, 'sha-v2');
    expect(tracker.snapshot?.pr.head.sha).toBe('sha-v2');

    tracker.dispose();
  });

  it('logs errors with [Poll] and retries after 30 s without throwing out of loop', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    const pr = makePr();
    const status = makeStatus();

    findOpenPrForBranch
      .mockRejectedValueOnce(new Error('GitHub 502 Bad Gateway'))
      .mockResolvedValue(pr);
    getChangeStatus.mockResolvedValue([status]);
    listBuilds.mockResolvedValue([]);

    const { source } = createFakeContextSource(makeResolvedContext());
    const { focusEvents } = createFakeFocusEvents(true);
    const logger = createFakeLogger();

    const tracker = new PrTracker(source, logger, {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });

    // Initial tick fails -> logged with [Poll], loop continues
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0].msg).toContain('[Poll]');
    expect(getChangeStatus).not.toHaveBeenCalled();

    // The retry runs after 30 s and succeeds
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(1);
    expect(logger.errors).toHaveLength(1);

    tracker.dispose();
  });

  it('pauses polling while unfocused and resumes + refreshes on focus', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    const pr = makePr();

    findOpenPrForBranch.mockResolvedValue(pr);
    getChangeStatus.mockResolvedValue([makeStatus()]);
    listBuilds.mockResolvedValue([]);

    const { source } = createFakeContextSource(makeResolvedContext());
    const { focusEvents, setFocused } = createFakeFocusEvents(true);
    const logger = createFakeLogger();

    const tracker = new PrTracker(source, logger, {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(getChangeStatus).toHaveBeenCalledTimes(1);

    // Blur window -> polling pauses
    setFocused(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(1);

    // Focus window -> immediately refreshes and resumes polling
    setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);
    expect(getChangeStatus).toHaveBeenCalledTimes(2);

    // Next tick runs after the interval
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(3);

    tracker.dispose();
  });

  it('polls the new branch at once on focus after a branch change while unfocused', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    findOpenPrForBranch.mockResolvedValue(makePr());
    getChangeStatus.mockResolvedValue([]);
    listBuilds.mockResolvedValue([]);

    const { source, setContext } = createFakeContextSource(makeResolvedContext());
    const { focusEvents, setFocused } = createFakeFocusEvents(true);
    const tracker = new PrTracker(source, createFakeLogger(), {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);

    setFocused(false);
    setContext(makeResolvedContext({ branch: 'other-branch' }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);

    setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);
    expect(findOpenPrForBranch).toHaveBeenLastCalledWith('acme', 'service', 'other-branch');
    tracker.dispose();
  });

  it('does not poll on focus when the last poll is newer than the delay, and polls at the remainder', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    findOpenPrForBranch.mockResolvedValue(makePr());
    getChangeStatus.mockResolvedValue([makeStatus()]);
    listBuilds.mockResolvedValue([]);

    const { source } = createFakeContextSource(makeResolvedContext());
    const { focusEvents, setFocused } = createFakeFocusEvents(true);
    const tracker = new PrTracker(source, createFakeLogger(), {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(getChangeStatus).toHaveBeenCalledTimes(1);

    setFocused(false);
    await vi.advanceTimersByTimeAsync(10_000);
    setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(49_900);
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);

    tracker.dispose();
  });

  it('picks up a newly opened PR on manual refresh() after finding none', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    const pr = makePr();

    findOpenPrForBranch.mockResolvedValueOnce(undefined).mockResolvedValue(pr);
    getChangeStatus.mockResolvedValue([]);
    listBuilds.mockResolvedValue([]);

    const { source, setContext } = createFakeContextSource(undefined);
    const { focusEvents } = createFakeFocusEvents(true);
    const snapshots: (PrSnapshot | undefined)[] = [];

    const tracker = new PrTracker(source, createFakeLogger(), {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });
    tracker.onDidChange((s) => snapshots.push(s));

    setContext(makeResolvedContext());
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.snapshot).toBeUndefined();
    expect(snapshots).toEqual([undefined]);

    await tracker.refresh();
    expect(tracker.snapshot?.pr).toEqual(pr);
    expect(snapshots).toHaveLength(2);

    tracker.dispose();
  });

  it('clears the snapshot when the context loses its branch (detached HEAD)', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    findOpenPrForBranch.mockResolvedValue(makePr());
    getChangeStatus.mockResolvedValue([]);
    listBuilds.mockResolvedValue([]);

    const { source, setContext } = createFakeContextSource(undefined);
    const { focusEvents } = createFakeFocusEvents(true);
    const snapshots: (PrSnapshot | undefined)[] = [];
    const tracker = new PrTracker(source, createFakeLogger(), {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });
    tracker.onDidChange((s) => snapshots.push(s));

    setContext(makeResolvedContext());
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.snapshot?.pr.number).toBe(42);

    setContext(makeResolvedContext({ branch: undefined }));
    expect(tracker.snapshot).toBeUndefined();
    expect(snapshots.at(-1)).toBeUndefined();

    tracker.dispose();
  });

  it('does nothing on refresh() after dispose', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    findOpenPrForBranch.mockResolvedValue(makePr());
    getChangeStatus.mockResolvedValue([]);
    listBuilds.mockResolvedValue([]);

    const { source } = createFakeContextSource(makeResolvedContext());
    const { focusEvents } = createFakeFocusEvents(true);
    const tracker = new PrTracker(source, createFakeLogger(), {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);

    tracker.dispose();
    await tracker.refresh();
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);
  });

  it('clears the snapshot when the branch changes, before polling the new one', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    findOpenPrForBranch.mockResolvedValueOnce(makePr());
    getChangeStatus.mockResolvedValue([]);
    listBuilds.mockResolvedValue([]);

    const { source, setContext } = createFakeContextSource(undefined);
    const { focusEvents } = createFakeFocusEvents(true);
    const tracker = new PrTracker(source, createFakeLogger(), {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });
    const snapshots: (PrSnapshot | undefined)[] = [];
    tracker.onDidChange((s) => snapshots.push(s));

    setContext(makeResolvedContext());
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.snapshot?.pr.number).toBe(42);

    // The next lookup never resolves, so only the early clear can empty the snapshot.
    findOpenPrForBranch.mockReturnValue(new Promise(() => undefined));
    setContext(makeResolvedContext({ branch: 'other-branch' }));
    expect(tracker.snapshot).toBeUndefined();
    expect(snapshots.at(-1)).toBeUndefined();
    tracker.dispose();
  });

  it('keeps the snapshot when only the head SHA changes', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    findOpenPrForBranch.mockResolvedValueOnce(makePr());
    getChangeStatus.mockResolvedValue([]);
    listBuilds.mockResolvedValue([]);

    const { source, setContext } = createFakeContextSource(undefined);
    const { focusEvents } = createFakeFocusEvents(true);
    const tracker = new PrTracker(source, createFakeLogger(), {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });

    setContext(makeResolvedContext());
    await vi.advanceTimersByTimeAsync(0);
    findOpenPrForBranch.mockReturnValue(new Promise(() => undefined));
    setContext(makeResolvedContext({ headSha: 'another-local-sha' }));
    expect(tracker.snapshot?.pr.number).toBe(42);
    tracker.dispose();
  });
});

describe('PrTracker races', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
  } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it('drops a stale PR response that arrives after the context changed', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    const stalePr = makePr({ number: 1, title: 'Old branch PR' });
    const freshPr = makePr({ number: 2, title: 'New branch PR' });
    const staleLookup = deferred<PullRequest | undefined>();

    findOpenPrForBranch.mockReturnValueOnce(staleLookup.promise).mockResolvedValue(freshPr);
    getChangeStatus.mockResolvedValue([]);
    listBuilds.mockResolvedValue([]);

    const { source, setContext } = createFakeContextSource(makeResolvedContext());
    const { focusEvents } = createFakeFocusEvents(true);
    const tracker = new PrTracker(source, createFakeLogger(), {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });
    const snapshots: (PrSnapshot | undefined)[] = [];
    tracker.onDidChange((s) => snapshots.push(s));

    // The first lookup is still in flight when the branch changes.
    setContext(makeResolvedContext({ branch: 'other-branch' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.snapshot?.pr.number).toBe(2);

    staleLookup.resolve(stalePr);
    await vi.advanceTimersByTimeAsync(0);

    expect(tracker.snapshot?.pr.number).toBe(2);
    expect(snapshots.every((s) => s?.pr.number !== 1)).toBe(true);
    expect(getChangeStatus).not.toHaveBeenCalledWith('main', 1, expect.anything());
    tracker.dispose();
  });

  it('refresh() cancels a pending timer so the same tick does not poll twice', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    findOpenPrForBranch.mockResolvedValue(makePr());
    getChangeStatus.mockResolvedValue([makeStatus()]);
    listBuilds.mockResolvedValue([]);

    const { source } = createFakeContextSource(makeResolvedContext());
    const { focusEvents } = createFakeFocusEvents(true);
    const tracker = new PrTracker(source, createFakeLogger(), {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(getChangeStatus).toHaveBeenCalledTimes(1);

    // 1s before the 60s timer would fire.
    await vi.advanceTimersByTimeAsync(59_000);
    await tracker.refresh();
    expect(getChangeStatus).toHaveBeenCalledTimes(2);

    // The old timer's moment passes: no extra poll. The next one is 60s after refresh().
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(3);
    tracker.dispose();
  });

  it('refresh() during an in-flight timer poll wins over the slower older poll', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    const slow = deferred<ChangeStatus[]>();
    const slowStatus = makeStatus({ pipeline: 'slow-old' });
    const freshStatus = makeStatus({ pipeline: 'fresh' });

    findOpenPrForBranch.mockResolvedValue(makePr());
    getChangeStatus
      .mockResolvedValueOnce([makeStatus()])
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue([freshStatus]);
    listBuilds.mockResolvedValue([]);

    const { source } = createFakeContextSource(makeResolvedContext());
    const { focusEvents } = createFakeFocusEvents(true);
    const tracker = new PrTracker(source, createFakeLogger(), {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });
    await vi.advanceTimersByTimeAsync(0);

    // The timer poll starts and hangs on the slow status call.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(2);

    await tracker.refresh();
    expect(tracker.snapshot?.statuses).toEqual([freshStatus]);

    slow.resolve([slowStatus]);
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.snapshot?.statuses).toEqual([freshStatus]);
    tracker.dispose();
  });
});

const HOUR_MS = 3_600_000;

describe('PrTracker stops polling when retrying cannot help', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function start(ctx: ResolvedContext) {
    const { source, setContext } = createFakeContextSource(ctx);
    const { focusEvents, setFocused } = createFakeFocusEvents(true);
    const logger = createFakeLogger();
    const tracker = new PrTracker(source, logger, {
      setTimer: setTimeout,
      now: Date.now,
      focusEvents,
    });
    return { tracker, setContext, setFocused, logger };
  }

  /** Runs the first poll and the three retries. Every poll must fail for this to reach four. */
  async function runRetries(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(120_000);
  }

  describe('GitHub', () => {
    it('500s make exactly 4 calls, after 30, 60 and 120 s, then none for an hour', async () => {
      const { findOpenPrForBranch, makeResolvedContext } = createMockClients();
      findOpenPrForBranch.mockRejectedValue(new HttpError(500, 'boom'));
      const { tracker } = start(makeResolvedContext());

      await vi.advanceTimersByTimeAsync(0);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);
      expect(tracker.pollStatus).toEqual({ kind: 'active' });

      await vi.advanceTimersByTimeAsync(29_999);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(59_999);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(119_999);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(4);
      expect(tracker.pollStatus).toMatchObject({ kind: 'stopped', reason: 'failed' });

      await vi.advanceTimersByTimeAsync(HOUR_MS);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(4);
      tracker.dispose();
    });

    it('keeps the last snapshot and reports when it stopped', async () => {
      const { findOpenPrForBranch, getChangeStatus, makeResolvedContext } = createMockClients();
      const pr = makePr();
      findOpenPrForBranch.mockResolvedValueOnce(pr);
      getChangeStatus.mockResolvedValue([makeStatus()]);
      findOpenPrForBranch.mockRejectedValue(new Error('network down'));
      const { tracker } = start(makeResolvedContext());
      const changes = vi.fn();
      tracker.onDidChangePollStatus(changes);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(120_000);

      expect(tracker.snapshot?.pr).toEqual(pr);
      expect(tracker.pollStatus).toEqual({
        kind: 'stopped',
        reason: 'failed',
        message: 'network down',
        at: 1_000_000 + 270_000,
        lastSuccessAt: 1_000_000,
      });
      expect(changes).toHaveBeenCalledTimes(1);
      tracker.dispose();
    });

    it('only stops after four failures in a row', async () => {
      const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
        createMockClients();
      const boom = new HttpError(500, 'boom');
      findOpenPrForBranch
        .mockRejectedValueOnce(boom)
        .mockRejectedValueOnce(boom)
        .mockRejectedValueOnce(boom)
        .mockResolvedValueOnce(makePr())
        .mockRejectedValue(boom);
      getChangeStatus.mockResolvedValue([]);
      listBuilds.mockResolvedValue([]);
      const { tracker } = start(makeResolvedContext());

      await runRetries();
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(4);
      expect(tracker.pollStatus).toEqual({ kind: 'active' });

      // The success puts the next poll on the idle interval, then three more failures still retry.
      await vi.advanceTimersByTimeAsync(300_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(7);
      expect(tracker.pollStatus).toEqual({ kind: 'active' });

      await vi.advanceTimersByTimeAsync(120_000);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(8);
      expect(tracker.pollStatus).toMatchObject({ kind: 'stopped', reason: 'failed' });
      tracker.dispose();
    });

    it.each([401, 403, 404])('a %i makes 1 call and stops at once', async (status) => {
      const { findOpenPrForBranch, makeResolvedContext } = createMockClients();
      findOpenPrForBranch.mockRejectedValue(new HttpError(status, 'nope'));
      const { tracker } = start(makeResolvedContext());

      await vi.advanceTimersByTimeAsync(HOUR_MS);

      expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);
      expect(tracker.pollStatus).toMatchObject({ kind: 'stopped', reason: 'auth' });
      tracker.dispose();
    });

    it('Retry-After: 3600 makes no call for an hour, then resumes and keeps the snapshot', async () => {
      const { findOpenPrForBranch, getChangeStatus, makeResolvedContext } = createMockClients();
      const guard = new RateLimitGuard(Date.now);
      getChangeStatus.mockResolvedValue([makeStatus()]);
      findOpenPrForBranch.mockResolvedValueOnce(makePr());
      const { tracker } = start(makeResolvedContext());
      await vi.advanceTimersByTimeAsync(0);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);

      findOpenPrForBranch.mockImplementationOnce(() =>
        Promise.reject(
          guard.recordFailure('core', 429, new Headers({ 'retry-after': '3600' }), 'slow down'),
        ),
      );
      findOpenPrForBranch.mockResolvedValue(makePr());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);
      expect(tracker.pollStatus).toMatchObject({
        kind: 'rate-limited',
        until: 1_000_000 + 60_000 + HOUR_MS,
      });
      expect(tracker.snapshot?.pr.number).toBe(42);

      await vi.advanceTimersByTimeAsync(HOUR_MS - 1);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(3);
      expect(tracker.pollStatus).toEqual({ kind: 'active' });
      tracker.dispose();
    });

    it('Retry-After: 0 waits 30 s instead of polling at once', async () => {
      const { findOpenPrForBranch, makeResolvedContext } = createMockClients();
      const guard = new RateLimitGuard(Date.now);
      findOpenPrForBranch.mockImplementation(() =>
        Promise.reject(
          guard.recordFailure('core', 429, new Headers({ 'retry-after': '0' }), 'slow down'),
        ),
      );
      const { tracker } = start(makeResolvedContext());

      await vi.advanceTimersByTimeAsync(0);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);
      expect(tracker.pollStatus).toMatchObject({
        kind: 'rate-limited',
        until: 1_000_000 + 30_000,
      });

      await vi.advanceTimersByTimeAsync(29_999);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);
      tracker.dispose();
    });

    it('does not count rate limits as failures', async () => {
      const { findOpenPrForBranch, makeResolvedContext } = createMockClients();
      findOpenPrForBranch.mockImplementation(() =>
        Promise.reject(new RateLimitedError(429, 'slow down', Date.now() + 60_000)),
      );
      const { tracker } = start(makeResolvedContext());

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(findOpenPrForBranch).toHaveBeenCalledTimes(6);
      expect(tracker.pollStatus.kind).toBe('rate-limited');
      tracker.dispose();
    });

    it('retries a failure that follows a rate limit instead of polling in a loop', async () => {
      const { findOpenPrForBranch, makeResolvedContext } = createMockClients();
      findOpenPrForBranch
        .mockRejectedValueOnce(new RateLimitedError(429, 'slow down', Date.now() + 60_000))
        .mockRejectedValue(new HttpError(500, 'boom'));
      const { tracker } = start(makeResolvedContext());

      await vi.advanceTimersByTimeAsync(60_000);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);
      expect(tracker.pollStatus).toEqual({ kind: 'active' });

      await vi.advanceTimersByTimeAsync(29_999);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(3);
      tracker.dispose();
    });

    it('no PR makes 1 call and stops', async () => {
      const { findOpenPrForBranch, makeResolvedContext } = createMockClients();
      findOpenPrForBranch.mockResolvedValue(undefined);
      const { tracker } = start(makeResolvedContext());

      await vi.advanceTimersByTimeAsync(HOUR_MS);

      expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);
      expect(tracker.pollStatus).toEqual({ kind: 'no-pr' });
      tracker.dispose();
    });
  });

  describe('resuming', () => {
    it.each([
      ['GitHub stopped after failures', new HttpError(500, 'boom'), 4],
      ['GitHub refused the token', new HttpError(401, 'nope'), 1],
    ] as const)('Refresh resumes when %s', async (_name, error, calls) => {
      const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
        createMockClients();
      findOpenPrForBranch.mockRejectedValue(error);
      getChangeStatus.mockResolvedValue([]);
      listBuilds.mockResolvedValue([]);
      const { tracker } = start(makeResolvedContext());
      await runRetries();
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(calls);

      findOpenPrForBranch.mockResolvedValue(makePr());
      await tracker.refresh();

      expect(findOpenPrForBranch).toHaveBeenCalledTimes(calls + 1);
      expect(tracker.pollStatus).toEqual({ kind: 'active' });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(calls + 2);
      tracker.dispose();
    });

    it('a branch change resumes after GitHub stopped', async () => {
      const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
        createMockClients();
      findOpenPrForBranch.mockRejectedValue(new HttpError(401, 'nope'));
      getChangeStatus.mockResolvedValue([]);
      listBuilds.mockResolvedValue([]);
      const { tracker, setContext } = start(makeResolvedContext());
      await vi.advanceTimersByTimeAsync(0);
      expect(tracker.pollStatus.kind).toBe('stopped');

      findOpenPrForBranch.mockResolvedValue(makePr());
      setContext(makeResolvedContext({ branch: 'other-branch' }));
      await vi.advanceTimersByTimeAsync(0);

      expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);
      expect(tracker.pollStatus).toEqual({ kind: 'active' });
      tracker.dispose();
    });

    it('a branch change resumes after no PR', async () => {
      const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
        createMockClients();
      findOpenPrForBranch.mockResolvedValueOnce(undefined).mockResolvedValue(makePr());
      getChangeStatus.mockResolvedValue([]);
      listBuilds.mockResolvedValue([]);
      const { tracker, setContext } = start(makeResolvedContext());
      await vi.advanceTimersByTimeAsync(0);
      expect(tracker.pollStatus).toEqual({ kind: 'no-pr' });

      setContext(makeResolvedContext({ branch: 'other-branch' }));
      await vi.advanceTimersByTimeAsync(0);

      expect(tracker.pollStatus).toEqual({ kind: 'active' });
      expect(tracker.snapshot?.pr.number).toBe(42);
      tracker.dispose();
    });

    it('resets the failure count on Refresh', async () => {
      const { findOpenPrForBranch, makeResolvedContext } = createMockClients();
      findOpenPrForBranch.mockRejectedValue(new HttpError(500, 'boom'));
      const { tracker } = start(makeResolvedContext());
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);

      await tracker.refresh();
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(3);

      // Counting starts over, so the next retry is after 30 s, not 120 s.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(4);
      expect(tracker.pollStatus).toEqual({ kind: 'active' });
      tracker.dispose();
    });
  });

  describe('window focus', () => {
    it('does not restart a stopped poll', async () => {
      const { findOpenPrForBranch, makeResolvedContext } = createMockClients();
      findOpenPrForBranch.mockRejectedValue(new HttpError(401, 'nope'));
      const { tracker, setFocused } = start(makeResolvedContext());
      await vi.advanceTimersByTimeAsync(0);

      setFocused(false);
      await vi.advanceTimersByTimeAsync(HOUR_MS);
      setFocused(true);
      await vi.advanceTimersByTimeAsync(HOUR_MS);

      expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);
      expect(tracker.pollStatus.kind).toBe('stopped');
      tracker.dispose();
    });

    it('restores the rate-limit timer without calling early', async () => {
      const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
        createMockClients();
      findOpenPrForBranch
        .mockRejectedValueOnce(new RateLimitedError(429, 'slow down', Date.now() + 600_000))
        .mockResolvedValue(makePr());
      getChangeStatus.mockResolvedValue([]);
      listBuilds.mockResolvedValue([]);
      const { tracker, setFocused } = start(makeResolvedContext());
      await vi.advanceTimersByTimeAsync(0);

      setFocused(false);
      await vi.advanceTimersByTimeAsync(100_000);
      setFocused(true);
      await vi.advanceTimersByTimeAsync(499_999);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);
      expect(tracker.pollStatus).toEqual({ kind: 'active' });
      tracker.dispose();
    });

    it('does one lookup while there is no PR, at most once per poll interval', async () => {
      const { findOpenPrForBranch, makeResolvedContext } = createMockClients();
      findOpenPrForBranch.mockResolvedValue(undefined);
      const { tracker, setFocused } = start(makeResolvedContext());
      await vi.advanceTimersByTimeAsync(0);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);

      setFocused(false);
      await vi.advanceTimersByTimeAsync(10_000);
      setFocused(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);

      setFocused(false);
      await vi.advanceTimersByTimeAsync(50_000);
      setFocused(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(HOUR_MS);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);
      tracker.dispose();
    });

    it('keeps the retry delay across a blur and focus', async () => {
      const { findOpenPrForBranch, makeResolvedContext } = createMockClients();
      findOpenPrForBranch.mockRejectedValue(new HttpError(500, 'boom'));
      const { tracker, setFocused } = start(makeResolvedContext());
      await vi.advanceTimersByTimeAsync(0);

      setFocused(false);
      await vi.advanceTimersByTimeAsync(10_000);
      setFocused(true);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);
      tracker.dispose();
    });

    it('does not retry a stopped Zuul', async () => {
      const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
        createMockClients();
      findOpenPrForBranch.mockResolvedValue(makePr());
      getChangeStatus.mockRejectedValue(new HttpError(401, 'nope'));
      listBuilds.mockResolvedValue([]);
      const { tracker, setFocused } = start(makeResolvedContext());
      await vi.advanceTimersByTimeAsync(0);
      expect(getChangeStatus).toHaveBeenCalledTimes(1);

      setFocused(false);
      await vi.advanceTimersByTimeAsync(HOUR_MS);
      setFocused(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);
      expect(getChangeStatus).toHaveBeenCalledTimes(1);
      tracker.dispose();
    });
  });

  it('watchFor does not restart a stopped poll', async () => {
    const { findOpenPrForBranch, makeResolvedContext } = createMockClients();
    findOpenPrForBranch.mockRejectedValue(new HttpError(401, 'nope'));
    const { tracker } = start(makeResolvedContext());
    await vi.advanceTimersByTimeAsync(0);

    tracker.watchFor(45_000);
    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });

  describe('Zuul', () => {
    it('a 401 makes 1 call per token, then none for an hour, and GitHub keeps polling', async () => {
      const { findOpenPrForBranch, makeResolvedContext } = createMockClients();
      findOpenPrForBranch.mockResolvedValue(makePr());
      const fetchFn = vi.fn<typeof fetch>(async () => new Response('nope', { status: 401 }));
      const client = new ZuulClient(
        'https://zuul.example.com',
        async () => ['token-a', 'token-b'],
        fetchFn,
      );
      const { tracker } = start(
        makeResolvedContext({ zuul: { url: 'https://zuul.example.com', tenant: 'main', client } }),
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(tracker.snapshot?.zuul).toMatchObject({
        kind: 'unavailable',
        reason: 'needs-token',
        stopped: true,
      });

      await vi.advanceTimersByTimeAsync(HOUR_MS);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      // One poll at the start, then one every 5 minutes.
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(13);
      expect(tracker.pollStatus).toEqual({ kind: 'active' });
      expect(tracker.snapshot?.zuul).toMatchObject({ stopped: true });
      tracker.dispose();
    });

    it('a 403 stops at once with no-access', async () => {
      const { findOpenPrForBranch, getChangeStatus, makeResolvedContext } = createMockClients();
      findOpenPrForBranch.mockResolvedValue(makePr());
      getChangeStatus.mockRejectedValue(new HttpError(403, 'nope'));
      const { tracker } = start(makeResolvedContext());

      await vi.advanceTimersByTimeAsync(HOUR_MS);

      expect(getChangeStatus).toHaveBeenCalledTimes(1);
      expect(tracker.snapshot?.zuul).toMatchObject({ reason: 'no-access', stopped: true });
      tracker.dispose();
    });

    it('500s make exactly 4 calls, then none for an hour, and GitHub keeps polling', async () => {
      const { findOpenPrForBranch, getChangeStatus, makeResolvedContext } = createMockClients();
      findOpenPrForBranch.mockResolvedValue(makePr());
      getChangeStatus.mockRejectedValue(new HttpError(500, 'boom'));
      const { tracker } = start(makeResolvedContext());

      await vi.advanceTimersByTimeAsync(0);
      expect(getChangeStatus).toHaveBeenCalledTimes(1);
      expect(tracker.snapshot?.zuul).toMatchObject({ reason: 'unreachable', stopped: false });

      await vi.advanceTimersByTimeAsync(29_999);
      expect(getChangeStatus).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(getChangeStatus).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(getChangeStatus).toHaveBeenCalledTimes(3);
      expect(tracker.snapshot?.zuul).toMatchObject({ stopped: false });

      await vi.advanceTimersByTimeAsync(120_000);
      expect(getChangeStatus).toHaveBeenCalledTimes(4);
      expect(tracker.snapshot?.zuul).toMatchObject({ reason: 'unreachable', stopped: true });

      await vi.advanceTimersByTimeAsync(HOUR_MS);
      expect(getChangeStatus).toHaveBeenCalledTimes(4);
      // Four polls while retrying, then one every 5 minutes.
      expect(findOpenPrForBranch).toHaveBeenCalledTimes(4 + 12);
      expect(tracker.pollStatus).toEqual({ kind: 'active' });
      tracker.dispose();
    });

    it('a success resets the Zuul failure count', async () => {
      const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
        createMockClients();
      const boom = new HttpError(500, 'boom');
      findOpenPrForBranch.mockResolvedValue(makePr());
      getChangeStatus
        .mockRejectedValueOnce(boom)
        .mockRejectedValueOnce(boom)
        .mockResolvedValueOnce([])
        .mockRejectedValue(boom);
      listBuilds.mockResolvedValue([]);
      const { tracker } = start(makeResolvedContext());

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getChangeStatus).toHaveBeenCalledTimes(3);
      expect(tracker.snapshot?.zuul).toEqual({ kind: 'ok' });

      await vi.advanceTimersByTimeAsync(300_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getChangeStatus).toHaveBeenCalledTimes(6);
      expect(tracker.snapshot?.zuul).toMatchObject({ stopped: false });

      await vi.advanceTimersByTimeAsync(120_000);
      expect(getChangeStatus).toHaveBeenCalledTimes(7);
      expect(tracker.snapshot?.zuul).toMatchObject({ stopped: true });
      tracker.dispose();
    });

    it.each([
      ['refused the token', new HttpError(401, 'nope'), 1],
      ['stopped responding', new HttpError(500, 'boom'), 4],
    ] as const)(
      'Refresh, which a new token runs, tries Zuul again after it %s',
      async (_name, error, calls) => {
        const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
          createMockClients();
        findOpenPrForBranch.mockResolvedValue(makePr());
        getChangeStatus.mockRejectedValue(error);
        listBuilds.mockResolvedValue([]);
        const { tracker } = start(makeResolvedContext());
        await runRetries();
        expect(getChangeStatus).toHaveBeenCalledTimes(calls);

        getChangeStatus.mockResolvedValue([]);
        await tracker.refresh();

        expect(getChangeStatus).toHaveBeenCalledTimes(calls + 1);
        expect(tracker.snapshot?.zuul).toEqual({ kind: 'ok' });
        tracker.dispose();
      },
    );

    it('a branch change tries Zuul again', async () => {
      const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
        createMockClients();
      findOpenPrForBranch.mockResolvedValue(makePr());
      getChangeStatus.mockRejectedValueOnce(new HttpError(401, 'nope')).mockResolvedValue([]);
      listBuilds.mockResolvedValue([]);
      const { tracker, setContext } = start(makeResolvedContext());
      await vi.advanceTimersByTimeAsync(0);
      expect(tracker.snapshot?.zuul).toMatchObject({ stopped: true });

      setContext(makeResolvedContext({ branch: 'other-branch' }));
      await vi.advanceTimersByTimeAsync(0);

      expect(getChangeStatus).toHaveBeenCalledTimes(2);
      expect(tracker.snapshot?.zuul).toEqual({ kind: 'ok' });
      tracker.dispose();
    });
  });
});
