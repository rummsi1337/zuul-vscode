import { type GheClient } from '../clients/gheClient';
import {
  type CheckRun,
  type CombinedStatus,
  type PrRollup,
  type PullRequest,
  type Review,
  type RollupContextNode,
} from '../clients/gheTypes';
import { type ZuulClient } from '../clients/zuulClient';
import { type Build, type Buildset, type ChangeStatus } from '../clients/zuulTypes';
import { mapWithConcurrency } from '../util/concurrency';
import { classifyJobResult, getLatestBuildsPerJob } from './buildsModel';
import { type DependsOnRef, formatPrRef, parseDependsOn, prRefKey } from './dependsOnParser';
import { extractPrCoordinates, hostOf } from './dependsOnService';
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
  | 'getRequiredContexts'
  | 'getBranchMergeRules'
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

/** Higher is worse: error, failure, missing, pending, success. */
const CHECK_STATE_SEVERITY: Record<CheckState, number> = {
  error: 4,
  failure: 3,
  missing: 2,
  pending: 1,
  success: 0,
};

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

function worseState(a: CheckState, b: CheckState): CheckState {
  return CHECK_STATE_SEVERITY[a] >= CHECK_STATE_SEVERITY[b] ? a : b;
}

function rollupHeadCommit(
  rollup: PrRollup,
): PrRollup['commits']['nodes'][number]['commit'] | undefined {
  const commitNodes = rollup.commits?.nodes ?? [];
  return commitNodes[commitNodes.length - 1]?.commit;
}

/** Adds a check, keeping the worst state and the `required` flag across same-named entries. */
function createCheckCollector(requiredNames: ReadonlySet<string>): {
  upsert: (name: string, state: CheckState, required?: boolean) => void;
  finish: () => PrGateCheck[];
} {
  const byName = new Map<string, PrGateCheck>();
  return {
    upsert: (name, state, required = false) => {
      const existing = byName.get(name);
      byName.set(name, {
        name,
        state: existing ? worseState(existing.state, state) : state,
        required: required || requiredNames.has(name) || Boolean(existing?.required),
      });
    },
    finish: () => {
      for (const reqName of requiredNames) {
        if (!byName.has(reqName)) {
          byName.set(reqName, { name: reqName, state: 'missing', required: true });
        }
      }
      return Array.from(byName.values());
    },
  };
}

function mapRollupChecks(rollup: PrRollup, requiredNames: ReadonlySet<string>): PrGateCheck[] {
  const contextNodes: RollupContextNode[] =
    rollupHeadCommit(rollup)?.statusCheckRollup?.contexts?.nodes ?? [];

  const collector = createCheckCollector(requiredNames);
  for (const node of contextNodes) {
    if (node.__typename === 'StatusContext') {
      collector.upsert(node.context, mapStatusContextState(node.state), Boolean(node.isRequired));
    } else if (node.__typename === 'CheckRun') {
      collector.upsert(
        node.name,
        mapCheckRunState(node.status, node.conclusion),
        Boolean(node.isRequired),
      );
    }
  }

  return collector.finish();
}

function mapRestChecks(
  combinedStatus: CombinedStatus,
  checkRuns: readonly CheckRun[],
  requiredNames: ReadonlySet<string>,
): PrGateCheck[] {
  const collector = createCheckCollector(requiredNames);

  for (const status of combinedStatus.statuses ?? []) {
    collector.upsert(status.context, mapStatusContextState(status.state));
  }

  for (const run of checkRuns) {
    collector.upsert(run.name, mapCheckRunState(run.status, run.conclusion));
  }

  return collector.finish();
}

const SKIPPED_REVIEW_STATES = new Set(['COMMENTED', 'PENDING']);

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
    if (SKIPPED_REVIEW_STATES.has(review.state.trim().toUpperCase())) {
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

  const allSucceeded = latestBuilds.every(
    (b) => b.voting === false || Boolean(b.result && isPassingResult(b.result)),
  );
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
  const checkStatuses = statuses.filter((s) => {
    const pipeline = s.pipeline.trim().toLowerCase();
    return s.live && (pipeline === 'check' || pipeline === '');
  });

  if (checkStatuses.length > 0) {
    const jobs = checkStatuses.flatMap((s) => s.jobs ?? []);
    if (jobs.length === 0) {
      return 'running';
    }
    // Zuul only reports once every job has finished, so an unfinished non-voting job still counts
    // as running. A failed non-voting job doesn't count.
    const hasPendingJob = jobs.some((j) => !j.result || j.result.trim().length === 0);
    if (hasPendingJob) {
      return 'running';
    }
    const allSucceeded = jobs.every(
      (j) => j.voting === false || Boolean(j.result && isPassingResult(j.result)),
    );
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

/** Zuul problems must not fail the GitHub side of the gate, so they become 'unknown'. */
async function safeZuulCheckState(
  zuul: ZuulGateClient | undefined,
  tenant: string | undefined,
  project: string,
  prNumber: number,
  sha: string,
): Promise<ZuulCheckState> {
  if (!zuul || tenant === undefined) {
    return 'unknown';
  }
  try {
    return await resolveZuulCheckState(zuul, tenant, project, prNumber, sha);
  } catch {
    return 'unknown';
  }
}

async function collectGateFactsInternal(
  ghe: GheGateClient,
  zuul: ZuulGateClient | undefined,
  tenant: string | undefined,
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

  // The fresh PR decides which commit (and base branch) the facts describe.
  const effectivePr =
    fetchFreshPr && typeof ghe.getPr === 'function'
      ? await ghe.getPr(owner, repo, prNumber).catch(() => pr)
      : pr;
  const sha = effectivePr.head.sha;
  const baseBranch = effectivePr.base.ref;

  const [rollup, reviews, zuulCheck, requiredContexts, mergeRules] = await Promise.all([
    ghe.getPrRollup(owner, repo, prNumber),
    ghe.listReviews(owner, repo, prNumber),
    safeZuulCheckState(zuul, tenant, project, prNumber, sha),
    ghe.getRequiredContexts(owner, repo, baseBranch),
    ghe.getBranchMergeRules(owner, repo, baseBranch),
  ]);

  const { approvals, changesRequested } = summarizeReviews(reviews);
  let mergeableState = effectivePr.mergeable_state ?? pr.mergeable_state;
  const requiredNames = new Set(requiredContexts ?? []);

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
    checks = mapRollupChecks(rollup, requiredNames);
    const rollupOid = rollupHeadCommit(rollup)?.oid;
    if (rollupOid && rollupOid !== sha) {
      checks.push({ name: 'Head commit changed while checking', state: 'pending', required: true });
    }
    if (rollup.mergeable === 'CONFLICTING') {
      mergeableState = 'dirty';
    }
  } else {
    draft = Boolean(effectivePr.draft);
    labels = (effectivePr.labels ?? []).map((l) => l.name);
    reviewDecision = undefined;

    const [combinedStatus, checkRuns] = await Promise.all([
      ghe.listCommitStatuses(owner, repo, sha),
      ghe.listCheckRuns(owner, repo, sha),
    ]);

    checks = mapRestChecks(combinedStatus, checkRuns, requiredNames);
  }

  const facts: PrGateFacts = {
    ref,
    ...(pr.html_url ? { url: pr.html_url } : {}),
    draft,
    merged: Boolean(effectivePr.merged),
    state: effectivePr.state,
    labels,
    approvals,
    changesRequested,
    checks,
    requiredChecksKnown: requiredContexts !== undefined,
    zuulCheck,
  };

  if (mergeableState !== undefined) {
    facts.mergeableState = mergeableState;
  }
  if (reviewDecision !== undefined) {
    facts.reviewDecision = reviewDecision;
  }
  if (mergeRules !== undefined) {
    facts.mergeRules = mergeRules;
  }

  return facts;
}

export async function collectGateFacts(
  ghe: GheGateClient,
  zuul: ZuulGateClient | undefined,
  tenant: string | undefined,
  pr: PullRequest,
): Promise<PrGateFacts> {
  return collectGateFactsInternal(ghe, zuul, tenant, pr, true);
}

interface UpstreamRef {
  host?: string;
  owner: string;
  repo: string;
  number: number;
}

function hostKey(host: string | undefined, rootHost: string | undefined): string {
  return `${host ?? rootHost ?? ''}/`;
}

function extractValidDependsOnRefs(
  body: string | null | undefined,
  seenKeys: Set<string>,
  rootHost: string | undefined,
): UpstreamRef[] {
  const parsed = parseDependsOn(body ?? null).filter(
    (ref): ref is DependsOnRef & { owner: string; repo: string; number: number } =>
      Boolean(ref.owner && ref.repo && ref.number !== undefined),
  );

  const result: UpstreamRef[] = [];
  for (const ref of parsed) {
    const key =
      hostKey(ref.host, rootHost) +
      prRefKey({ owner: ref.owner, repo: ref.repo, number: ref.number });
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      const entry: UpstreamRef = { owner: ref.owner, repo: ref.repo, number: ref.number };
      if (ref.host !== undefined) {
        entry.host = ref.host;
      }
      result.push(entry);
    }
  }
  return result;
}

/** Facts that always block: used when an upstream PR can't be checked. */
function blockingUpstreamFacts(ref: string, reason: string): PrGateFacts {
  return {
    ref,
    draft: false,
    merged: false,
    state: 'open',
    labels: [],
    approvals: 0,
    changesRequested: 0,
    checks: [{ name: reason, state: 'error', required: true }],
    requiredChecksKnown: false,
    zuulCheck: 'none',
    loadError: reason,
  };
}

export async function collectUpstreamFacts(
  ghe: GheGateClient,
  zuul: ZuulGateClient | undefined,
  tenant: string | undefined,
  rootPr: PullRequest,
  maxDepth = MAX_UPSTREAM_FACTS_DEPTH,
  concurrency = MAX_UPSTREAM_FACTS_CONCURRENCY,
): Promise<PrGateFacts[]> {
  if (rootPr.merged || maxDepth <= 0) {
    return [];
  }

  const seenKeys = new Set<string>();
  const rootHost = hostOf(rootPr.html_url);
  const rootCoords = extractPrCoordinates(rootPr);
  if (rootCoords) {
    seenKeys.add(hostKey(undefined, rootHost) + prRefKey(rootCoords));
  }

  let currentLevelRefs = extractValidDependsOnRefs(rootPr.body, seenKeys, rootHost);
  const allFacts: PrGateFacts[] = [];
  let depth = 1;

  while (currentLevelRefs.length > 0 && depth <= maxDepth) {
    const levelResults = await mapWithConcurrency(
      currentLevelRefs,
      concurrency,
      async (ref): Promise<{ pr?: PullRequest; facts: PrGateFacts } | undefined> => {
        if (ref.host && ref.host !== rootHost) {
          return {
            facts: blockingUpstreamFacts(
              formatPrRef(ref),
              `Depends-On points to another host (${ref.host})`,
            ),
          };
        }
        try {
          const upstreamPr = await ghe.getPr(ref.owner, ref.repo, ref.number);
          if (upstreamPr.merged) {
            return undefined;
          }
          const facts = await collectGateFactsInternal(ghe, zuul, tenant, upstreamPr, false);
          return { pr: upstreamPr, facts };
        } catch {
          return {
            facts: blockingUpstreamFacts(formatPrRef(ref), 'Could not read this pull request'),
          };
        }
      },
    );

    const nextLevelRefs: UpstreamRef[] = [];
    const tooDeepFacts: PrGateFacts[] = [];
    for (const entry of levelResults) {
      if (!entry) {
        continue;
      }
      allFacts.push(entry.facts);
      if (!entry.pr) {
        continue;
      }
      const childRefs = extractValidDependsOnRefs(entry.pr.body, seenKeys, rootHost);
      if (depth < maxDepth) {
        nextLevelRefs.push(...childRefs);
      } else {
        for (const childRef of childRefs) {
          tooDeepFacts.push(
            blockingUpstreamFacts(
              formatPrRef(childRef),
              `Dependency chain deeper than ${maxDepth} levels`,
            ),
          );
        }
      }
    }
    allFacts.push(...tooDeepFacts);

    currentLevelRefs = nextLevelRefs;
    depth += 1;
  }

  return allFacts;
}
