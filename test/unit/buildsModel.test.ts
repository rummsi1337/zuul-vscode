import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { type Build } from '../../src/clients/zuulTypes';
import {
  buildTree,
  classifyJobResult,
  formatDuration,
  type JobNode,
  sortJobs,
} from '../../src/services/buildsModel';
import { type PrSnapshot } from '../../src/services/prTracker';
import {
  BuildsTreeDataProvider,
  getJobIconId,
  OPEN_BUILD_LOG_COMMAND,
  openBuildLogExternally,
} from '../../src/views/buildsTreeView';
import { makePr } from '../helpers';

function makeSnapshot(overrides?: Partial<PrSnapshot>): PrSnapshot {
  return {
    pr: makePr(),
    statuses: [],
    builds: [],
    fetchedAt: 1700000000000,
    zuul: { kind: 'ok' },
    ...overrides,
  };
}

describe('buildsModel', () => {
  describe('classifyJobResult', () => {
    it('classifies SUCCESS, SKIPPED, failures, and other results', () => {
      expect(classifyJobResult('SUCCESS')).toBe('success');
      expect(classifyJobResult('  success  ')).toBe('success');
      expect(classifyJobResult('SKIPPED')).toBe('skipped');
      expect(classifyJobResult('FAILURE')).toBe('failure');
      expect(classifyJobResult('ERROR')).toBe('failure');
      expect(classifyJobResult('TIMED_OUT')).toBe('failure');
      expect(classifyJobResult('POST_FAILURE')).toBe('failure');
      expect(classifyJobResult('NODE_FAILURE')).toBe('failure');
      expect(classifyJobResult('RETRY_LIMIT')).toBe('failure');
      expect(classifyJobResult('EXCEPTION')).toBe('failure');
      expect(classifyJobResult('ABORTED')).toBe('other');
      expect(classifyJobResult('DEQUEUED')).toBe('other');
    });
  });

  describe('formatDuration', () => {
    it('formats durations across seconds, minutes, and hours', () => {
      expect(formatDuration(0)).toBe('0s');
      expect(formatDuration(45000)).toBe('45s');
      expect(formatDuration(60000)).toBe('1m');
      expect(formatDuration(90000)).toBe('1m 30s');
      expect(formatDuration(3600000)).toBe('1h');
      expect(formatDuration(4500000)).toBe('1h 15m');
    });
  });

  describe('sortJobs', () => {
    it('sorts failures first, then running, queued, success, skipped, other, and alphabetically within', () => {
      const unsorted: JobNode[] = [
        { name: 'z-success', state: 'success' },
        { name: 'a-success', state: 'success' },
        { name: 'b-queued', state: 'queued' },
        { name: 'a-queued', state: 'queued' },
        { name: 'b-running', state: 'running' },
        { name: 'a-running', state: 'running' },
        { name: 'z-failure', state: 'failure' },
        { name: 'a-failure', state: 'failure' },
        { name: 'skipped-job', state: 'skipped' },
        { name: 'aborted-job', state: 'other' },
      ];

      const sorted = sortJobs(unsorted);
      expect(sorted.map((j) => j.name)).toEqual([
        'a-failure',
        'z-failure',
        'a-running',
        'b-running',
        'a-queued',
        'b-queued',
        'a-success',
        'z-success',
        'skipped-job',
        'aborted-job',
      ]);
    });
  });

  describe('buildTree', () => {
    it('returns empty array when snapshot is undefined or has no statuses/builds', () => {
      expect(buildTree(undefined)).toEqual([]);
      expect(buildTree(makeSnapshot())).toEqual([]);
    });

    it('ignores non-live statuses without jobs so builds are used', () => {
      const tree = buildTree(
        makeSnapshot({
          statuses: [{ pipeline: '', queue: '', live: false, jobs: [], itemsAhead: [] }],
          builds: [
            {
              uuid: 'b1',
              jobName: 'j',
              pipeline: 'check',
              result: 'SUCCESS',
              voting: false,
              artifacts: [],
            },
          ],
        }),
      );
      expect(tree).toEqual([
        {
          pipeline: 'check',
          live: false,
          jobs: [{ name: 'j', state: 'success', result: 'SUCCESS', uuid: 'b1', voting: false }],
        },
      ]);
    });

    it('carries voting from statuses', () => {
      const tree = buildTree(
        makeSnapshot({
          statuses: [
            {
              pipeline: 'check',
              queue: '',
              live: true,
              itemsAhead: [],
              jobs: [{ name: 'j', running: true, voting: false }],
            },
          ],
        }),
      );
      expect(tree[0].jobs[0].voting).toBe(false);
    });

    it('builds tree from statuses when present and sorts jobs properly', () => {
      const snapshot = makeSnapshot({
        statuses: [
          {
            pipeline: 'check',
            queue: 'shared',
            live: true,
            itemsAhead: [],
            jobs: [
              {
                name: 'tox-py311',
                uuid: 'u-pass',
                running: false,
                result: 'SUCCESS',
                elapsedMs: 45000,
                reportUrl: 'https://logs.example.com/pass/',
              },
              {
                name: 'deploy-preview',
                running: false,
              },
              {
                name: 'tox-linters',
                uuid: 'u-fail',
                running: false,
                result: 'FAILURE',
                elapsedMs: 30000,
                reportUrl: 'https://logs.example.com/fail/',
              },
              {
                name: 'integration-e2e',
                uuid: 'u-run',
                running: true,
                elapsedMs: 12000,
              },
              {
                name: 'docs-build',
                uuid: 'u-skip',
                running: false,
                result: 'SKIPPED',
              },
              {
                name: 'optional-check',
                uuid: 'u-abort',
                running: false,
                result: 'ABORTED',
              },
            ],
          },
        ],
        builds: [
          {
            uuid: 'ignored-when-statuses-exist',
            jobName: 'old-build',
            pipeline: 'check',
            result: 'SUCCESS',
            artifacts: [],
          },
        ],
      });

      const tree = buildTree(snapshot);
      expect(tree).toEqual([
        {
          pipeline: 'check',
          live: true,
          jobs: [
            {
              name: 'tox-linters',
              state: 'failure',
              result: 'FAILURE',
              uuid: 'u-fail',
              logUrl: 'https://logs.example.com/fail/',
              durationMs: 30000,
            },
            {
              name: 'integration-e2e',
              state: 'running',
              uuid: 'u-run',
              durationMs: 12000,
            },
            {
              name: 'deploy-preview',
              state: 'queued',
            },
            {
              name: 'tox-py311',
              state: 'success',
              result: 'SUCCESS',
              uuid: 'u-pass',
              logUrl: 'https://logs.example.com/pass/',
              durationMs: 45000,
            },
            {
              name: 'docs-build',
              state: 'skipped',
              result: 'SKIPPED',
              uuid: 'u-skip',
            },
            {
              name: 'optional-check',
              state: 'other',
              result: 'ABORTED',
              uuid: 'u-abort',
            },
          ],
        },
      ]);
    });

    it('builds tree from latest build per job when statuses are empty', () => {
      const builds: Build[] = [
        {
          uuid: 'b-old',
          jobName: 'tox-py311',
          pipeline: 'check',
          result: 'FAILURE',
          startTime: '2026-11-07T10:00:00Z',
          endTime: '2026-11-07T10:01:00Z',
          logUrl: 'https://logs.example.com/old/',
          artifacts: [],
        },
        {
          uuid: 'b-new',
          jobName: 'tox-py311',
          pipeline: 'check',
          result: 'SUCCESS',
          startTime: '2026-11-07T11:00:00Z',
          endTime: '2026-11-07T11:01:30Z',
          logUrl: 'https://logs.example.com/new/',
          artifacts: [],
        },
        {
          uuid: 'b-lint',
          jobName: 'tox-linters',
          pipeline: 'check',
          result: 'FAILURE',
          startTime: '2026-11-07T11:00:00Z',
          endTime: '2026-11-07T11:00:25Z',
          logUrl: 'https://logs.example.com/lint/',
          artifacts: [],
        },
        {
          uuid: 'b-gate',
          jobName: 'gate-job',
          pipeline: 'gate',
          result: 'SUCCESS',
          startTime: '2026-11-07T12:00:00Z',
          endTime: '2026-11-07T12:02:00Z',
          artifacts: [],
        },
      ];

      const tree = buildTree(makeSnapshot({ statuses: [], builds }));
      expect(tree).toEqual([
        {
          pipeline: 'check',
          live: false,
          jobs: [
            {
              name: 'tox-linters',
              state: 'failure',
              result: 'FAILURE',
              uuid: 'b-lint',
              logUrl: 'https://logs.example.com/lint/',
              durationMs: 25000,
            },
            {
              name: 'tox-py311',
              state: 'success',
              result: 'SUCCESS',
              uuid: 'b-new',
              logUrl: 'https://logs.example.com/new/',
              durationMs: 90000,
            },
          ],
        },
        {
          pipeline: 'gate',
          live: false,
          jobs: [
            {
              name: 'gate-job',
              state: 'success',
              result: 'SUCCESS',
              uuid: 'b-gate',
              durationMs: 120000,
            },
          ],
        },
      ]);
    });

    it('handles builds with startTime only, invalid timestamps, or missing pipeline', () => {
      const builds: Build[] = [
        {
          uuid: 'b-running',
          jobName: 'running-build',
          pipeline: '',
          startTime: '2026-11-07T10:00:00Z',
          artifacts: [],
        },
        {
          uuid: 'b-queued',
          jobName: '',
          pipeline: '',
          startTime: 'invalid',
          endTime: 'invalid',
          artifacts: [],
        },
      ];

      const tree = buildTree(makeSnapshot({ statuses: [], builds }));
      expect(tree).toEqual([
        {
          pipeline: 'check',
          live: false,
          jobs: [
            {
              name: 'running-build',
              state: 'running',
              uuid: 'b-running',
            },
            {
              name: '',
              state: 'queued',
              uuid: 'b-queued',
            },
          ],
        },
      ]);
    });
  });
});

describe('BuildsTreeDataProvider', () => {
  it('maps JobState to the expected ThemeIcon id', () => {
    expect(getJobIconId('failure')).toBe('error');
    expect(getJobIconId('running')).toBe('sync~spin');
    expect(getJobIconId('queued')).toBe('clock');
    expect(getJobIconId('success')).toBe('pass');
    expect(getJobIconId('skipped')).toBe('circle-slash');
    expect(getJobIconId('other')).toBe('circle-slash');
  });

  it('provides pipeline and job tree items and refreshes on tracker change', async () => {
    const emitter = new vscode.EventEmitter<PrSnapshot | undefined>();
    const tracker: {
      snapshot: PrSnapshot | undefined;
      onDidChange: vscode.Event<PrSnapshot | undefined>;
    } = {
      snapshot: undefined,
      onDidChange: emitter.event,
    };
    const openExternal = vi.fn(async () => true);

    const provider = new BuildsTreeDataProvider(tracker, openExternal);
    const onTreeChange = vi.fn();
    provider.onDidChangeTreeData(onTreeChange);

    expect(provider.getChildren()).toEqual([]);

    tracker.snapshot = makeSnapshot({
      statuses: [
        {
          pipeline: 'check',
          queue: 'shared',
          live: true,
          itemsAhead: [],
          jobs: [
            {
              name: 'tox-linters',
              uuid: 'u-1',
              running: false,
              result: 'FAILURE',
              elapsedMs: 30000,
              reportUrl: 'https://logs.example.com/1/',
            },
            {
              name: 'tox-py311',
              uuid: 'u-2',
              running: true,
              elapsedMs: 75000,
            },
            {
              name: 'deploy',
              running: false,
            },
          ],
        },
      ],
    });
    emitter.fire(tracker.snapshot);
    expect(onTreeChange).toHaveBeenCalledTimes(1);

    const rootNodes = provider.getChildren();
    expect(rootNodes).toHaveLength(1);
    const pipelineNode = rootNodes[0]!;
    const pipelineItem = provider.getTreeItem(pipelineNode);
    expect(pipelineItem.label).toBe('check');
    expect(pipelineItem.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
    expect(pipelineItem.contextValue).toBe('zuulPipeline');

    const jobNodes = provider.getChildren(pipelineNode);
    expect(jobNodes).toHaveLength(3);

    // 1. Failed job: result as description, error icon, command to open logUrl
    const failedJob = jobNodes[0] as JobNode;
    const failedItem = provider.getTreeItem(failedJob);
    expect(failedItem.label).toBe('tox-linters');
    expect(failedItem.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    expect((failedItem.iconPath as vscode.ThemeIcon).id).toBe('error');
    expect(failedItem.description).toBe('FAILURE');
    expect(failedItem.contextValue).toBe('zuulJob.failure');
    expect(failedItem.command).toEqual({
      command: OPEN_BUILD_LOG_COMMAND,
      title: 'Open Build Log',
      arguments: ['https://logs.example.com/1/'],
    });
    expect(provider.getChildren(failedJob)).toEqual([]);

    // 2. Running job: elapsed time as description, sync~spin icon, no command
    const runningJob = jobNodes[1] as JobNode;
    const runningItem = provider.getTreeItem(runningJob);
    expect(runningItem.label).toBe('tox-py311');
    expect((runningItem.iconPath as vscode.ThemeIcon).id).toBe('sync~spin');
    expect(runningItem.description).toBe('1m 15s');
    expect(runningItem.contextValue).toBe('zuulJob.running');
    expect(runningItem.command).toBeUndefined();

    // 3. Queued job: no description, clock icon, no command
    const queuedJob = jobNodes[2] as JobNode;
    const queuedItem = provider.getTreeItem(queuedJob);
    expect(queuedItem.label).toBe('deploy');
    expect((queuedItem.iconPath as vscode.ThemeIcon).id).toBe('clock');
    expect(queuedItem.description).toBeUndefined();
    expect(queuedItem.contextValue).toBe('zuulJob.queued');
    expect(queuedItem.command).toBeUndefined();

    // Open log externally via provider or helper
    await provider.openJobLog(failedJob.logUrl);
    expect(openExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        scheme: 'https',
        authority: 'logs.example.com',
        path: '/1/',
      }),
    );

    await openBuildLogExternally(failedJob, openExternal);
    expect(openExternal).toHaveBeenCalledTimes(2);

    await openBuildLogExternally(undefined, openExternal);
    expect(openExternal).toHaveBeenCalledTimes(2);

    provider.dispose();
  });
});

describe('openBuildLogExternally URL schemes', () => {
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'vscode://x/y'])(
    'does not open %s',
    async (url) => {
      const openExternal = vi.fn(async () => true);
      await openBuildLogExternally(url, openExternal);
      expect(openExternal).not.toHaveBeenCalled();
    },
  );

  it('opens https URLs', async () => {
    const openExternal = vi.fn(async () => true);
    await openBuildLogExternally('https://logs.example.com/1/', openExternal);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
