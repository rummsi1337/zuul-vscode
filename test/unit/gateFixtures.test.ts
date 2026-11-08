import { describe, expect, it, vi } from 'vitest';
import { type PrRollup, type PullRequest, type Review } from '../../src/clients/gheTypes';
import { ZuulClient } from '../../src/clients/zuulClient';
import { collectGateFacts, type GheGateClient } from '../../src/services/gateFacts';
import { evaluateGate, type GateRules } from '../../src/services/gateReadiness';
import checkRunsFixture from '../fixtures/ghe/check-runs.json';
import combinedStatusFixture from '../fixtures/ghe/combined-status.json';
import prRollupFixture from '../fixtures/ghe/pr-rollup.json';
import pullRequestFixture from '../fixtures/ghe/pull-request.json';
import requiredStatusChecksFixture from '../fixtures/ghe/required-status-checks.json';
import reviewsPage1Fixture from '../fixtures/ghe/reviews-page1.json';
import reviewsPage2Fixture from '../fixtures/ghe/reviews-page2.json';
import statusModernFixture from '../fixtures/zuul/status-modern.json';

const RULES: GateRules = {
  requiredApprovals: 1,
  requiredStatusChecks: {},
  requiredLabels: [],
  blockingLabels: [],
  gateStatusChecks: [],
};

// The fixture PR depends on another PR; this test is about the root PR only.
const PR = { ...pullRequestFixture, body: null } as unknown as PullRequest;

function fixtureGhe(rollup: PrRollup | undefined): GheGateClient {
  return {
    getPr: vi.fn(async () => PR),
    getPrRollup: vi.fn(async () => rollup),
    listCommitStatuses: vi.fn(async () => combinedStatusFixture as never),
    listCheckRuns: vi.fn(async () => checkRunsFixture.check_runs as never),
    getRequiredContexts: vi.fn(async () => requiredStatusChecksFixture.contexts),
    getBranchMergeRules: vi.fn(async () => undefined),
    listReviews: vi.fn(
      async () => [...reviewsPage1Fixture, ...reviewsPage2Fixture] as unknown as Review[],
    ),
  };
}

function fixtureZuul(statusBody: unknown): ZuulClient {
  const fetchFn = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(statusBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  return new ZuulClient('https://zuul.example.com', undefined, fetchFn);
}

const ROLLUP = prRollupFixture.data.repository.pullRequest as unknown as PrRollup;

describe('collectGateFacts and evaluateGate over real-shaped fixtures', () => {
  it('is not ready while the Zuul check still has a running job', async () => {
    const facts = await collectGateFacts(
      fixtureGhe(ROLLUP),
      fixtureZuul(statusModernFixture),
      'acme',
      PR,
    );

    expect(facts.ref).toBe('acme/service#42');
    expect(facts.approvals).toBe(2);
    expect(facts.zuulCheck).toBe('running');

    const report = evaluateGate(facts, [], RULES);
    expect(report.ready).toBe(false);
    expect(report.blockers.map((b) => b.pr)).toEqual(['acme/service#42']);
  });

  it('is ready when the Zuul check has finished successfully', async () => {
    const finished = statusModernFixture.map((item) => ({
      ...item,
      jobs: item.jobs.map((job) => ({
        ...job,
        result: 'SUCCESS',
        voting: true,
        remaining_time: 0,
      })),
    }));

    const facts = await collectGateFacts(fixtureGhe(ROLLUP), fixtureZuul(finished), 'acme', PR);
    const report = evaluateGate(facts, [], RULES);

    expect(facts.zuulCheck).toBe('success');
    expect(report.blockers).toEqual([]);
    expect(report.ready).toBe(true);
  });
});
