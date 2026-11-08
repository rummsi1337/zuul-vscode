import { describe, expect, it, vi } from 'vitest';
import { EventEmitter, workspace } from 'vscode';
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

function setup(zuulState: PrSnapshot['zuul'] = { kind: 'ok' }) {
  let time = 0;
  let rules = RULES;
  const listReviews = vi.fn(async (): Promise<Review[]> => []);
  const getChangeStatus = vi.fn(async () => [
    {
      pipeline: 'check',
      queue: '',
      live: true,
      jobs: [{ name: 'j', running: false, result: 'SUCCESS', voting: true }],
      itemsAhead: [],
    },
  ]);
  const context = {
    host: 'ghe.example.com',
    owner: 'acme',
    repo: 'service',
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
      url: 'https://zuul.example.com',
      tenant: 'acme-tenant',
      client: {
        getChangeStatus,
      },
    },
  } as unknown as ResolvedContext;
  const ctx = { current: context };
  const snapshot: PrSnapshot = {
    pr: PR,
    statuses: [],
    builds: [],
    fetchedAt: 0,
    zuul: zuulState,
  };
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
    getChangeStatus,
    advance: (ms: number): void => {
      time += ms;
    },
    setZuulState: (next: PrSnapshot['zuul']): void => {
      snapshot.zuul = next;
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

  it('shows GitHub rows and is not ready when the context has no Zuul', async () => {
    const t = setup();
    t.moveTo({ zuul: undefined });

    const report = await currentReport(t.provider);

    expect(report.ready).toBe(false);
    expect(report.blockers.map((b) => b.kind)).toContain('zuul-check');
    expect(report.blockers.map((b) => b.kind)).not.toContain('load-error');
    expect(t.listReviews).toHaveBeenCalled();
    expect(t.getChangeStatus).not.toHaveBeenCalled();
  });

  it('sends no Zuul requests and is not ready when the snapshot says Zuul failed', async () => {
    const t = setup({
      kind: 'unavailable',
      reason: 'needs-token',
      message: 'HTTP 401',
      stopped: true,
    });

    const report = await currentReport(t.provider);

    expect(report.ready).toBe(false);
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ kind: 'zuul-check', message: "Zuul check can't be read" }),
    );
    expect(t.listReviews).toHaveBeenCalled();
    expect(t.getChangeStatus).not.toHaveBeenCalled();
  });

  it('reports a Zuul error as unknown instead of failing the gate', async () => {
    const t = setup();
    t.getChangeStatus.mockRejectedValue(new Error('HTTP 401'));

    const report = await currentReport(t.provider);

    expect(report.ready).toBe(false);
    expect(report.blockers.map((b) => b.kind)).not.toContain('load-error');
    expect(report.blockers.map((b) => b.kind)).toContain('zuul-check');
  });

  it('rebuilds the report when only the snapshot Zuul state flips', async () => {
    const t = setup();
    expect((await currentReport(t.provider)).ready).toBe(true);
    expect(t.getChangeStatus).toHaveBeenCalledTimes(1);

    t.advance(1);
    t.setZuulState({
      kind: 'unavailable',
      reason: 'needs-token',
      message: 'HTTP 401',
      stopped: true,
    });

    const report = await currentReport(t.provider);
    expect(report.ready).toBe(false);
    expect(t.getChangeStatus).toHaveBeenCalledTimes(1);
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

  it('shows a Triggers row with trigger rows that post the comment', async () => {
    const t = setup();
    const nodes = await t.provider.getChildren();
    const triggers = nodes.find((n) => n.kind === 'triggers');
    expect(triggers).toBeDefined();
    expect(t.provider.getTreeItem(triggers!).id).toBe('gate/triggers');
    const [row] = await t.provider.getChildren(triggers);
    const item = t.provider.getTreeItem(row);
    expect(item.label).toBe('Recheck');
    expect(item.description).toBe('recheck');
    expect(item.iconPath).toMatchObject({ id: 'refresh' });
    expect(item.command?.command).toBe('zuul.postTrigger');
    expect(item.command?.arguments).toEqual(['recheck']);
    expect(item.id).toBeUndefined();
  });

  it('fires onDidChangeTreeData when zuul settings change', () => {
    const t = setup();
    const listener = vi.fn();
    t.provider.onDidChangeTreeData(listener);
    const calls = vi.mocked(workspace.onDidChangeConfiguration).mock.calls;
    const handler = calls[calls.length - 1][0];
    handler({ affectsConfiguration: (s: string) => s === 'zuul' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('shows no Triggers node without a snapshot', async () => {
    const provider = new PrGateTreeDataProvider(
      { snapshot: undefined, onDidChange: new EventEmitter<PrSnapshot | undefined>().event },
      { current: undefined },
      () => RULES,
      createFakeLogger(),
    );
    expect(await provider.getChildren()).toEqual([]);
  });
});
