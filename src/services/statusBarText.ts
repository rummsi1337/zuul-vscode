import { type Build, type ChangeStatus } from '../clients/zuulTypes';
import { classifyJobResult, getLatestBuildsPerJob, pickPrimary } from './buildsModel';
import { type PollStatus, type PrSnapshot } from './prTracker';

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

function clock(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export type PollStateName = 'active' | 'no-pr' | 'failed' | 'auth' | 'rate-limited';

export function pollStateName(pollStatus: PollStatus | undefined): PollStateName {
  if (!pollStatus) {
    return 'active';
  }
  if (pollStatus.kind === 'stopped') {
    return pollStatus.reason;
  }
  return pollStatus.kind;
}

const EXPLORER_COMMAND = 'workbench.view.extension.zuul-explorer';

export interface StatusBarView extends StatusBarInfo {
  command?: string;
}

/** What the status bar shows. GitHub problems win over Zuul problems. */
export function statusBarView(
  pollStatus: PollStatus | undefined,
  snapshot: PrSnapshot | undefined,
  waiting: boolean,
): StatusBarView | undefined {
  if (pollStatus?.kind === 'stopped') {
    const failed = pollStatus.reason === 'failed';
    return {
      text: failed
        ? '$(warning) Zuul: GitHub not responding, updates stopped'
        : '$(warning) Zuul: GitHub sign-in needed, updates stopped',
      tooltip: `GitHub updates have stopped: ${pollStatus.message}\nClick to ${
        failed ? 'try again' : 'set a GitHub token'
      }.`,
      command: failed ? 'zuul.refresh' : 'zuul.setGhePat',
    };
  }
  if (pollStatus?.kind === 'rate-limited') {
    return {
      text: `$(clock) Zuul: GitHub rate limit, resumes ${clock(pollStatus.until)}`,
      tooltip: `GitHub updates are paused until ${clock(pollStatus.until)}: ${pollStatus.message}`,
    };
  }

  const info = statusBarText(snapshot, waiting);
  if (!info) {
    return undefined;
  }
  const zuul = snapshot?.zuul;
  if (!zuul || zuul.kind === 'ok') {
    return { ...info, command: EXPLORER_COMMAND };
  }
  if (zuul.reason === 'needs-token' || zuul.reason === 'no-access') {
    return {
      text: `${info.text}, Zuul updates stopped (token needed)`,
      tooltip: `${info.tooltip}\nZuul updates have stopped: ${zuul.message}\nClick to set a Zuul token.`,
      command: 'zuul.setTenantToken',
    };
  }
  if (zuul.stopped) {
    return {
      text: `${info.text}, Zuul updates stopped (not responding)`,
      tooltip: `${info.tooltip}\nZuul updates have stopped: ${zuul.message}\nClick to try again.`,
      command: 'zuul.refresh',
    };
  }
  return {
    text: `${info.text}, Zuul retrying`,
    tooltip: `${info.tooltip}\nZuul is not responding, updates have not stopped yet: ${zuul.message}\nClick to try again.`,
    command: 'zuul.refresh',
  };
}

/** The line shown at the top of the sidebar views, or undefined when all is well. */
export function sidebarMessage(
  pollStatus: PollStatus | undefined,
  snapshot: PrSnapshot | undefined,
): string | undefined {
  // VS Code hides the welcome text while TreeView.message is set. With no snapshot the
  // welcome text (Retry, sign-in) is the better message, so show none here.
  if (!snapshot) {
    return undefined;
  }
  if (pollStatus?.kind === 'stopped') {
    return pollStatus.reason === 'failed'
      ? 'Updates stopped: GitHub is not responding. Data shown may be out of date. Use Refresh to try again.'
      : 'Updates stopped: GitHub sign-in needed.';
  }
  if (pollStatus?.kind === 'rate-limited') {
    return `Updates paused: GitHub rate limit, resumes at ${clock(pollStatus.until)}.`;
  }
  const zuul = snapshot?.zuul;
  if (zuul?.kind === 'unavailable') {
    if (zuul.reason === 'needs-token' || zuul.reason === 'no-access') {
      return 'Zuul updates stopped: the Zuul token was refused. GitHub data is still updating.';
    }
    if (zuul.stopped) {
      return 'Zuul updates stopped: Zuul is not responding. GitHub data is still updating. Use Refresh to try again.';
    }
  }
  return undefined;
}
