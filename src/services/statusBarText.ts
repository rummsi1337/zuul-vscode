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
  return pickPrimary(builds, (b) => b.pipeline ?? '')?.pipeline?.trim() ?? '';
}

function zuulLabel(pipeline: string): string {
  const name = pipeline.trim();
  return name ? `Zuul ${name}` : 'Zuul';
}

function isBuildPassing(build: Build): boolean {
  const result = build.result?.trim();
  if (!result) {
    return false;
  }
  const state = classifyJobResult(result);
  return state === 'success' || state === 'skipped' || build.voting === false;
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

  // A non-live item without jobs says nothing about this pull request's builds.
  const relevant = (snapshot.statuses ?? []).filter((s) => s.live || s.jobs.length > 0);
  const status = selectStatus(relevant);
  if (status) {
    const label = zuulLabel(status.pipeline);
    const jobs = status.jobs;
    const total = jobs.length;
    const done = jobs.filter((j) => Boolean(j.result && j.result.trim().length > 0)).length;
    const failedCount = jobs.filter((j) => j.voting !== false && isNotPassing(j.result)).length;

    if (failedCount > 0) {
      return { text: `$(error) ${label}: ${failedCount} failed`, tooltip };
    }

    if (total === 0) {
      return { text: `$(clock) ${label}: queued`, tooltip };
    }

    if (done === total) {
      return { text: `$(check) ${label}: passed`, tooltip };
    }

    let eta = '';
    if (typeof status.remainingTimeMs === 'number' && Number.isFinite(status.remainingTimeMs)) {
      const m = Math.max(0, Math.ceil(status.remainingTimeMs / 60000));
      eta = ` (ETA ${m}m)`;
    }

    return { text: `$(sync~spin) ${label}: ${done}/${total}${eta}`, tooltip };
  }

  if (snapshot.builds && snapshot.builds.length > 0) {
    const pipeline = selectBuildPipeline(snapshot.builds);
    const label = zuulLabel(pipeline);
    const matchingBuilds = snapshot.builds.filter(
      (b) => (b.pipeline ?? '').trim().toLowerCase() === pipeline.toLowerCase(),
    );
    const candidates = matchingBuilds.length > 0 ? matchingBuilds : snapshot.builds;
    const latestBuilds = getLatestBuildsPerJob(candidates);
    const failedCount = latestBuilds.filter(
      (b) => b.voting !== false && isNotPassing(b.result),
    ).length;

    if (failedCount > 0) {
      return { text: `$(error) ${label}: ${failedCount} failed`, tooltip };
    }

    if (latestBuilds.every(isBuildPassing)) {
      return { text: `$(check) ${label}: PASSED`, tooltip };
    }

    return { text: `$(sync~spin) ${label}: running`, tooltip };
  }

  return {
    text: '$(circle-outline) Zuul: no builds',
    tooltip,
  };
}

export function offlineStatusText(lastSuccessAt: number | undefined): string {
  if (lastSuccessAt === undefined) {
    return '$(warning) Zuul: offline';
  }
  const d = new Date(lastSuccessAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `$(warning) Zuul: offline, last update ${hh}:${mm}`;
}
