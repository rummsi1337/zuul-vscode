import { type Build, type JobStatus } from '../clients/zuulTypes';
import { type PrSnapshot } from './prTracker';

export type JobState = 'running' | 'queued' | 'success' | 'failure' | 'skipped' | 'other';

export interface JobNode {
  name: string;
  state: JobState;
  result?: string;
  uuid?: string;
  logUrl?: string;
  durationMs?: number;
}

export interface PipelineNode {
  pipeline: string;
  live: boolean;
  jobs: JobNode[];
}

const FAILURE_RESULTS = new Set([
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'POST_FAILURE',
  'NODE_FAILURE',
  'RETRY_LIMIT',
  'EXCEPTION',
  'MERGE_CONFLICT',
  'CONFIG_ERROR',
]);

const STATE_ORDER: Record<JobState, number> = {
  failure: 0,
  running: 1,
  queued: 2,
  success: 3,
  skipped: 4,
  other: 5,
};

export function classifyJobResult(result: string): JobState {
  const upper = result.trim().toUpperCase();
  if (upper === 'SUCCESS') {
    return 'success';
  }
  if (upper === 'SKIPPED') {
    return 'skipped';
  }
  if (FAILURE_RESULTS.has(upper) || upper.includes('FAIL') || upper.includes('ERROR')) {
    return 'failure';
  }
  return 'other';
}

export function sortJobs(jobs: readonly JobNode[]): JobNode[] {
  return [...jobs].sort((a, b) => {
    const orderDiff = STATE_ORDER[a.state] - STATE_ORDER[b.state];
    if (orderDiff !== 0) {
      return orderDiff;
    }
    return a.name.localeCompare(b.name);
  });
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function jobStatusToNode(job: JobStatus): JobNode {
  const trimmedResult = job.result?.trim();
  const hasResult = Boolean(trimmedResult && trimmedResult.length > 0);
  const state: JobState =
    hasResult && trimmedResult
      ? classifyJobResult(trimmedResult)
      : job.running
        ? 'running'
        : 'queued';

  const node: JobNode = {
    name: job.name,
    state,
  };

  if (hasResult && trimmedResult) {
    node.result = trimmedResult;
  }
  if (job.uuid) {
    node.uuid = job.uuid;
  }
  if (job.reportUrl) {
    node.logUrl = job.reportUrl;
  }
  if (typeof job.elapsedMs === 'number' && Number.isFinite(job.elapsedMs)) {
    node.durationMs = job.elapsedMs;
  }

  return node;
}

function getBuildTime(build: Build): number | undefined {
  if (build.endTime) {
    const t = Date.parse(build.endTime);
    if (!Number.isNaN(t)) {
      return t;
    }
  }
  if (build.startTime) {
    const t = Date.parse(build.startTime);
    if (!Number.isNaN(t)) {
      return t;
    }
  }
  return undefined;
}

function getBuildDurationMs(build: Build): number | undefined {
  if (!build.startTime || !build.endTime) {
    return undefined;
  }
  const start = Date.parse(build.startTime);
  const end = Date.parse(build.endTime);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return undefined;
  }
  return end - start;
}

function getLatestBuildsPerJob(builds: readonly Build[]): Build[] {
  const latestByJob = new Map<string, { build: Build; time?: number }>();

  for (const build of builds) {
    const key = build.jobName || build.uuid;
    const time = getBuildTime(build);
    const existing = latestByJob.get(key);

    if (!existing) {
      latestByJob.set(key, { build, time });
    } else if (time !== undefined) {
      if (existing.time === undefined || time > existing.time) {
        latestByJob.set(key, { build, time });
      }
    }
  }

  return Array.from(latestByJob.values()).map((entry) => entry.build);
}

function buildToNode(build: Build): JobNode {
  const trimmedResult = build.result?.trim();
  const hasResult = Boolean(trimmedResult && trimmedResult.length > 0);
  const state: JobState =
    hasResult && trimmedResult
      ? classifyJobResult(trimmedResult)
      : build.startTime && !build.endTime
        ? 'running'
        : 'queued';

  const node: JobNode = {
    name: build.jobName,
    state,
  };

  if (hasResult && trimmedResult) {
    node.result = trimmedResult;
  }
  if (build.uuid) {
    node.uuid = build.uuid;
  }
  if (build.logUrl) {
    node.logUrl = build.logUrl;
  }
  const durationMs = getBuildDurationMs(build);
  if (durationMs !== undefined) {
    node.durationMs = durationMs;
  }

  return node;
}

export function buildTree(snapshot: PrSnapshot | undefined): PipelineNode[] {
  if (!snapshot) {
    return [];
  }

  if (snapshot.statuses && snapshot.statuses.length > 0) {
    return snapshot.statuses.map((status) => ({
      pipeline: status.pipeline || 'check',
      live: status.live,
      jobs: sortJobs((status.jobs ?? []).map(jobStatusToNode)),
    }));
  }

  if (snapshot.builds && snapshot.builds.length > 0) {
    const buildsByPipeline = new Map<string, Build[]>();
    for (const build of snapshot.builds) {
      const pipeline = build.pipeline || 'check';
      const list = buildsByPipeline.get(pipeline);
      if (list) {
        list.push(build);
      } else {
        buildsByPipeline.set(pipeline, [build]);
      }
    }

    const result: PipelineNode[] = [];
    for (const [pipeline, pipelineBuilds] of buildsByPipeline) {
      const latestBuilds = getLatestBuildsPerJob(pipelineBuilds);
      result.push({
        pipeline,
        live: false,
        jobs: sortJobs(latestBuilds.map(buildToNode)),
      });
    }
    return result;
  }

  return [];
}
