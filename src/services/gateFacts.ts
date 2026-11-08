import { type GheClient } from '../clients/gheClient';
import {
  type CheckRun,
  type CombinedStatus,
  type PrRollup,
  type PullRequest,
  type RequiredStatusChecks,
  type Review,
  type RollupContextNode,
} from '../clients/gheTypes';
import { type ZuulClient } from '../clients/zuulClient';
import { type Build, type Buildset, type ChangeStatus } from '../clients/zuulTypes';
import { mapWithConcurrency } from '../util/concurrency';
import { classifyJobResult, getLatestBuildsPerJob } from './buildsModel';
import { type DependsOnRef, parseDependsOn, prRefKey } from './dependsOnParser';
import { extractPrCoordinates } from './dependsOnService';
import {
  type CheckState,
  type PrGateCheck,
  type PrGateFacts,
  type ReviewDecision,
  type ZuulCheckState,
} from './gateReadiness';

export const MAX_UPSTREAM_FACTS_DEPTH = 5;
export const MAX_UPSTREAM_FACTS_CONCURRENCY = 5;

export type GheGateClient = Pick<
  GheClient,
  | 'getPrRollup'
  | 'listCommitStatuses'
  | 'listCheckRuns'
  | 'getRequiredStatusChecks'
  | 'listReviews'
  | 'getPr'
>;

export type ZuulGateClient = Pick<ZuulClient, 'getChangeStatus'> &
  Partial<Pick<ZuulClient, 'listBuilds' | 'listBuildsets'>>;

const SUCCESS_CHECK_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING_CHECK_STATES = new Set([
  'PENDING',
  'EXPECTED',
  'QUEUED',
  'IN_PROGRESS',
  'WAITING',
  'REQUESTED',
]);
const FAILURE_CHECK_STATES = new Set([
  'FAILURE',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STALE',
]);
const ERROR_CHECK_STATES = new Set(['ERROR', 'STARTUP_FAILURE']);

export function mapStatusContextState(state: string | null | undefined): CheckState {
  if (!state) {
    return 'pending';
  }
  const upper = state.trim().toUpperCase();
  if (SUCCESS_CHECK_STATES.has(upper)) {
    return 'success';
  }
  if (PENDING_CHECK_STATES.has(upper)) {
    return 'pending';
  }
  if (FAILURE_CHECK_STATES.has(upper)) {
    return 'failure';
  }
  if (ERROR_CHECK_STATES.has(upper)) {
    return 'error';
  }
  if (upper === 'MISSING') {
    return 'missing';
  }
  return 'pending';
}

export function mapCheckRunState(
  status: string | null | undefined,
  conclusion: string | null | undefined,
): CheckState {
  const normalizedStatus = status?.trim().toUpperCase();
  if (normalizedStatus && PENDING_CHECK_STATES.has(normalizedStatus)) {
    return 'pending';
  }
  const normalizedConclusion = conclusion?.trim();
  if (normalizedConclusion) {
    return mapStatusContextState(normalizedConclusion);
  }
  if (normalizedStatus) {
    return mapStatusContextState(normalizedStatus);
  }
  return 'pending';
}

function mapRollupChecks(rollup: PrRollup): PrGateCheck[] {
  const commitNodes = rollup.commits?.nodes ?? [];
  const lastCommit = commitNodes[commitNodes.length - 1]?.commit;
  const contextNodes: RollupContextNode[] = lastCommit?.statusCheckRollup?.contexts?.nodes ?? [];

  const byName = new Map<string, PrGateCheck>();
  const upsert = (name: string, state: CheckState, required: boolean): void => {
    const existing = byName.get(name);
    byName.set(name, { name, state, required: required || Boolean(existing?.required) });
  };
  for (const node of contextNodes) {
    if (node.__typename === 'StatusContext') {
      upsert(node.context, mapStatusContextState(node.state), Boolean(node.isRequired));
    } else if (node.__typename === 'CheckRun') {
      upsert(node.name, mapCheckRunState(node.status, node.conclusion), Boolean(node.isRequired));
    }
  }

  return Array.from(byName.values());
}

function mapRestChecks(
  combinedStatus: CombinedStatus,
  checkRuns: readonly CheckRun[],
  requiredStatusChecks: RequiredStatusChecks | undefined,
): PrGateCheck[] {
  const requiredNames = new Set<string>();
  for (const ctx of requiredStatusChecks?.contexts ?? []) {
    if (ctx) {
      requiredNames.add(ctx);
    }
  }
  for (const check of requiredStatusChecks?.checks ?? []) {
    if (check?.context) {
      requiredNames.add(check.context);
    }
  }

  const byName = new Map<string, PrGateCheck>();
  const upsert = (name: string, state: CheckState): void => {
    const existing = byName.get(name);
    byName.set(name, {
      name,
      state,
      required: requiredNames.has(name) || Boolean(existing?.required),
    });
  };

  for (const status of combinedStatus.statuses ?? []) {
    upsert(status.context, mapStatusContextState(status.state));
  }

  for (const run of checkRuns) {
    upsert(run.name, mapCheckRunState(run.status, run.conclusion));
  }

  for (const reqName of requiredNames) {
    if (!byName.has(reqName)) {
      byName.set(reqName, {
        name: reqName,
        state: 'missing',
        required: true,
      });
    }
  }

  return Array.from(byName.values());
}

export function summarizeReviews(reviews: readonly Review[]): {
  approvals: number;
  changesRequested: number;
} {
  const latestByUser = new Map<string, { review: Review; time?: number; index: number }>();

  for (let i = 0; i < reviews.length; i += 1) {
    const review = reviews[i];
    const login = review.user?.login?.trim();
    if (!login) {
      continue;
    }

    const parsedTime = review.submitted_at ? Date.parse(review.submitted_at) : Number.NaN;
    const time = Number.isNaN(parsedTime) ? undefined : parsedTime;
    const prev = latestByUser.get(login);

    if (!prev) {
      latestByUser.set(login, { review, time, index: i });
      continue;
    }

    if (time !== undefined && prev.time !== undefined) {
      if (time >= prev.time) {
        latestByUser.set(login, { review, time, index: i });
      }
    } else if ((review.id ?? i) >= (prev.review.id ?? prev.index)) {
      latestByUser.set(login, { review, time, index: i });
    }
  }

  let approvals = 0;
  let changesRequested = 0;

  for (const { review } of latestByUser.values()) {
    const state = review.state.trim().toUpperCase();
    if (state === 'APPROVED') {
      approvals += 1;
    } else if (state === 'CHANGES_REQUESTED') {
      changesRequested += 1;
    }
  }

  return { approvals, changesRequested };
}

function isPassingResult(result: string): boolean {
  const state = classifyJobResult(result);
  return state === 'success' || state === 'skipped';
}

function evaluateBuildsCheckState(builds: readonly Build[]): ZuulCheckState {
  const latestBuilds = getLatestBuildsPerJob(builds);
  if (latestBuilds.length === 0) {
    return 'none';
  }

  for (const build of latestBuilds) {
    if (!build.result || build.result.trim().length === 0) {
      return 'running';
    }
  }

  const allSucceeded = latestBuilds.every((b) => Boolean(b.result && isPassingResult(b.result)));
  return allSucceeded ? 'success' : 'failure';
}

function evaluateBuildsetCheckState(buildset: Buildset): ZuulCheckState {
  if (buildset.builds && buildset.builds.length > 0) {
    return evaluateBuildsCheckState(buildset.builds);
  }
  if (!buildset.result || buildset.result.trim().length === 0) {
    return 'running';
  }
  return isPassingResult(buildset.result) ? 'success' : 'failure';
}

async function resolveZuulCheckState(
  zuul: ZuulGateClient,
  tenant: string,
  project: string,
  prNumber: number,
  sha: string,
): Promise<ZuulCheckState> {
  const statuses: ChangeStatus[] = await zuul.getChangeStatus(tenant, prNumber, sha);
  const checkStatuses = statuses.filter((s) => s.pipeline.trim().toLowerCase() === 'check');

  if (checkStatuses.length > 0) {
    const jobs = checkStatuses.flatMap((s) => s.jobs ?? []);
    if (jobs.length === 0) {
      return 'running';
    }
    const hasPendingJob = jobs.some((j) => !j.result || j.result.trim().length === 0);
    if (hasPendingJob) {
      return 'running';
    }
    const allSucceeded = jobs.every((j) => Boolean(j.result && isPassingResult(j.result)));
    return allSucceeded ? 'success' : 'failure';
  }

  if (typeof zuul.listBuilds === 'function') {
    const builds = await zuul.listBuilds(tenant, {
      project,
      change: prNumber,
      patchset: sha,
    });
    const checkBuilds = builds.filter(
      (b) =>
        (b.pipeline || 'check').trim().toLowerCase() === 'check' &&
        (!b.patchset || b.patchset === sha),
    );
    if (checkBuilds.length > 0) {
      return evaluateBuildsCheckState(checkBuilds);
    }
  }

  if (typeof zuul.listBuildsets === 'function') {
    const buildsets = await zuul.listBuildsets(tenant, {
      project,
      change: prNumber,
      patchset: sha,
    });
    const checkBuildsets = buildsets.filter(
      (bs) =>
        (bs.pipeline || 'check').trim().toLowerCase() === 'check' &&
        (!bs.patchset || bs.patchset === sha),
    );
    if (checkBuildsets.length > 0) {
      return evaluateBuildsetCheckState(checkBuildsets[0]);
    }
  }

  return 'none';
}

async function collectGateFactsInternal(
  ghe: GheGateClient,
  zuul: ZuulGateClient,
  tenant: string,
  pr: PullRequest,
  fetchFreshPr: boolean,
): Promise<PrGateFacts> {
  const coords = extractPrCoordinates(pr);
  if (!coords) {
    throw new Error('Pull request has no base repository');
  }
  const { owner, repo, number: prNumber } = coords;
  const project = `${owner}/${repo}`;
  const ref = `${project}#${prNumber}`;
  const sha = pr.head.sha;
  const baseBranch = pr.base.ref;

  const freshPrPromise =
    fetchFreshPr && typeof ghe.getPr === 'function'
      ? ghe.getPr(owner, repo, prNumber).catch(() => pr)
      : Promise.resolve(pr);

  const [freshPr, rollup, reviews, zuulCheck] = await Promise.all([
    freshPrPromise,
    ghe.getPrRollup(owner, repo, prNumber),
    ghe.listReviews(owner, repo, prNumber),
    resolveZuulCheckState(zuul, tenant, project, prNumber, sha),
  ]);

  const effectivePr = freshPr ?? pr;
  const { approvals, changesRequested } = summarizeReviews(reviews);
  const mergeableState = effectivePr.mergeable_state ?? pr.mergeable_state;

  let draft: boolean;
  let labels: string[];
  let reviewDecision: ReviewDecision | undefined;
  let checks: PrGateCheck[];

  if (rollup !== undefined) {
    draft = Boolean(rollup.isDraft ?? effectivePr.draft);
    labels = rollup.labels?.nodes
      ? rollup.labels.nodes.map((n) => n.name)
      : (effectivePr.labels ?? []).map((l) => l.name);
    reviewDecision = rollup.reviewDecision ?? undefined;
    checks = mapRollupChecks(rollup);
  } else {
    draft = Boolean(effectivePr.draft);
    labels = (effectivePr.labels ?? []).map((l) => l.name);
    reviewDecision = undefined;

    const [combinedStatus, checkRuns, requiredStatusChecks] = await Promise.all([
      ghe.listCommitStatuses(owner, repo, sha),
      ghe.listCheckRuns(owner, repo, sha),
      ghe.getRequiredStatusChecks(owner, repo, baseBranch),
    ]);

    checks = mapRestChecks(combinedStatus, checkRuns, requiredStatusChecks);
  }

  const facts: PrGateFacts = {
    ref,
    draft,
    merged: Boolean(effectivePr.merged),
    state: effectivePr.state,
    labels,
    approvals,
    changesRequested,
    checks,
    zuulCheck,
  };

  if (mergeableState !== undefined) {
    facts.mergeableState = mergeableState;
  }
  if (reviewDecision !== undefined) {
    facts.reviewDecision = reviewDecision;
  }

  return facts;
}

export async function collectGateFacts(
  ghe: GheGateClient,
  zuul: ZuulGateClient,
  tenant: string,
  pr: PullRequest,
): Promise<PrGateFacts> {
  return collectGateFactsInternal(ghe, zuul, tenant, pr, true);
}

function extractValidDependsOnRefs(
  body: string | null | undefined,
  seenKeys: Set<string>,
): { owner: string; repo: string; number: number }[] {
  const parsed = parseDependsOn(body ?? null).filter(
    (ref): ref is DependsOnRef & { owner: string; repo: string; number: number } =>
      Boolean(ref.owner && ref.repo && ref.number !== undefined),
  );

  const result: { owner: string; repo: string; number: number }[] = [];
  for (const ref of parsed) {
    const key = prRefKey({ owner: ref.owner, repo: ref.repo, number: ref.number });
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      result.push({
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
      });
    }
  }
  return result;
}

export async function collectUpstreamFacts(
  ghe: GheGateClient,
  zuul: ZuulGateClient,
  tenant: string,
  rootPr: PullRequest,
  maxDepth = MAX_UPSTREAM_FACTS_DEPTH,
  concurrency = MAX_UPSTREAM_FACTS_CONCURRENCY,
): Promise<PrGateFacts[]> {
  if (rootPr.merged || maxDepth <= 0) {
    return [];
  }

  const seenKeys = new Set<string>();
  const rootCoords = extractPrCoordinates(rootPr);
  if (rootCoords) {
    seenKeys.add(prRefKey(rootCoords));
  }

  let currentLevelRefs = extractValidDependsOnRefs(rootPr.body, seenKeys);
  const allFacts: PrGateFacts[] = [];
  let depth = 1;

  while (currentLevelRefs.length > 0 && depth <= maxDepth) {
    const levelResults = await mapWithConcurrency(
      currentLevelRefs,
      concurrency,
      async (ref): Promise<{ pr: PullRequest; facts: PrGateFacts } | undefined> => {
        try {
          const upstreamPr = await ghe.getPr(ref.owner, ref.repo, ref.number);
          if (upstreamPr.merged) {
            return undefined;
          }
          const facts = await collectGateFactsInternal(ghe, zuul, tenant, upstreamPr, false);
          return { pr: upstreamPr, facts };
        } catch {
          return undefined;
        }
      },
    );

    const nextLevelRefs: { owner: string; repo: string; number: number }[] = [];
    for (const entry of levelResults) {
      if (!entry) {
        continue;
      }
      allFacts.push(entry.facts);
      if (depth < maxDepth) {
        const childRefs = extractValidDependsOnRefs(entry.pr.body, seenKeys);
        nextLevelRefs.push(...childRefs);
      }
    }

    currentLevelRefs = nextLevelRefs;
    depth += 1;
  }

  return allFacts;
}
