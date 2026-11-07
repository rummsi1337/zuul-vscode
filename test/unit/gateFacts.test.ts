import { describe, expect, it, vi } from 'vitest';
import {
  type CheckRun,
  type CombinedStatus,
  type PrRollup,
  type PullRequest,
  type RequiredStatusChecks,
  type Review,
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

function makeMockGhe(overrides: Partial<GheGateClient> = {}): GheGateClient {
  return {
    getPr: vi.fn(async (_owner: string, _repo: string, num: number) => makePr({ number: num })),
    getPrRollup: vi.fn(async () => makeRollup()),
    listCommitStatuses: vi.fn(async (): Promise<CombinedStatus> => ({
      state: 'success',
      statuses: [],
    })),
    listCheckRuns: vi.fn(async (): Promise<CheckRun[]> => []),
    getRequiredStatusChecks: vi.fn(
      async (): Promise<RequiredStatusChecks | undefined> => undefined,
    ),
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
      zuulCheck: 'success',
    });

    expect(ghe.listCommitStatuses).not.toHaveBeenCalled();
    expect(ghe.listCheckRuns).not.toHaveBeenCalled();
    expect(ghe.getRequiredStatusChecks).not.toHaveBeenCalled();
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
      getRequiredStatusChecks: vi.fn(async () => ({
        strict: true,
        contexts: ['acme-tenant/check', 'missing-status-context'],
        checks: [{ context: 'sonarqube', app_id: 12 }, { context: 'missing-check-run' }],
      })),
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
      zuulCheck: 'none',
    });

    expect(facts.reviewDecision).toBeUndefined();
    expect(ghe.listCommitStatuses).toHaveBeenCalledWith('acme', 'service', 'sha-42');
    expect(ghe.listCheckRuns).toHaveBeenCalledWith('acme', 'service', 'sha-42');
    expect(ghe.getRequiredStatusChecks).toHaveBeenCalledWith('acme', 'service', 'main');
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
});

describe('collectUpstreamFacts', () => {
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
    expect(withMissing.map((f) => f.ref)).toEqual(['acme/service#2']);
  });
});
