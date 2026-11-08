import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'vscode';
import { type PullRequest } from '../../src/clients/gheTypes';
import { type ResolvedContext } from '../../src/context/zuulContext';
import { type GateReport } from '../../src/services/gateReadiness';
import { type PrSnapshot } from '../../src/services/prTracker';
import { PrGateTreeDataProvider } from '../../src/views/prGateTreeView';
import { createFakeLogger } from '../helpers';

const REPORT: GateReport = {
  ready: true,
  blockers: [],
  items: [
    { pr: 'org/repo#1', checks: [{ label: 'Review', ok: true }] },
    { pr: 'org/repo#1', checks: [{ label: 'Review', ok: true }] },
  ],
};

vi.mock('../../src/services/gateFacts', () => ({
  collectGateFacts: vi.fn(async () => ({})),
  collectUpstreamFacts: vi.fn(async () => []),
}));
vi.mock('../../src/services/gateReadiness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/gateReadiness')>()),
  evaluateGate: vi.fn(() => REPORT),
}));

describe('PrGateTreeDataProvider ids', () => {
  it('gives two items with the same pr different ids, and leaves other rows without ids', async () => {
    const pr = {
      number: 1,
      updated_at: '',
      head: { sha: 's' },
      base: { repo: { full_name: 'org/repo' } },
    } as unknown as PullRequest;
    const snapshot: PrSnapshot = { pr, statuses: [], builds: [], fetchedAt: 0 };
    const rc = {
      host: 'h',
      owner: 'org',
      repo: 'repo',
      tenant: 't',
      ghe: {},
      zuul: {},
    } as unknown as ResolvedContext;
    const provider = new PrGateTreeDataProvider(
      { snapshot, onDidChange: new EventEmitter<PrSnapshot | undefined>().event },
      { current: rc },
      () => ({
        requiredApprovals: 0,
        requiredStatusChecks: {},
        requiredLabels: [],
        blockingLabels: [],
        gateStatusChecks: [],
      }),
      createFakeLogger(),
    );

    const [header, ...prs] = await provider.getChildren();

    expect(prs.map((n) => provider.getTreeItem(n).id)).toEqual([
      'gate/pr/org/repo#1',
      'gate/pr/org/repo#1~2',
    ]);
    expect(provider.getTreeItem(header).id).toBeUndefined();
    const [check] = await provider.getChildren(prs[0]);
    expect(provider.getTreeItem(check).id).toBeUndefined();
    provider.dispose();
  });
});
