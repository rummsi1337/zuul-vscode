import { type Build, type ChangeStatus } from '../clients/zuulTypes';
import { type PrSnapshot } from './prTracker';

export interface StatusBarInfo {
  text: string;
  tooltip: string;
}

const FAILURE_RESULTS = new Set([
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'POST_FAILURE',
  'NODE_FAILURE',
  'RETRY_LIMIT',
  'EXCEPTION',
]);

function isJobFailure(result?: string): boolean {
  if (!result) {
    return false;
  }
  const upper = result.trim().toUpperCase();
  return FAILURE_RESULTS.has(upper) || upper.includes('FAIL');
}

function selectStatus(statuses: ChangeStatus[]): ChangeStatus | undefined {
  const gate = statuses.find((s) => s.pipeline.toLowerCase() === 'gate');
  if (gate) {
    return gate;
  }
  const check = statuses.find((s) => s.pipeline.toLowerCase() === 'check');
  if (check) {
    return check;
  }
  return statuses[0];
}

function selectBuildPipeline(builds: Build[]): string {
  const gate = builds.find((b) => (b.pipeline ?? '').toLowerCase() === 'gate');
  if (gate && gate.pipeline) {
    return gate.pipeline;
  }
  const check = builds.find((b) => (b.pipeline ?? '').toLowerCase() === 'check');
  if (check && check.pipeline) {
    return check.pipeline;
  }
  return builds[0]?.pipeline || 'check';
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

function getLatestBuildsPerJob(builds: Build[]): Build[] {
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

export function statusBarText(
  snapshot: PrSnapshot | undefined,
  waiting: boolean,
): StatusBarInfo | undefined {
  if (waiting) {
    return {
      text: '$(sync~spin) Zuul: waiting for enqueue…',
      tooltip: snapshot
        ? `PR #${snapshot.pr.number}: ${snapshot.pr.title}`
        : 'Zuul: waiting for enqueue…',
    };
  }

  if (!snapshot) {
    return undefined;
  }

  const tooltip = `PR #${snapshot.pr.number}: ${snapshot.pr.title}`;

  if (snapshot.statuses && snapshot.statuses.length > 0) {
    const status = selectStatus(snapshot.statuses);
    if (status) {
      const pipeline = status.pipeline || 'unknown';
      const jobs = status.jobs || [];
      const total = jobs.length;
      const done = jobs.filter((j) => Boolean(j.result && j.result.trim().length > 0)).length;
      const failedCount = jobs.filter((j) => isJobFailure(j.result)).length;

      if (failedCount > 0) {
        return {
          text: `$(error) Zuul ${pipeline}: ${failedCount} failed`,
          tooltip,
        };
      }

      let eta = '';
      if (typeof status.remainingTimeMs === 'number' && Number.isFinite(status.remainingTimeMs)) {
        const m = Math.max(0, Math.ceil(status.remainingTimeMs / 60000));
        eta = ` (ETA ${m}m)`;
      }

      return {
        text: `$(sync~spin) Zuul ${pipeline}: ${done}/${total}${eta}`,
        tooltip,
      };
    }
  }

  if (snapshot.builds && snapshot.builds.length > 0) {
    const pipeline = selectBuildPipeline(snapshot.builds);
    const matchingBuilds = snapshot.builds.filter(
      (b) => (b.pipeline ?? '').toLowerCase() === pipeline.toLowerCase(),
    );
    const candidates = matchingBuilds.length > 0 ? matchingBuilds : snapshot.builds;
    const latestBuilds = getLatestBuildsPerJob(candidates);
    const failedCount = latestBuilds.filter((b) => isJobFailure(b.result)).length;

    if (failedCount > 0) {
      return {
        text: `$(error) Zuul ${pipeline}: ${failedCount} failed`,
        tooltip,
      };
    }

    return {
      text: `$(check) Zuul ${pipeline}: PASSED`,
      tooltip,
    };
  }

  return {
    text: '$(circle-outline) Zuul: no builds',
    tooltip,
  };
}
