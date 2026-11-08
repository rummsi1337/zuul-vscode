import { type Build, type ChangeStatus } from '../clients/zuulTypes';
import { classifyJobResult, getLatestBuildsPerJob, pickPrimary } from './buildsModel';
import { type PrSnapshot } from './prTracker';

export interface StatusBarInfo {
  text: string;
  tooltip: string;
}

function isNotPassing(result?: string): boolean {
  const trimmed = result?.trim();
  if (!trimmed) {
    return false;
  }
  const state = classifyJobResult(trimmed);
  return state !== 'success' && state !== 'skipped';
}

function selectStatus(statuses: ChangeStatus[]): ChangeStatus | undefined {
  return pickPrimary(statuses, (s) => s.pipeline);
}

function selectBuildPipeline(builds: Build[]): string {
  return pickPrimary(builds, (b) => b.pipeline ?? '')?.pipeline || 'check';
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
      const failedCount = jobs.filter((j) => isNotPassing(j.result)).length;

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
    const failedCount = latestBuilds.filter((b) => isNotPassing(b.result)).length;

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
