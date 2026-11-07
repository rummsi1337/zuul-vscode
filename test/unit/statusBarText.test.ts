import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { type PullRequest } from '../../src/clients/gheTypes';
import { type Build } from '../../src/clients/zuulTypes';
import { type PrSnapshot } from '../../src/services/prTracker';
import { statusBarText } from '../../src/services/statusBarText';
import { ZuulStatusBar } from '../../src/views/statusBar';

function makePr(overrides?: Partial<PullRequest>): PullRequest {
  return {
    number: 42,
    html_url: 'https://ghe.example.com/org/repo/pull/42',
    title: 'Add new feature',
    state: 'open',
    draft: false,
    merged: false,
    body: 'Some PR description',
    head: {
      sha: 'abcdef1234567890',
      ref: 'feature-branch',
      repo: { full_name: 'org/repo' },
    },
    base: {
      ref: 'main',
      repo: { full_name: 'org/repo' },
    },
    user: { login: 'alice' },
    labels: [],
    ...overrides,
  };
}

function makeSnapshot(overrides?: Partial<PrSnapshot>): PrSnapshot {
  return {
    pr: makePr(),
    statuses: [],
    builds: [],
    fetchedAt: Date.now(),
    ...overrides,
  };
}

describe('statusBarText', () => {
  describe('Rule 1: waiting', () => {
    it('returns waiting text when waiting is true even without snapshot', () => {
      const result = statusBarText(undefined, true);
      expect(result).toEqual({
        text: '$(sync~spin) Zuul: waiting for enqueue…',
        tooltip: 'Zuul: waiting for enqueue…',
      });
    });

    it('returns waiting text with PR tooltip when snapshot is present', () => {
      const snapshot = makeSnapshot({
        pr: makePr({ number: 99, title: 'Fix gate blocker' }),
      });
      const result = statusBarText(snapshot, true);
      expect(result).toEqual({
        text: '$(sync~spin) Zuul: waiting for enqueue…',
        tooltip: 'PR #99: Fix gate blocker',
      });
    });
  });

  describe('Rule 2: no snapshot', () => {
    it('returns undefined when snapshot is undefined and waiting is false', () => {
      const result = statusBarText(undefined, false);
      expect(result).toBeUndefined();
    });
  });

  describe('Rule 3: a status exists', () => {
    it('picks gate pipeline over check pipeline', () => {
      const snapshot = makeSnapshot({
        statuses: [
          {
            pipeline: 'check',
            queue: 'check-queue',
            live: true,
            jobs: [{ name: 'job-1', running: true }],
            itemsAhead: [],
          },
          {
            pipeline: 'gate',
            queue: 'gate-queue',
            live: true,
            jobs: [{ name: 'job-2', running: true }],
            itemsAhead: [],
          },
        ],
      });
      const result = statusBarText(snapshot, false);
      expect(result?.text).toBe('$(sync~spin) Zuul gate: 0/1');
    });

    it('picks check pipeline over other pipelines', () => {
      const snapshot = makeSnapshot({
        statuses: [
          {
            pipeline: 'experimental',
            queue: 'exp-queue',
            live: true,
            jobs: [{ name: 'job-1', running: true }],
            itemsAhead: [],
          },
          {
            pipeline: 'check',
            queue: 'check-queue',
            live: true,
            jobs: [{ name: 'job-2', running: true }],
            itemsAhead: [],
          },
        ],
      });
      const result = statusBarText(snapshot, false);
      expect(result?.text).toBe('$(sync~spin) Zuul check: 0/1');
    });

    it('picks first pipeline when neither gate nor check is present', () => {
      const snapshot = makeSnapshot({
        statuses: [
          {
            pipeline: 'periodic',
            queue: 'p-queue',
            live: true,
            jobs: [{ name: 'job-1', running: true }],
            itemsAhead: [],
          },
          {
            pipeline: 'experimental',
            queue: 'exp-queue',
            live: true,
            jobs: [{ name: 'job-2', running: true }],
            itemsAhead: [],
          },
        ],
      });
      const result = statusBarText(snapshot, false);
      expect(result?.text).toBe('$(sync~spin) Zuul periodic: 0/1');
    });

    it('counts done jobs as those with a result', () => {
      const snapshot = makeSnapshot({
        statuses: [
          {
            pipeline: 'check',
            queue: 'q',
            live: true,
            jobs: [
              { name: 'job-1', running: false, result: 'SUCCESS' },
              { name: 'job-2', running: true },
              { name: 'job-3', running: false, result: 'SKIPPED' },
              { name: 'job-4', running: true, result: '' },
            ],
            itemsAhead: [],
          },
        ],
      });
      const result = statusBarText(snapshot, false);
      expect(result?.text).toBe('$(sync~spin) Zuul check: 2/4');
    });

    it('reports failure when any job has FAILURE', () => {
      const snapshot = makeSnapshot({
        statuses: [
          {
            pipeline: 'gate',
            queue: 'q',
            live: true,
            jobs: [
              { name: 'job-1', running: false, result: 'FAILURE' },
              { name: 'job-2', running: true },
            ],
            itemsAhead: [],
          },
        ],
      });
      const result = statusBarText(snapshot, false);
      expect(result?.text).toBe('$(error) Zuul gate: 1 failed');
    });

    it('reports failure when jobs have ERROR, TIMED_OUT, or POST_FAILURE', () => {
      const snapshot = makeSnapshot({
        statuses: [
          {
            pipeline: 'check',
            queue: 'q',
            live: true,
            jobs: [
              { name: 'job-1', running: false, result: 'ERROR' },
              { name: 'job-2', running: false, result: 'TIMED_OUT' },
              { name: 'job-3', running: false, result: 'POST_FAILURE' },
              { name: 'job-4', running: false, result: 'SUCCESS' },
            ],
            itemsAhead: [],
          },
        ],
      });
      const result = statusBarText(snapshot, false);
      expect(result?.text).toBe('$(error) Zuul check: 3 failed');
    });

    it('appends ETA in ceil minutes when remainingTimeMs is set', () => {
      const snapshot = makeSnapshot({
        statuses: [
          {
            pipeline: 'gate',
            queue: 'q',
            live: true,
            remainingTimeMs: 120000, // 2 minutes
            jobs: [
              { name: 'job-1', running: false, result: 'SUCCESS' },
              { name: 'job-2', running: true },
            ],
            itemsAhead: [],
          },
        ],
      });
      const result = statusBarText(snapshot, false);
      expect(result?.text).toBe('$(sync~spin) Zuul gate: 1/2 (ETA 2m)');
    });

    it('rounds up partial minutes for remainingTimeMs', () => {
      const snapshot = makeSnapshot({
        statuses: [
          {
            pipeline: 'gate',
            queue: 'q',
            live: true,
            remainingTimeMs: 65000, // 1m 5s -> ceil 2m
            jobs: [{ name: 'job-1', running: true }],
            itemsAhead: [],
          },
        ],
      });
      const result = statusBarText(snapshot, false);
      expect(result?.text).toBe('$(sync~spin) Zuul gate: 0/1 (ETA 2m)');
    });

    it('handles remainingTimeMs of 0 ms', () => {
      const snapshot = makeSnapshot({
        statuses: [
          {
            pipeline: 'check',
            queue: 'q',
            live: true,
            remainingTimeMs: 0,
            jobs: [{ name: 'job-1', running: true }],
            itemsAhead: [],
          },
        ],
      });
      const result = statusBarText(snapshot, false);
      expect(result?.text).toBe('$(sync~spin) Zuul check: 0/1 (ETA 0m)');
    });
  });

  describe('Rule 4: no status, builds exist', () => {
    it('reports PASSED when all latest builds succeeded', () => {
      const builds: Build[] = [
        {
          uuid: 'u-1',
          jobName: 'tox-py311',
          pipeline: 'check',
          result: 'SUCCESS',
          artifacts: [],
        },
        {
          uuid: 'u-2',
          jobName: 'tox-linters',
          pipeline: 'check',
          result: 'SUCCESS',
          artifacts: [],
        },
      ];
      const snapshot = makeSnapshot({ statuses: [], builds });
      const result = statusBarText(snapshot, false);
      expect(result?.text).toBe('$(check) Zuul check: PASSED');
    });

    it('reports failed count when a build has failed', () => {
      const builds: Build[] = [
        {
          uuid: 'u-1',
          jobName: 'tox-py311',
          pipeline: 'check',
          result: 'FAILURE',
          artifacts: [],
        },
        {
          uuid: 'u-2',
          jobName: 'tox-linters',
          pipeline: 'check',
          result: 'SUCCESS',
          artifacts: [],
        },
      ];
      const snapshot = makeSnapshot({ statuses: [], builds });
      const result = statusBarText(snapshot, false);
      expect(result?.text).toBe('$(error) Zuul check: 1 failed');
    });

    it('uses the latest build per job when an older build failed and a newer one passed', () => {
      const builds: Build[] = [
        {
          uuid: 'u-old',
          jobName: 'tox-py311',
          pipeline: 'check',
          result: 'FAILURE',
          startTime: '2026-11-07T10:00:00Z',
          artifacts: [],
        },
        {
          uuid: 'u-new',
          jobName: 'tox-py311',
          pipeline: 'check',
          result: 'SUCCESS',
          startTime: '2026-11-07T11:00:00Z',
          artifacts: [],
        },
      ];
      const snapshot = makeSnapshot({ statuses: [], builds });
      const result = statusBarText(snapshot, false);
      expect(result?.text).toBe('$(check) Zuul check: PASSED');
    });

    it('uses the latest build per job when an older build passed and a newer one failed', () => {
      const builds: Build[] = [
        {
          uuid: 'u-old',
          jobName: 'tox-py311',
          pipeline: 'check',
          result: 'SUCCESS',
          startTime: '2026-11-07T10:00:00Z',
          artifacts: [],
        },
        {
          uuid: 'u-new',
          jobName: 'tox-py311',
          pipeline: 'check',
          result: 'FAILURE',
          startTime: '2026-11-07T11:00:00Z',
          artifacts: [],
        },
      ];
      const snapshot = makeSnapshot({ statuses: [], builds });
      const result = statusBarText(snapshot, false);
      expect(result?.text).toBe('$(error) Zuul check: 1 failed');
    });

    it('picks gate pipeline over check pipeline in builds', () => {
      const builds: Build[] = [
        {
          uuid: 'u-1',
          jobName: 'build-check',
          pipeline: 'check',
          result: 'FAILURE',
          artifacts: [],
        },
        {
          uuid: 'u-2',
          jobName: 'build-gate',
          pipeline: 'gate',
          result: 'SUCCESS',
          artifacts: [],
        },
      ];
      const snapshot = makeSnapshot({ statuses: [], builds });
      const result = statusBarText(snapshot, false);
      expect(result?.text).toBe('$(check) Zuul gate: PASSED');
    });

    it('handles custom pipeline and compares builds using endTime', () => {
      const builds: Build[] = [
        {
          uuid: 'u-1',
          jobName: 'custom-job',
          pipeline: 'experimental',
          result: 'FAILURE',
          endTime: '2026-11-07T10:00:00Z',
          artifacts: [],
        },
        {
          uuid: 'u-2',
          jobName: 'custom-job',
          pipeline: 'experimental',
          result: 'SUCCESS',
          endTime: '2026-11-07T12:00:00Z',
          artifacts: [],
        },
      ];
      const snapshot = makeSnapshot({ statuses: [], builds });
      const result = statusBarText(snapshot, false);
      expect(result?.text).toBe('$(check) Zuul experimental: PASSED');
    });

    it('falls back when build timestamps are invalid or missing jobName', () => {
      const builds: Build[] = [
        {
          uuid: 'u-invalid',
          jobName: '',
          pipeline: '',
          result: 'SUCCESS',
          startTime: 'invalid-date',
          endTime: 'also-invalid',
          artifacts: [],
        },
      ];
      const snapshot = makeSnapshot({ statuses: [], builds });
      const result = statusBarText(snapshot, false);
      expect(result?.text).toBe('$(check) Zuul check: PASSED');
    });
  });

  describe('Rule 5: else no builds', () => {
    it('returns no builds when statuses and builds are both empty', () => {
      const snapshot = makeSnapshot({ statuses: [], builds: [] });
      const result = statusBarText(snapshot, false);
      expect(result).toEqual({
        text: '$(circle-outline) Zuul: no builds',
        tooltip: 'PR #42: Add new feature',
      });
    });
  });

  describe('Rule 6: tooltip format', () => {
    it('formats tooltip as PR #<n>: <title>', () => {
      const snapshot = makeSnapshot({
        pr: makePr({ number: 1234, title: 'Upgrade React to v19' }),
        statuses: [],
        builds: [],
      });
      const result = statusBarText(snapshot, false);
      expect(result?.tooltip).toBe('PR #1234: Upgrade React to v19');
    });
  });
});

describe('ZuulStatusBar', () => {
  it('creates a left-aligned status bar item with priority 100 and view command', () => {
    const emitter = new vscode.EventEmitter<PrSnapshot | undefined>();
    const tracker = {
      snapshot: undefined,
      onDidChange: emitter.event,
    };

    const statusBar = new ZuulStatusBar(tracker);
    expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(
      vscode.StatusBarAlignment.Left,
      100,
    );

    statusBar.dispose();
  });

  it('updates item text, tooltip and shows item on snapshot change', () => {
    const emitter = new vscode.EventEmitter<PrSnapshot | undefined>();
    let currentSnapshot: PrSnapshot | undefined = undefined;
    const tracker = {
      get snapshot() {
        return currentSnapshot;
      },
      onDidChange: emitter.event,
    };

    const mockItem = {
      alignment: vscode.StatusBarAlignment.Left,
      priority: 100,
      text: '',
      tooltip: '',
      command: undefined as string | undefined,
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    };

    const statusBar = new ZuulStatusBar(
      tracker,
      undefined,
      () => mockItem as unknown as vscode.StatusBarItem,
    );

    expect(mockItem.command).toBe('workbench.view.extension.zuul-explorer');
    expect(mockItem.hide).toHaveBeenCalled();

    // Fire snapshot
    currentSnapshot = makeSnapshot({
      pr: makePr({ number: 7, title: 'Test PR' }),
      statuses: [
        {
          pipeline: 'gate',
          queue: 'gate-q',
          live: true,
          jobs: [{ name: 'unit', running: false, result: 'SUCCESS' }],
          itemsAhead: [],
        },
      ],
    });
    emitter.fire(currentSnapshot);

    expect(mockItem.text).toBe('$(sync~spin) Zuul gate: 1/1');
    expect(mockItem.tooltip).toBe('PR #7: Test PR');
    expect(mockItem.show).toHaveBeenCalled();

    // Disposing cleans up
    statusBar.dispose();
    expect(mockItem.dispose).toHaveBeenCalled();
  });

  it('supports waiting state through setWaiting and WaitingStateSource', () => {
    const emitter = new vscode.EventEmitter<PrSnapshot | undefined>();
    const waitingEmitter = new vscode.EventEmitter<boolean>();
    let isWaiting = false;
    const tracker = {
      snapshot: makeSnapshot({
        pr: makePr({ number: 10, title: 'Waiting test' }),
      }),
      onDidChange: emitter.event,
    };
    const waitingSource = {
      get waiting() {
        return isWaiting;
      },
      onDidChangeWaiting: waitingEmitter.event,
    };

    const mockItem = {
      text: '',
      tooltip: '',
      command: undefined as string | undefined,
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    };

    const statusBar = new ZuulStatusBar(
      tracker,
      waitingSource,
      () => mockItem as unknown as vscode.StatusBarItem,
    );

    // Initial state: no builds
    expect(mockItem.text).toBe('$(circle-outline) Zuul: no builds');

    // Trigger waiting
    isWaiting = true;
    waitingEmitter.fire(true);

    expect(mockItem.text).toBe('$(sync~spin) Zuul: waiting for enqueue…');
    expect(mockItem.tooltip).toBe('PR #10: Waiting test');

    // Disconnect waiting
    isWaiting = false;
    waitingEmitter.fire(false);
    expect(mockItem.text).toBe('$(circle-outline) Zuul: no builds');

    statusBar.dispose();
  });
});
