import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'vscode';
import { type PullRequest, type Review } from '../../src/clients/gheTypes';
import { type ResolvedContext } from '../../src/context/zuulContext';
import { type GateReport, type GateRules } from '../../src/services/gateReadiness';
import { type PrSnapshot } from '../../src/services/prTracker';
import {
  GATE_REFRESH_MIN_INTERVAL_MS,
  PrGateTreeDataProvider,
} from '../../src/views/prGateTreeView';
import { createFakeLogger } from '../helpers';

const PR: PullRequest = {
  number: 42,
  html_url: 'https://ghe.example.com/acme/service/pull/42',
  title: 'PR',
  state: 'open',
  draft: false,
  merged: false,
  mergeable_state: 'clean',
  body: null,
  updated_at: '2026-11-08T00:00:00Z',
  head: { sha: 'sha-42', ref: 'feature', repo: { full_name: 'acme/service' } },
  base: { ref: 'main', repo: { full_name: 'acme/service' } },
  user: { login: 'alice' },
  labels: [],
};

const RULES: GateRules = {
  requiredApprovals: 0,
  requiredStatusChecks: {},
  requiredLabels: [],
  blockingLabels: [],
  gateStatusChecks: ['{tenant}/gate'],
};

function setup() {
  let time = 0;
  let rules = RULES;
  const listReviews = vi.fn(async (): Promise<Review[]> => []);
  const context = {
    host: 'ghe.example.com',
    owner: 'acme',
    repo: 'service',
    tenant: 'acme-tenant',
    ghe: {
      getPr: vi.fn(async () => PR),
      getPrRollup: vi.fn(async () => undefined),
      listCommitStatuses: vi.fn(async () => ({ state: 'success', statuses: [] })),
      listCheckRuns: vi.fn(async () => []),
      getRequiredContexts: vi.fn(async () => []),
      getBranchMergeRules: vi.fn(async () => undefined),
      listReviews,
    },
    zuul: {
      getChangeStatus: vi.fn(async () => [
        {
          pipeline: 'check',
          queue: '',
          live: true,
          jobs: [{ name: 'j', running: false, result: 'SUCCESS', voting: true }],
          itemsAhead: [],
        },
      ]),
    },
  } as unknown as ResolvedContext;
  const ctx = { current: context };
  const snapshot: PrSnapshot = { pr: PR, statuses: [], builds: [], fetchedAt: 0 };
  const provider = new PrGateTreeDataProvider(
    { snapshot, onDidChange: new EventEmitter<PrSnapshot | undefined>().event },
    ctx,
    () => rules,
    createFakeLogger(),
    () => time,
  );

  return {
    provider,
    listReviews,
    advance: (ms: number): void => {
      time += ms;
    },
    setRules: (next: Partial<GateRules>): void => {
      rules = { ...RULES, ...next };
    },
    moveTo: (next: Partial<ResolvedContext>): void => {
      ctx.current = { ...context, ...next };
    },
  };
}

async function currentReport(provider: PrGateTreeDataProvider): Promise<GateReport> {
  const [header] = await provider.getChildren();
  if (header?.kind !== 'header') {
    throw new Error('expected a header node');
  }
  return header.report;
}

describe('PrGateTreeDataProvider', () => {
  it('shows a load failure instead of an older Ready report', async () => {
    const t = setup();
    expect((await currentReport(t.provider)).ready).toBe(true);

    t.advance(GATE_REFRESH_MIN_INTERVAL_MS + 1);
    t.listReviews.mockRejectedValue(new Error('HTTP 500'));

    const report = await currentReport(t.provider);
    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual([
      {
        pr: 'acme/service#42',
        kind: 'load-error',
        message: 'Could not load gate data: HTTP 500',
      },
    ]);
  });

  it('does not reuse a report when the rules change', async () => {
    const t = setup();
    expect((await currentReport(t.provider)).ready).toBe(true);

    t.setRules({ requiredLabels: ['verified'] });

    const report = await currentReport(t.provider);
    expect(report.blockers.map((b) => b.kind)).toEqual(['label-missing']);
  });

  it.each([
    ['host', { host: 'other.example.com' }],
    ['owner', { owner: 'other' }],
    ['repo', { repo: 'other' }],
  ])('does not reuse a report when the %s changes', async (_name, next) => {
    const t = setup();
    await currentReport(t.provider);
    expect(t.listReviews).toHaveBeenCalledTimes(1);

    t.moveTo(next);
    await currentReport(t.provider);
    expect(t.listReviews).toHaveBeenCalledTimes(2);
  });
});
