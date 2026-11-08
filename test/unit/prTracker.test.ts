import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type GheClient } from '../../src/clients/gheClient';
import { type PullRequest } from '../../src/clients/gheTypes';
import { type ZuulClient } from '../../src/clients/zuulClient';
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

  it('uses PR head SHA from GHE (not local HEAD) and polls every 15s when ChangeStatus exists', async () => {
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

    const tracker = new PrTracker(source, logger, setTimeout, Date.now, focusEvents);
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
    });
    expect(snapshots).toHaveLength(1);

    // Should not poll at 14.9s, should poll at 15s
    await vi.advanceTimersByTimeAsync(14_900);
    expect(getChangeStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(getChangeStatus).toHaveBeenCalledTimes(2);
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);

    tracker.dispose();
  });

  it('still makes a snapshot, without calling Zuul, when the context has no Zuul', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    const pr = makePr();
    findOpenPrForBranch.mockResolvedValue(pr);

    const { source } = createFakeContextSource(makeResolvedContext({ zuul: undefined }));
    const { focusEvents } = createFakeFocusEvents(true);
    const tracker = new PrTracker(source, createFakeLogger(), setTimeout, Date.now, focusEvents);
    await vi.advanceTimersByTimeAsync(0);

    expect(getChangeStatus).not.toHaveBeenCalled();
    expect(listBuilds).not.toHaveBeenCalled();
    expect(tracker.snapshot).toEqual({ pr, statuses: [], builds: [], fetchedAt: 1_000_000 });
    tracker.dispose();
  });

  it('falls back to listBuilds when every status is non-live', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    findOpenPrForBranch.mockResolvedValue(makePr());
    getChangeStatus.mockResolvedValue([makeStatus({ live: false, jobs: [] })]);
    listBuilds.mockResolvedValue([makeBuild()]);

    const { source } = createFakeContextSource(makeResolvedContext());
    const { focusEvents } = createFakeFocusEvents(true);
    const tracker = new PrTracker(source, createFakeLogger(), setTimeout, Date.now, focusEvents);
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
    const tracker = new PrTracker(source, createFakeLogger(), setTimeout, Date.now, focusEvents);
    await vi.advanceTimersByTimeAsync(0);

    expect(listBuilds).not.toHaveBeenCalled();
    tracker.dispose();
  });

  it('falls back to listBuilds when getChangeStatus returns empty and polls every 60s', async () => {
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

    const tracker = new PrTracker(source, logger, setTimeout, Date.now, focusEvents);
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
    });

    // Should not poll at 15s (idle cadence is 60s)
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(45_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(2);
    expect(listBuilds).toHaveBeenCalledTimes(2);

    tracker.dispose();
  });

  it('switches to 3s cadence during watchFor(ms) and returns to normal cadence afterwards', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    const pr = makePr();

    findOpenPrForBranch.mockResolvedValue(pr);
    getChangeStatus.mockResolvedValue([]);
    listBuilds.mockResolvedValue([]);

    const { source } = createFakeContextSource(makeResolvedContext());
    const { focusEvents } = createFakeFocusEvents(true);
    const logger = createFakeLogger();

    const tracker = new PrTracker(source, logger, setTimeout, Date.now, focusEvents);
    await vi.advanceTimersByTimeAsync(0);
    expect(getChangeStatus).toHaveBeenCalledTimes(1);

    // Start fast watch for 7000ms (should reschedule the 60s timer to 3s)
    tracker.watchFor(7_000);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(3);

    // At t + 6000ms, fastUntil (t + 7000ms) is still in the future -> one more 3s poll
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(4);

    // Now at t + 9000ms, fastUntil has expired -> cadence is 60s
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(57_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(5);

    tracker.dispose();
  });

  it('re-fetches the PR itself every 4th tick to detect new pushes', async () => {
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

    const tracker = new PrTracker(source, logger, setTimeout, Date.now, focusEvents);

    // Tick 0 (initial): fetches PR (sha-v1) + status
    await vi.advanceTimersByTimeAsync(0);
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);
    expect(getChangeStatus).toHaveBeenLastCalledWith('main', 42, 'sha-v1');

    // Tick 1: status only
    await vi.advanceTimersByTimeAsync(15_000);
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);
    expect(getChangeStatus).toHaveBeenCalledTimes(2);

    // Tick 2: status only
    await vi.advanceTimersByTimeAsync(15_000);
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);
    expect(getChangeStatus).toHaveBeenCalledTimes(3);

    // Tick 3: status only
    await vi.advanceTimersByTimeAsync(15_000);
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(1);
    expect(getChangeStatus).toHaveBeenCalledTimes(4);

    // Tick 4 (4th tick): re-fetches PR (sha-v2) and uses new SHA for status
    await vi.advanceTimersByTimeAsync(15_000);
    expect(findOpenPrForBranch).toHaveBeenCalledTimes(2);
    expect(getChangeStatus).toHaveBeenCalledTimes(5);
    expect(getChangeStatus).toHaveBeenLastCalledWith('main', 42, 'sha-v2');
    expect(tracker.snapshot?.pr.head.sha).toBe('sha-v2');

    tracker.dispose();
  });

  it('logs errors with [Poll] and retries at normal delay without throwing out of loop', async () => {
    const { findOpenPrForBranch, getChangeStatus, listBuilds, makeResolvedContext } =
      createMockClients();
    const pr = makePr();
    const status = makeStatus();

    findOpenPrForBranch.mockResolvedValue(pr);
    getChangeStatus
      .mockResolvedValueOnce([status])
      .mockRejectedValueOnce(new Error('Zuul 502 Bad Gateway'))
      .mockResolvedValueOnce([status]);
    listBuilds.mockResolvedValue([]);

    const { source } = createFakeContextSource(makeResolvedContext());
    const { focusEvents } = createFakeFocusEvents(true);
    const logger = createFakeLogger();

    const tracker = new PrTracker(source, logger, setTimeout, Date.now, focusEvents);

    // Initial tick succeeds
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.errors).toHaveLength(0);

    // Next tick (15s) fails -> logged with [Poll], loop continues
    await vi.advanceTimersByTimeAsync(15_000);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0].msg).toContain('[Poll]');

    // Next tick (another 15s) succeeds
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(3);
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

    const tracker = new PrTracker(source, logger, setTimeout, Date.now, focusEvents);
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

    // Next 15s tick runs as normal
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(3);

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

    const tracker = new PrTracker(source, createFakeLogger(), setTimeout, Date.now, focusEvents);
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
    const tracker = new PrTracker(source, createFakeLogger(), setTimeout, Date.now, focusEvents);
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
    const tracker = new PrTracker(source, createFakeLogger(), setTimeout, Date.now, focusEvents);
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
    const tracker = new PrTracker(source, createFakeLogger(), setTimeout, Date.now, focusEvents);
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
    const tracker = new PrTracker(source, createFakeLogger(), setTimeout, Date.now, focusEvents);

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
    const tracker = new PrTracker(source, createFakeLogger(), setTimeout, Date.now, focusEvents);
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
    const tracker = new PrTracker(source, createFakeLogger(), setTimeout, Date.now, focusEvents);
    await vi.advanceTimersByTimeAsync(0);
    expect(getChangeStatus).toHaveBeenCalledTimes(1);

    // 1s before the 15s timer would fire.
    await vi.advanceTimersByTimeAsync(14_000);
    await tracker.refresh();
    expect(getChangeStatus).toHaveBeenCalledTimes(2);

    // The old timer's moment passes: no extra poll. The next one is 15s after refresh().
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14_000);
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
    const tracker = new PrTracker(source, createFakeLogger(), setTimeout, Date.now, focusEvents);
    await vi.advanceTimersByTimeAsync(0);

    // The timer poll starts and hangs on the slow status call.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getChangeStatus).toHaveBeenCalledTimes(2);

    await tracker.refresh();
    expect(tracker.snapshot?.statuses).toEqual([freshStatus]);

    slow.resolve([slowStatus]);
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.snapshot?.statuses).toEqual([freshStatus]);
    tracker.dispose();
  });
});

describe('PrTracker poll errors', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes the last poll error and clears it after a successful poll', async () => {
    const { findOpenPrForBranch, getChangeStatus, makeResolvedContext } = createMockClients();
    findOpenPrForBranch.mockResolvedValueOnce(makePr());
    getChangeStatus.mockResolvedValueOnce([makeStatus()]);
    findOpenPrForBranch.mockRejectedValueOnce(new Error('network down'));
    const { source } = createFakeContextSource(makeResolvedContext());
    const { focusEvents } = createFakeFocusEvents(true);
    const tracker = new PrTracker(source, createFakeLogger(), setTimeout, Date.now, focusEvents);
    const changes = vi.fn();
    tracker.onDidChangePollError(changes);

    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.pollError).toBeUndefined();

    await tracker.refresh();
    expect(tracker.pollError).toEqual({
      message: 'network down',
      at: 1_000_000,
      lastSuccessAt: 1_000_000,
    });
    expect(changes).toHaveBeenCalledTimes(1);

    findOpenPrForBranch.mockResolvedValue(makePr());
    getChangeStatus.mockResolvedValue([makeStatus()]);
    await tracker.refresh();
    expect(tracker.pollError).toBeUndefined();
    expect(changes).toHaveBeenCalledTimes(2);
    tracker.dispose();
  });
});
