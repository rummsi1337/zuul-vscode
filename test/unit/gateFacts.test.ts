import { describe, expect, it, vi } from 'vitest';
import {
  type BranchMergeRules,
  type CheckRun,
  type CombinedStatus,
  type PrRollup,
  type PullRequest,
  type Review,
  type RollupContextNode,
} from '../../src/clients/gheTypes';
import { type Build, type Buildset, type ChangeStatus } from '../../src/clients/zuulTypes';
import {
  collectGateFacts,
  collectUpstreamFacts,
  type GheGateClient,
  mapCheckRunState,
  mapStatusContextState,
  summarizeReviews,
  type ZuulGateClient,
} from '../../src/services/gateFacts';

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  const owner = 'acme';
  const repo = 'service';
  const number = overrides.number ?? 42;
  return {
    number,
    html_url: `https://ghe.example.com/${owner}/${repo}/pull/${number}`,
    title: `PR #${number}`,
    state: 'open',
    draft: false,
    merged: false,
    mergeable_state: 'clean',
    body: null,
    updated_at: '2026-11-07T18:00:00Z',
    head: {
      sha: `sha-${number}`,
      ref: `branch-${number}`,
      repo: {
        full_name: `${owner}/${repo}`,
      },
    },
    base: {
      ref: 'main',
      repo: {
        full_name: `${owner}/${repo}`,
      },
    },
    user: {
      login: 'alice',
    },
    labels: [{ name: 'from-rest' }],
    ...overrides,
  };
}

function makeRollup(overrides: Partial<PrRollup> = {}): PrRollup {
  return {
    id: 'PR_kwDOAA001',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: 'APPROVED',
    labels: {
      nodes: [{ name: 'ready-for-review' }],
    },
    commits: {
      nodes: [
        {
          commit: {
            oid: 'sha-42',
            statusCheckRollup: {
              state: 'SUCCESS',
              contexts: {
                nodes: [
                  {
                    __typename: 'StatusContext',
                    context: 'acme-tenant/check',
                    state: 'SUCCESS',
                    isRequired: true,
                  },
                  {
                    __typename: 'CheckRun',
                    name: 'sonarqube',
                    conclusion: 'SUCCESS',
                    status: 'COMPLETED',
                    isRequired: true,
                  },
                  {
                    __typename: 'CheckRun',
                    name: 'optional-lint',
                    conclusion: 'NEUTRAL',
                    status: 'COMPLETED',
                    isRequired: false,
                  },
                ],
              },
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

function rollupWithContexts(nodes: RollupContextNode[], oid = 'sha-42'): PrRollup {
  return makeRollup({
    commits: {
      nodes: [{ commit: { oid, statusCheckRollup: { state: 'PENDING', contexts: { nodes } } } }],
    },
  });
}

function makeMockGhe(overrides: Partial<GheGateClient> = {}): GheGateClient {
  return {
    getPr: vi.fn(async (_owner: string, _repo: string, num: number) => makePr({ number: num })),
    getPrRollup: vi.fn(async () => makeRollup()),
    listCommitStatuses: vi.fn(async (): Promise<CombinedStatus> => ({
      state: 'success',
      statuses: [],
    })),
    listCheckRuns: vi.fn(async (): Promise<CheckRun[]> => []),
    getRequiredContexts: vi.fn(async (): Promise<string[] | undefined> => undefined),
    getBranchMergeRules: vi.fn(async (): Promise<BranchMergeRules | undefined> => undefined),
    listReviews: vi.fn(async (): Promise<Review[]> => []),
    ...overrides,
  };
}

function makeMockZuul(overrides: Partial<ZuulGateClient> = {}): ZuulGateClient {
  return {
    getChangeStatus: vi.fn(async (): Promise<ChangeStatus[]> => []),
    listBuilds: vi.fn(async (): Promise<Build[]> => []),
    listBuildsets: vi.fn(async (): Promise<Buildset[]> => []),
    ...overrides,
  };
}

describe('state mapping table', () => {
  it('maps StatusContext states to the 5 CheckStates', () => {
    expect(mapStatusContextState('SUCCESS')).toBe('success');
    expect(mapStatusContextState('NEUTRAL')).toBe('success');
    expect(mapStatusContextState('SKIPPED')).toBe('success');
    expect(mapStatusContextState('success')).toBe('success');

    expect(mapStatusContextState('PENDING')).toBe('pending');
    expect(mapStatusContextState('EXPECTED')).toBe('pending');
    expect(mapStatusContextState('QUEUED')).toBe('pending');
    expect(mapStatusContextState('IN_PROGRESS')).toBe('pending');
    expect(mapStatusContextState('pending')).toBe('pending');
    expect(mapStatusContextState(null)).toBe('pending');
    expect(mapStatusContextState(undefined)).toBe('pending');
    expect(mapStatusContextState('UNKNOWN_STATE')).toBe('pending');

    expect(mapStatusContextState('FAILURE')).toBe('failure');
    expect(mapStatusContextState('CANCELLED')).toBe('failure');
    expect(mapStatusContextState('TIMED_OUT')).toBe('failure');
    expect(mapStatusContextState('ACTION_REQUIRED')).toBe('failure');
    expect(mapStatusContextState('failure')).toBe('failure');

    expect(mapStatusContextState('ERROR')).toBe('error');
    expect(mapStatusContextState('STARTUP_FAILURE')).toBe('error');
    expect(mapStatusContextState('error')).toBe('error');

    expect(mapStatusContextState('MISSING')).toBe('missing');
  });

  it('maps CheckRun status and conclusion to the 5 CheckStates', () => {
    // Success conclusions
    expect(mapCheckRunState('COMPLETED', 'SUCCESS')).toBe('success');
    expect(mapCheckRunState('COMPLETED', 'NEUTRAL')).toBe('success');
    expect(mapCheckRunState('COMPLETED', 'SKIPPED')).toBe('success');
    expect(mapCheckRunState('completed', 'success')).toBe('success');

    // Pending statuses
    expect(mapCheckRunState('PENDING', null)).toBe('pending');
    expect(mapCheckRunState('EXPECTED', null)).toBe('pending');
    expect(mapCheckRunState('QUEUED', null)).toBe('pending');
    expect(mapCheckRunState('IN_PROGRESS', null)).toBe('pending');
    expect(mapCheckRunState('in_progress', 'SUCCESS')).toBe('pending');
    expect(mapCheckRunState(null, null)).toBe('pending');
    expect(mapCheckRunState('COMPLETED', null)).toBe('pending');

    // Failure conclusions
    expect(mapCheckRunState('COMPLETED', 'FAILURE')).toBe('failure');
    expect(mapCheckRunState('COMPLETED', 'CANCELLED')).toBe('failure');
    expect(mapCheckRunState('COMPLETED', 'TIMED_OUT')).toBe('failure');
    expect(mapCheckRunState('COMPLETED', 'ACTION_REQUIRED')).toBe('failure');

    // Error conclusions
    expect(mapCheckRunState('COMPLETED', 'ERROR')).toBe('error');
    expect(mapCheckRunState('COMPLETED', 'STARTUP_FAILURE')).toBe('error');
  });
});

describe('summarizeReviews (latest review per user)', () => {
  it('keeps only the latest review per user and counts APPROVED and CHANGES_REQUESTED', () => {
    const reviews: Review[] = [
      // bob: COMMENTED then APPROVED -> counts as 1 approval
      { id: 1, user: { login: 'bob' }, state: 'COMMENTED', submitted_at: '2026-11-07T10:00:00Z' },
      { id: 2, user: { login: 'bob' }, state: 'APPROVED', submitted_at: '2026-11-07T11:00:00Z' },
      // carol: APPROVED then CHANGES_REQUESTED -> counts as 1 changes_requested, not approval
      { id: 3, user: { login: 'carol' }, state: 'APPROVED', submitted_at: '2026-11-07T09:00:00Z' },
      {
        id: 4,
        user: { login: 'carol' },
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-11-07T12:00:00Z',
      },
      // dave: CHANGES_REQUESTED then DISMISSED -> counts as neither
      {
        id: 5,
        user: { login: 'dave' },
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-11-07T08:00:00Z',
      },
      { id: 6, user: { login: 'dave' }, state: 'DISMISSED', submitted_at: '2026-11-07T13:00:00Z' },
      // eve: out-of-order array but earlier timestamp does not overwrite later timestamp
      { id: 8, user: { login: 'eve' }, state: 'APPROVED', submitted_at: '2026-11-07T15:00:00Z' },
      {
        id: 7,
        user: { login: 'eve' },
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-11-07T14:00:00Z',
      },
      // frank: no submitted_at, falls back to id/order (CHANGES_REQUESTED -> APPROVED)
      { id: 10, user: { login: 'frank' }, state: 'CHANGES_REQUESTED' },
      { id: 11, user: { login: 'frank' }, state: 'APPROVED' },
      // null user: ignored
      { id: 12, user: null, state: 'APPROVED', submitted_at: '2026-11-07T16:00:00Z' },
    ];

    expect(summarizeReviews(reviews)).toEqual({
      approvals: 3, // bob, eve, frank
      changesRequested: 1, // carol
    });
  });

  it('keeps approval when followed by COMMENTED', () => {
    const reviews: Review[] = [
      { id: 1, user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2026-11-07T10:00:00Z' },
      { id: 2, user: { login: 'alice' }, state: 'COMMENTED', submitted_at: '2026-11-07T11:00:00Z' },
    ];
    expect(summarizeReviews(reviews)).toEqual({ approvals: 1, changesRequested: 0 });
  });

  it('keeps changes requested when followed by COMMENTED', () => {
    const reviews: Review[] = [
      {
        id: 1,
        user: { login: 'bob' },
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-11-07T10:00:00Z',
      },
      { id: 2, user: { login: 'bob' }, state: 'COMMENTED', submitted_at: '2026-11-07T11:00:00Z' },
    ];
    expect(summarizeReviews(reviews)).toEqual({ approvals: 0, changesRequested: 1 });
  });
});

describe('collectGateFacts', () => {
  it('collects facts via GraphQL getPrRollup path', async () => {
    const pr = makePr({
      number: 42,
      draft: true, // overridden by rollup.isDraft = false
      mergeable_state: undefined, // fetched from getPr
    });

    const ghe = makeMockGhe({
      getPr: vi.fn(async () => makePr({ number: 42, mergeable_state: 'blocked' })),
      getRequiredContexts: vi.fn(async () => ['zuul/check', 'security-scan']),
      getPrRollup: vi.fn(async () =>
        makeRollup({
          isDraft: false,
          reviewDecision: 'APPROVED',
          labels: { nodes: [{ name: 'verified' }, { name: 'ship-it' }] },
          commits: {
            nodes: [
              {
                commit: {
                  oid: 'sha-42',
                  statusCheckRollup: {
                    state: 'PENDING',
                    contexts: {
                      nodes: [
                        {
                          __typename: 'StatusContext',
                          context: 'zuul/check',
                          state: 'SUCCESS',
                          isRequired: true,
                        },
                        {
                          __typename: 'CheckRun',
                          name: 'security-scan',
                          status: 'IN_PROGRESS',
                          conclusion: null,
                          isRequired: true,
                        },
                        {
                          __typename: 'CheckRun',
                          name: 'flake-job',
                          status: 'COMPLETED',
                          conclusion: 'TIMED_OUT',
                          isRequired: false,
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        }),
      ),
      listReviews: vi.fn(async () => [
        { id: 1, user: { login: 'bob' }, state: 'COMMENTED', submitted_at: '2026-11-07T10:00:00Z' },
        { id: 2, user: { login: 'bob' }, state: 'APPROVED', submitted_at: '2026-11-07T11:00:00Z' },
        {
          id: 3,
          user: { login: 'carol' },
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-11-07T12:00:00Z',
        },
      ]),
    });

    const zuul = makeMockZuul({
      getChangeStatus: vi.fn(async () => [
        {
          pipeline: 'check',
          queue: 'shared',
          live: true,
          jobs: [
            { name: 'lint', running: false, result: 'SUCCESS' },
            { name: 'unit', running: false, result: 'SKIPPED' },
          ],
          itemsAhead: [],
        },
      ]),
    });

    const facts = await collectGateFacts(ghe, zuul, 'acme-tenant', pr);

    expect(facts).toEqual({
      ref: 'acme/service#42',
      draft: false,
      merged: false,
      state: 'open',
      mergeableState: 'blocked',
      labels: ['verified', 'ship-it'],
      reviewDecision: 'APPROVED',
      approvals: 1,
      changesRequested: 1,
      checks: [
        { name: 'zuul/check', state: 'success', required: true },
        { name: 'security-scan', state: 'pending', required: true },
        { name: 'flake-job', state: 'failure', required: false },
      ],
      requiredChecksKnown: true,
      zuulCheck: 'success',
    });

    expect(ghe.listCommitStatuses).not.toHaveBeenCalled();
    expect(ghe.listCheckRuns).not.toHaveBeenCalled();
    expect(ghe.getRequiredContexts).toHaveBeenCalledWith('acme', 'service', 'main');
  });

  it('falls back to REST endpoints when getPrRollup returns undefined', async () => {
    const pr = makePr({
      number: 42,
      draft: true,
      mergeable_state: 'dirty',
      labels: [{ name: 'wip' }, { name: 'backend' }],
    });

    const ghe = makeMockGhe({
      getPr: vi.fn(async () => pr),
      getPrRollup: vi.fn(async () => undefined),
      listCommitStatuses: vi.fn(async () => ({
        state: 'pending',
        statuses: [
          { context: 'acme-tenant/check', state: 'success' },
          { context: 'cla/enterprise', state: 'error' },
        ],
      })),
      listCheckRuns: vi.fn(async () => [
        { id: 1, name: 'sonarqube', status: 'completed', conclusion: 'failure' },
        { id: 2, name: 'codeql', status: 'queued', conclusion: null },
      ]),
      getRequiredContexts: vi.fn(async () => [
        'acme-tenant/check',
        'missing-status-context',
        'sonarqube',
        'missing-check-run',
      ]),
      listReviews: vi.fn(async () => [
        { id: 10, user: { login: 'bob' }, state: 'APPROVED' },
        { id: 11, user: { login: 'carol' }, state: 'APPROVED' },
      ]),
    });

    const zuul = makeMockZuul();

    const facts = await collectGateFacts(ghe, zuul, 'acme-tenant', pr);

    expect(facts).toEqual({
      ref: 'acme/service#42',
      draft: true,
      merged: false,
      state: 'open',
      mergeableState: 'dirty',
      labels: ['wip', 'backend'],
      approvals: 2,
      changesRequested: 0,
      checks: [
        { name: 'acme-tenant/check', state: 'success', required: true },
        { name: 'cla/enterprise', state: 'error', required: false },
        { name: 'sonarqube', state: 'failure', required: true },
        { name: 'codeql', state: 'pending', required: false },
        { name: 'missing-status-context', state: 'missing', required: true },
        { name: 'missing-check-run', state: 'missing', required: true },
      ],
      requiredChecksKnown: true,
      zuulCheck: 'none',
    });

    expect(facts.reviewDecision).toBeUndefined();
    expect(ghe.listCommitStatuses).toHaveBeenCalledWith('acme', 'service', 'sha-42');
    expect(ghe.listCheckRuns).toHaveBeenCalledWith('acme', 'service', 'sha-42');
    expect(ghe.getRequiredContexts).toHaveBeenCalledWith('acme', 'service', 'main');
  });

  it('computes zuulCheck from getChangeStatus, listBuilds, and listBuildsets', async () => {
    const pr = makePr({ number: 42 });
    const ghe = makeMockGhe();

    // 1. Running when check status has a job without result
    const zuulRunning = makeMockZuul({
      getChangeStatus: vi.fn(async () => [
        {
          pipeline: 'check',
          queue: 'shared',
          live: true,
          jobs: [
            { name: 'lint', running: false, result: 'SUCCESS' },
            { name: 'unit', running: true },
          ],
          itemsAhead: [],
        },
      ]),
    });
    expect((await collectGateFacts(ghe, zuulRunning, 'tenant', pr)).zuulCheck).toBe('running');

    // 2. Failure when check status jobs all finished and one failed
    const zuulStatusFail = makeMockZuul({
      getChangeStatus: vi.fn(async () => [
        {
          pipeline: 'check',
          queue: 'shared',
          live: true,
          jobs: [
            { name: 'lint', running: false, result: 'SUCCESS' },
            { name: 'unit', running: false, result: 'FAILURE' },
          ],
          itemsAhead: [],
        },
      ]),
    });
    expect((await collectGateFacts(ghe, zuulStatusFail, 'tenant', pr)).zuulCheck).toBe('failure');

    // 3. Fallback to listBuilds: latest build per job succeeds (re-run after failure)
    const zuulBuildsSuccess = makeMockZuul({
      getChangeStatus: vi.fn(async () => []),
      listBuilds: vi.fn(async () => [
        {
          uuid: 'b1',
          jobName: 'unit',
          pipeline: 'check',
          result: 'FAILURE',
          startTime: '2026-11-07T10:00:00Z',
          endTime: '2026-11-07T10:05:00Z',
          patchset: 'sha-42',
          artifacts: [],
        },
        {
          uuid: 'b2',
          jobName: 'unit',
          pipeline: 'check',
          result: 'SUCCESS',
          startTime: '2026-11-07T11:00:00Z',
          endTime: '2026-11-07T11:05:00Z',
          patchset: 'sha-42',
          artifacts: [],
        },
        {
          uuid: 'b3',
          jobName: 'lint',
          pipeline: 'check',
          result: 'SUCCESS',
          startTime: '2026-11-07T11:00:00Z',
          endTime: '2026-11-07T11:02:00Z',
          patchset: 'sha-42',
          artifacts: [],
        },
      ]),
    });
    expect((await collectGateFacts(ghe, zuulBuildsSuccess, 'tenant', pr)).zuulCheck).toBe(
      'success',
    );

    // 4. Fallback to listBuilds: failure when latest build for a job failed
    const zuulBuildsFail = makeMockZuul({
      getChangeStatus: vi.fn(async () => []),
      listBuilds: vi.fn(async () => [
        {
          uuid: 'b1',
          jobName: 'unit',
          pipeline: 'check',
          result: 'FAILURE',
          patchset: 'sha-42',
          artifacts: [],
        },
      ]),
    });
    expect((await collectGateFacts(ghe, zuulBuildsFail, 'tenant', pr)).zuulCheck).toBe('failure');

    // 5. Fallback to listBuildsets when listBuilds returns empty
    const zuulBuildsetsSuccess = makeMockZuul({
      getChangeStatus: vi.fn(async () => []),
      listBuilds: vi.fn(async () => []),
      listBuildsets: vi.fn(async () => [
        {
          uuid: 'bs1',
          pipeline: 'check',
          result: 'SUCCESS',
          patchset: 'sha-42',
        },
      ]),
    });
    expect((await collectGateFacts(ghe, zuulBuildsetsSuccess, 'tenant', pr)).zuulCheck).toBe(
      'success',
    );

    // 6. Empty jobs in check status -> running; build without result -> running; buildset with builds & no result
    const zuulEmptyJobs = makeMockZuul({
      getChangeStatus: vi.fn(async () => [
        { pipeline: 'check', queue: 'shared', live: true, jobs: [], itemsAhead: [] },
      ]),
    });
    expect((await collectGateFacts(ghe, zuulEmptyJobs, 'tenant', pr)).zuulCheck).toBe('running');

    const zuulRunningBuild = makeMockZuul({
      getChangeStatus: vi.fn(async () => []),
      listBuilds: vi.fn(async () => [
        {
          uuid: 'b1',
          jobName: 'unit',
          pipeline: 'check',
          startTime: '2026-11-07T11:00:00Z',
          patchset: 'sha-42',
          artifacts: [],
        },
      ]),
    });
    expect((await collectGateFacts(ghe, zuulRunningBuild, 'tenant', pr)).zuulCheck).toBe('running');

    const zuulBuildsetWithBuilds = makeMockZuul({
      getChangeStatus: vi.fn(async () => []),
      listBuilds: undefined,
      listBuildsets: vi.fn(async () => [
        {
          uuid: 'bs-with-builds',
          pipeline: 'check',
          patchset: 'sha-42',
          builds: [
            {
              uuid: 'b1',
              jobName: 'unit',
              pipeline: 'check',
              result: 'FAILURE',
              artifacts: [],
            },
          ],
        },
      ]),
    });
    expect((await collectGateFacts(ghe, zuulBuildsetWithBuilds, 'tenant', pr)).zuulCheck).toBe(
      'failure',
    );

    const zuulBuildsetRunning = makeMockZuul({
      getChangeStatus: vi.fn(async () => []),
      listBuilds: undefined,
      listBuildsets: vi.fn(async () => [
        {
          uuid: 'bs-running',
          pipeline: 'check',
          patchset: 'sha-42',
        },
      ]),
    });
    expect((await collectGateFacts(ghe, zuulBuildsetRunning, 'tenant', pr)).zuulCheck).toBe(
      'running',
    );
  });

  it('gracefully falls back to passed PR when getPr rejects', async () => {
    const pr = makePr({ number: 42, mergeable_state: 'clean' });
    const ghe = makeMockGhe({
      getPr: vi.fn(async () => {
        throw new Error('network error');
      }),
    });
    const zuul = makeMockZuul();

    const facts = await collectGateFacts(ghe, zuul, 'tenant', pr);
    expect(facts.mergeableState).toBe('clean');
  });

  it('adds missing entries for unreported required checks on the rollup path', async () => {
    const pr = makePr({ number: 42 });
    const ghe = makeMockGhe({
      getPr: vi.fn(async () => pr),
      getRequiredContexts: vi.fn(async () => ['reported-check', 'unreported-check']),
      getPrRollup: vi.fn(async () =>
        makeRollup({
          commits: {
            nodes: [
              {
                commit: {
                  oid: 'sha-42',
                  statusCheckRollup: {
                    state: 'SUCCESS',
                    contexts: {
                      nodes: [
                        {
                          __typename: 'StatusContext',
                          context: 'reported-check',
                          state: 'SUCCESS',
                          isRequired: true,
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        }),
      ),
    });
    const zuul = makeMockZuul();

    const facts = await collectGateFacts(ghe, zuul, 'tenant', pr);
    expect(facts.requiredChecksKnown).toBe(true);
    expect(facts.checks).toContainEqual({
      name: 'unreported-check',
      state: 'missing',
      required: true,
    });
  });

  it('ignores non-voting failures in zuulCheck', async () => {
    const pr = makePr({ number: 42 });
    const ghe = makeMockGhe({ getPr: vi.fn(async () => pr) });
    const zuulStatuses = makeMockZuul({
      getChangeStatus: vi.fn(async () => [
        {
          pipeline: 'check',
          queue: 'shared',
          live: true,
          jobs: [
            { name: 'voting-job', running: false, result: 'SUCCESS', voting: true },
            { name: 'non-voting-job', running: false, result: 'FAILURE', voting: false },
          ],
          itemsAhead: [],
        },
      ]),
    });

    const factsStatus = await collectGateFacts(ghe, zuulStatuses, 'tenant', pr);
    expect(factsStatus.zuulCheck).toBe('success');

    const zuulBuilds = makeMockZuul({
      getChangeStatus: vi.fn(async () => []),
      listBuilds: vi.fn(async () => [
        {
          uuid: 'b1',
          jobName: 'voting-build',
          pipeline: 'check',
          result: 'SUCCESS',
          voting: true,
          patchset: 'sha-42',
          artifacts: [],
        },
        {
          uuid: 'b2',
          jobName: 'non-voting-build',
          pipeline: 'check',
          result: 'FAILURE',
          voting: false,
          patchset: 'sha-42',
          artifacts: [],
        },
      ]),
    });

    const factsBuilds = await collectGateFacts(ghe, zuulBuilds, 'tenant', pr);
    expect(factsBuilds.zuulCheck).toBe('success');
  });

  it('keeps zuulCheck running until a non-voting job has finished', async () => {
    const pr = makePr({ number: 42 });
    const ghe = makeMockGhe({ getPr: vi.fn(async () => pr) });
    const zuul = makeMockZuul({
      getChangeStatus: vi.fn(async () => [
        {
          pipeline: 'check',
          queue: 'shared',
          live: true,
          jobs: [
            { name: 'voting-job', running: false, result: 'SUCCESS', voting: true },
            { name: 'non-voting-job', running: true, voting: false },
          ],
          itemsAhead: [],
        },
      ]),
    });

    expect((await collectGateFacts(ghe, zuul, 'tenant', pr)).zuulCheck).toBe('running');
  });

  it('only counts live Zuul items in the check pipeline or with no pipeline', async () => {
    const pr = makePr({ number: 42 });
    const ghe = makeMockGhe({ getPr: vi.fn(async () => pr) });
    const zuulCheckFor = async (status: Partial<ChangeStatus>): Promise<string | undefined> => {
      const zuul = makeMockZuul({
        getChangeStatus: vi.fn(async () => [
          {
            pipeline: 'check',
            queue: '',
            live: true,
            jobs: [{ name: 'j', running: false, result: 'FAILURE', voting: true }],
            itemsAhead: [],
            ...status,
          },
        ]),
        listBuilds: vi.fn(async () => [
          {
            uuid: 'b',
            jobName: 'j',
            pipeline: 'check',
            result: 'SUCCESS',
            voting: true,
            patchset: 'sha-42',
            artifacts: [],
          },
        ]),
      });
      return (await collectGateFacts(ghe, zuul, 'tenant', pr)).zuulCheck;
    };

    expect(await zuulCheckFor({})).toBe('failure');
    expect(await zuulCheckFor({ pipeline: '' })).toBe('failure');
    expect(await zuulCheckFor({ live: false })).toBe('success');
    expect(await zuulCheckFor({ pipeline: 'gate' })).toBe('success');
  });

  it('counts a CONFLICTING rollup as dirty', async () => {
    const pr = makePr({ number: 42, mergeable_state: 'blocked' });
    const ghe = makeMockGhe({
      getPr: vi.fn(async () => pr),
      getPrRollup: vi.fn(async () => makeRollup({ mergeable: 'CONFLICTING' })),
    });

    const facts = await collectGateFacts(ghe, makeMockZuul(), 'tenant', pr);
    expect(facts.mergeableState).toBe('dirty');
  });

  it('keeps the worst state for same-named checks on both paths', async () => {
    const pr = makePr({ number: 42 });
    const passed: RollupContextNode = {
      __typename: 'StatusContext',
      context: 'ci',
      state: 'SUCCESS',
      isRequired: true,
    };
    const failed: RollupContextNode = {
      __typename: 'CheckRun',
      name: 'ci',
      conclusion: 'FAILURE',
      status: 'COMPLETED',
      isRequired: false,
    };

    for (const nodes of [
      [passed, failed],
      [failed, passed],
    ]) {
      const ghe = makeMockGhe({
        getPr: vi.fn(async () => pr),
        getPrRollup: vi.fn(async () => rollupWithContexts(nodes)),
      });
      const facts = await collectGateFacts(ghe, makeMockZuul(), 'tenant', pr);
      expect(facts.checks).toEqual([{ name: 'ci', state: 'failure', required: true }]);
    }

    const restGhe = makeMockGhe({
      getPr: vi.fn(async () => pr),
      getPrRollup: vi.fn(async () => undefined),
      listCommitStatuses: vi.fn(async () => ({
        state: 'failure',
        statuses: [{ context: 'ci', state: 'failure' }],
      })),
      listCheckRuns: vi.fn(async () => [
        { name: 'ci', status: 'completed', conclusion: 'success' },
      ]),
    });
    const restFacts = await collectGateFacts(restGhe, makeMockZuul(), 'tenant', pr);
    expect(restFacts.checks).toEqual([{ name: 'ci', state: 'failure', required: false }]);
  });

  it('adds a required pending check when the head commit moves while checking', async () => {
    const pr = makePr({ number: 42 });
    const marker = { name: 'Head commit changed while checking', state: 'pending', required: true };

    const moved = makeMockGhe({
      getPr: vi.fn(async () => pr),
      getPrRollup: vi.fn(async () => rollupWithContexts([], 'sha-newer')),
    });
    expect((await collectGateFacts(moved, makeMockZuul(), 'tenant', pr)).checks).toContainEqual(
      marker,
    );

    const same = makeMockGhe({
      getPr: vi.fn(async () => pr),
      getPrRollup: vi.fn(async () => rollupWithContexts([])),
    });
    expect((await collectGateFacts(same, makeMockZuul(), 'tenant', pr)).checks).not.toContainEqual(
      marker,
    );
  });

  it('reads the merge rules of the fresh base branch', async () => {
    const pr = makePr({ number: 42 });
    const fresh = makePr({ number: 42, base: { ...pr.base, ref: 'release' } });
    const mergeRules: BranchMergeRules = {
      requiredApprovingReviewCount: 2,
      requiresConversationResolution: true,
      requiresSignatures: false,
    };
    const getBranchMergeRules = vi.fn(async () => mergeRules);
    const ghe = makeMockGhe({ getPr: vi.fn(async () => fresh), getBranchMergeRules });

    const facts = await collectGateFacts(ghe, makeMockZuul(), 'tenant', pr);

    expect(getBranchMergeRules).toHaveBeenCalledWith('acme', 'service', 'release');
    expect(facts.mergeRules).toEqual(mergeRules);
  });
});

describe('collectUpstreamFacts hosts', () => {
  const local = 'https://ghe.example.com/acme/service/pull/2';

  it('reads the local ref and blocks on a foreign ref with the same path', async () => {
    const rootPr = makePr({
      number: 1,
      body: `Depends-On: ${local}\nDepends-On: https://other.example.com/acme/service/pull/2`,
    });
    const getPr = vi.fn(async (_o: string, _r: string, num: number) =>
      makePr({ number: num, merged: true, state: 'closed' }),
    );
    const facts = await collectUpstreamFacts(makeMockGhe({ getPr }), makeMockZuul(), 't', rootPr);
    expect(getPr).toHaveBeenCalledTimes(1);
    expect(facts).toHaveLength(1);
    expect(facts[0].loadError).toContain('other.example.com');
  });

  it.each([
    ['absent', undefined],
    ['malformed', 'not a url'],
  ])('fails closed when the root html_url is %s', async (_name, htmlUrl) => {
    const rootPr = { ...makePr({ number: 1, body: `Depends-On: ${local}` }) } as PullRequest;
    (rootPr as { html_url?: string }).html_url = htmlUrl;
    const getPr = vi.fn();
    const facts = await collectUpstreamFacts(makeMockGhe({ getPr }), makeMockZuul(), 't', rootPr);
    expect(getPr).not.toHaveBeenCalled();
    expect(facts).toHaveLength(1);
    expect(facts[0].checks[0]).toMatchObject({ state: 'error', required: true });
  });
});

describe('collectUpstreamFacts', () => {
  it('gives blocking facts for a Depends-On on another host without fetching it', async () => {
    const rootPr = makePr({
      number: 1,
      body: 'Depends-On: https://other.example.com/acme/service/pull/2',
    });
    const getPr = vi.fn();
    const facts = await collectUpstreamFacts(
      makeMockGhe({ getPr }),
      makeMockZuul(),
      'acme-tenant',
      rootPr,
    );
    expect(getPr).not.toHaveBeenCalled();
    expect(facts).toHaveLength(1);
    expect(facts[0].loadError).toContain('other.example.com');
    expect(facts[0].checks[0]).toMatchObject({ state: 'error', required: true });
  });

  it('recursively collects non-merged upstream PRs, skips merged PRs, and dedupes refs', async () => {
    const rootPr = makePr({
      number: 1,
      body: [
        'Depends-On: https://ghe.example.com/acme/service/pull/2',
        'Depends-On: https://ghe.example.com/acme/service/pull/3',
        'Depends-On: https://ghe.example.com/acme/service/pull/2', // duplicate in same body
      ].join('\n'),
    });

    const prByNumber = new Map<number, PullRequest>([
      [
        2,
        makePr({
          number: 2,
          merged: false,
          // Depends on #4 (open), #3 (already queued at level 1), and #1 (cycle to root)
          body: [
            'Depends-On: https://ghe.example.com/acme/service/pull/4',
            'Depends-On: https://ghe.example.com/acme/service/pull/3',
            'Depends-On: https://ghe.example.com/acme/service/pull/1',
          ].join('\n'),
        }),
      ],
      [
        3,
        makePr({
          number: 3,
          merged: true,
          state: 'closed',
          // Merged PR's Depends-On (#99) must NOT be visited
          body: 'Depends-On: https://ghe.example.com/acme/service/pull/99',
        }),
      ],
      [
        4,
        makePr({
          number: 4,
          merged: false,
          body: null,
        }),
      ],
    ]);

    const getPr = vi.fn(async (_owner: string, _repo: string, num: number) => {
      const found = prByNumber.get(num);
      if (!found) {
        throw new Error(`Unexpected PR #${num}`);
      }
      return found;
    });

    const ghe = makeMockGhe({ getPr });
    const zuul = makeMockZuul();

    const upstreamFacts = await collectUpstreamFacts(ghe, zuul, 'acme-tenant', rootPr);

    expect(upstreamFacts.map((f) => f.ref)).toEqual(['acme/service#2', 'acme/service#4']);
    expect(getPr).toHaveBeenCalledTimes(3); // #2, #3, #4 (never #1 or #99, and #2/#3 only once)
  });

  it('stops recursion at depth 5', async () => {
    // Chain: root (#0) -> #1 -> #2 -> #3 -> #4 -> #5 -> #6
    const rootPr = makePr({
      number: 0,
      body: 'Depends-On: https://ghe.example.com/acme/service/pull/1',
    });

    const getPr = vi.fn(async (_owner: string, _repo: string, num: number) =>
      makePr({
        number: num,
        body: `Depends-On: https://ghe.example.com/acme/service/pull/${num + 1}`,
      }),
    );

    const ghe = makeMockGhe({ getPr });
    const zuul = makeMockZuul();

    const upstreamFacts = await collectUpstreamFacts(ghe, zuul, 'acme-tenant', rootPr);

    expect(upstreamFacts.map((f) => f.ref)).toEqual([
      'acme/service#1',
      'acme/service#2',
      'acme/service#3',
      'acme/service#4',
      'acme/service#5',
      'acme/service#6',
    ]);
    expect(upstreamFacts[5]?.checks).toEqual([
      { name: 'Dependency chain deeper than 5 levels', state: 'error', required: true },
    ]);
    expect(getPr).toHaveBeenCalledTimes(5);
  });

  it('limits concurrency to 5 parallel tasks', async () => {
    const depLines = Array.from(
      { length: 12 },
      (_, i) => `Depends-On: https://ghe.example.com/acme/service/pull/${i + 10}`,
    ).join('\n');
    const rootPr = makePr({ number: 1, body: depLines });

    let active = 0;
    let maxActive = 0;

    const getPr = vi.fn(async (_owner: string, _repo: string, num: number) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return makePr({ number: num });
    });

    const ghe = makeMockGhe({ getPr });
    const zuul = makeMockZuul();

    const facts = await collectUpstreamFacts(ghe, zuul, 'acme-tenant', rootPr);

    expect(facts).toHaveLength(12);
    expect(maxActive).toBeLessThanOrEqual(5);
    expect(maxActive).toBeGreaterThan(1);
  });

  it('handles merged root PR, empty Depends-On, and missing upstream PRs', async () => {
    const ghe = makeMockGhe({
      getPr: vi.fn(async (_o: string, _r: string, num: number) => {
        if (num === 404) {
          throw new Error('404 Not Found');
        }
        return makePr({ number: num });
      }),
    });
    const zuul = makeMockZuul();

    expect(
      await collectUpstreamFacts(ghe, zuul, 'tenant', makePr({ number: 1, merged: true })),
    ).toEqual([]);

    expect(
      await collectUpstreamFacts(ghe, zuul, 'tenant', makePr({ number: 1, body: null })),
    ).toEqual([]);

    const withMissing = await collectUpstreamFacts(
      ghe,
      zuul,
      'tenant',
      makePr({
        number: 1,
        body: [
          'Depends-On: https://ghe.example.com/acme/service/pull/404',
          'Depends-On: https://ghe.example.com/acme/service/pull/2',
        ].join('\n'),
      }),
    );
    expect(withMissing.map((f) => f.ref)).toEqual(['acme/service#404', 'acme/service#2']);
    expect(withMissing[0]?.checks).toEqual([
      { name: 'Could not read this pull request', state: 'error', required: true },
    ]);
  });

  it('returns a blocker when an upstream PR request fails with 500', async () => {
    const ghe = makeMockGhe({
      getPr: vi.fn(async () => {
        throw new Error('500 Internal Server Error');
      }),
    });
    const zuul = makeMockZuul();
    const facts = await collectUpstreamFacts(
      ghe,
      zuul,
      'tenant',
      makePr({
        number: 1,
        body: 'Depends-On: https://ghe.example.com/acme/service/pull/500',
      }),
    );
    expect(facts).toEqual([
      {
        ref: 'acme/service#500',
        draft: false,
        merged: false,
        state: 'open',
        labels: [],
        approvals: 0,
        changesRequested: 0,
        checks: [{ name: 'Could not read this pull request', state: 'error', required: true }],
        requiredChecksKnown: false,
        zuulCheck: 'none',
        loadError: 'Could not read this pull request',
      },
    ]);
  });
});
