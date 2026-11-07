import { describe, expect, it } from 'vitest';
import {
  type BlockerKind,
  evaluateGate,
  type GateRules,
  type PrGateFacts,
} from '../../src/services/gateReadiness';

function makeReadyPr(overrides: Partial<PrGateFacts> = {}): PrGateFacts {
  return {
    ref: 'acme/service-a#42',
    draft: false,
    merged: false,
    state: 'open',
    mergeableState: 'clean',
    labels: ['ready'],
    reviewDecision: 'APPROVED',
    approvals: 2,
    changesRequested: 0,
    checks: [{ name: 'ci/unit', state: 'success', required: true }],
    zuulCheck: 'success',
    ...overrides,
  };
}

function makeDefaultRules(overrides: Partial<GateRules> = {}): GateRules {
  return {
    requiredApprovals: 1,
    requiredStatusChecks: {},
    requiredLabels: [],
    blockingLabels: ['do-not-merge', 'wip'],
    ...overrides,
  };
}

describe('evaluateGate', () => {
  it('returns ready=true and no blockers when all checks pass', () => {
    const root = makeReadyPr();
    const report = evaluateGate(root, [], makeDefaultRules({ requiredLabels: ['READY'] }));

    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.items).toHaveLength(1);
    expect(report.items[0].pr).toBe('acme/service-a#42');
    expect(report.items[0].checks.every((c) => c.ok)).toBe(true);
  });

  it('reports zuul-check blocker when zuulCheck is not success', () => {
    for (const state of ['failure', 'running', 'none'] as const) {
      const report = evaluateGate(makeReadyPr({ zuulCheck: state }), [], makeDefaultRules());
      expect(report.ready).toBe(false);
      expect(report.blockers).toEqual([
        {
          pr: 'acme/service-a#42',
          kind: 'zuul-check',
          message: `Zuul check is ${state} on HEAD`,
        },
      ]);
    }

    const undefinedZuul = evaluateGate(
      makeReadyPr({ zuulCheck: undefined }),
      [],
      makeDefaultRules(),
    );
    expect(undefinedZuul.blockers).toEqual([
      {
        pr: 'acme/service-a#42',
        kind: 'zuul-check',
        message: 'Zuul check is none on HEAD',
      },
    ]);
  });

  it('evaluates required status checks from check.required, wildcard (*), and per-repo rules', () => {
    const root = makeReadyPr({
      ref: 'acme/payment-svc#10',
      checks: [
        { name: 'branch-prot/lint', state: 'pending', required: true },
        { name: 'sonar', state: 'success', required: false },
        { name: 'pci-check', state: 'failure', required: false },
        { name: 'optional-bench', state: 'failure', required: false },
      ],
    });

    const rules = makeDefaultRules({
      requiredStatusChecks: {
        '*': ['zuul/check', 'sonar'],
        'acme/payment-svc': ['pci-check', 'branch-prot/lint'],
        'acme/other-repo': ['other-only'],
      },
    });

    const report = evaluateGate(root, [], rules);

    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual([
      {
        pr: 'acme/payment-svc#10',
        kind: 'status-check',
        message: 'Required status check `branch-prot/lint` is pending',
      },
      {
        pr: 'acme/payment-svc#10',
        kind: 'status-check',
        message: 'Required status check `zuul/check` is missing',
      },
      {
        pr: 'acme/payment-svc#10',
        kind: 'status-check',
        message: 'Required status check `pci-check` is failure',
      },
    ]);
  });

  it('handles PRs with no required status checks', () => {
    const root = makeReadyPr({
      ref: 'acme/no-checks',
      checks: [{ name: 'optional', state: 'failure', required: false }],
    });
    const report = evaluateGate(root, [], makeDefaultRules());

    expect(report.ready).toBe(true);
    expect(report.items[0].checks.some((c) => c.label === 'Status checks' && c.ok)).toBe(true);
  });

  it('uses reviewDecision when present and falls back to approvals count when absent', () => {
    // reviewDecision = REVIEW_REQUIRED blocks even if approvals >= requiredApprovals
    const reviewReqReport = evaluateGate(
      makeReadyPr({ reviewDecision: 'REVIEW_REQUIRED', approvals: 3 }),
      [],
      makeDefaultRules({ requiredApprovals: 1 }),
    );
    expect(reviewReqReport.blockers).toEqual([
      {
        pr: 'acme/service-a#42',
        kind: 'reviews',
        message: 'Review decision is REVIEW_REQUIRED',
      },
    ]);

    // reviewDecision = APPROVED passes even if approvals < requiredApprovals
    const approvedDecisionReport = evaluateGate(
      makeReadyPr({ reviewDecision: 'APPROVED', approvals: 0 }),
      [],
      makeDefaultRules({ requiredApprovals: 2 }),
    );
    expect(approvedDecisionReport.ready).toBe(true);

    // Fallback when reviewDecision is undefined: approvals < requiredApprovals -> blocker
    const fallbackBlocked = evaluateGate(
      makeReadyPr({ reviewDecision: undefined, approvals: 1 }),
      [],
      makeDefaultRules({ requiredApprovals: 2 }),
    );
    expect(fallbackBlocked.blockers).toEqual([
      {
        pr: 'acme/service-a#42',
        kind: 'reviews',
        message: 'Requires at least 2 approval(s) (currently 1)',
      },
    ]);

    // Fallback when reviewDecision is undefined: approvals >= requiredApprovals -> ok
    const fallbackOk = evaluateGate(
      makeReadyPr({ reviewDecision: undefined, approvals: 2 }),
      [],
      makeDefaultRules({ requiredApprovals: 2 }),
    );
    expect(fallbackOk.ready).toBe(true);
  });

  it('reports changesRequested > 0 as a separate changes-requested blocker', () => {
    const report = evaluateGate(
      makeReadyPr({
        reviewDecision: 'CHANGES_REQUESTED',
        approvals: 1,
        changesRequested: 2,
      }),
      [],
      makeDefaultRules(),
    );

    expect(report.blockers).toEqual([
      {
        pr: 'acme/service-a#42',
        kind: 'reviews',
        message: 'Review decision is CHANGES_REQUESTED',
      },
      {
        pr: 'acme/service-a#42',
        kind: 'changes-requested',
        message: 'Changes requested by 2 reviewer(s)',
      },
    ]);
  });

  it('reports draft and mergeableState (dirty and blocked) blockers', () => {
    const dirtyDraft = evaluateGate(
      makeReadyPr({ draft: true, mergeableState: 'dirty' }),
      [],
      makeDefaultRules(),
    );
    expect(dirtyDraft.blockers).toEqual([
      {
        pr: 'acme/service-a#42',
        kind: 'draft',
        message: 'Pull request is a draft',
      },
      {
        pr: 'acme/service-a#42',
        kind: 'mergeable',
        message: 'Merge state is dirty',
      },
    ]);

    // blocked is still reported with kind 'mergeable' even when other blockers exist
    const blockedWithReview = evaluateGate(
      makeReadyPr({
        reviewDecision: 'REVIEW_REQUIRED',
        mergeableState: 'blocked',
      }),
      [],
      makeDefaultRules(),
    );
    expect(blockedWithReview.blockers).toEqual([
      {
        pr: 'acme/service-a#42',
        kind: 'reviews',
        message: 'Review decision is REVIEW_REQUIRED',
      },
      {
        pr: 'acme/service-a#42',
        kind: 'mergeable',
        message: 'Merge state is blocked',
      },
    ]);

    const noMergeState = evaluateGate(
      makeReadyPr({ mergeableState: undefined }),
      [],
      makeDefaultRules(),
    );
    expect(noMergeState.ready).toBe(true);
  });

  it('matches required and blocking labels case-insensitively', () => {
    const report = evaluateGate(
      makeReadyPr({ labels: ['Ship-It', 'WIP', 'Do-Not-Merge'] }),
      [],
      makeDefaultRules({
        requiredLabels: ['ship-it', 'verified'],
        blockingLabels: ['wip', 'do-not-merge'],
      }),
    );

    expect(report.blockers).toEqual([
      {
        pr: 'acme/service-a#42',
        kind: 'label-missing',
        message: 'Missing required label `verified`',
      },
      {
        pr: 'acme/service-a#42',
        kind: 'label-blocking',
        message: 'Blocking label `WIP` is present',
      },
      {
        pr: 'acme/service-a#42',
        kind: 'label-blocking',
        message: 'Blocking label `Do-Not-Merge` is present',
      },
    ]);
  });

  it('ignores merged upstream PRs and evaluates multi-level non-merged upstream PRs', () => {
    const root = makeReadyPr({ ref: 'acme/frontend#100' });
    const mergedUpstream = makeReadyPr({
      ref: 'acme/common#1',
      merged: true,
      state: 'closed',
      zuulCheck: 'failure',
      draft: true,
    });
    const level1Upstream = makeReadyPr({
      ref: 'acme/api#55',
      checks: [{ name: 'sonarqube', state: 'pending', required: false }],
    });
    const level2Upstream = makeReadyPr({
      ref: 'acme/db-schema#12',
      state: 'closed',
      merged: false,
    });

    const rules = makeDefaultRules({
      requiredStatusChecks: {
        'acme/api': ['sonarqube'],
      },
    });

    const report = evaluateGate(root, [mergedUpstream, level1Upstream, level2Upstream], rules);

    expect(report.ready).toBe(false);
    expect(report.items.map((item) => item.pr)).toEqual([
      'acme/frontend#100',
      'acme/api#55',
      'acme/db-schema#12',
    ]);

    expect(report.blockers).toEqual([
      {
        pr: 'acme/api#55',
        kind: 'status-check',
        message: 'Required status check `sonarqube` is pending',
      },
      {
        pr: 'acme/frontend#100',
        kind: 'upstream',
        message: 'Blocked by upstream `acme/api#55`: Required status check `sonarqube` is pending',
      },
      {
        pr: 'acme/db-schema#12',
        kind: 'closed',
        message: 'Pull request is closed without being merged',
      },
      {
        pr: 'acme/frontend#100',
        kind: 'upstream',
        message:
          'Blocked by upstream `acme/db-schema#12`: Pull request is closed without being merged',
      },
    ]);
  });

  it('covers all 10 blocker kinds', () => {
    const root = makeReadyPr({
      ref: 'acme/app#1',
      zuulCheck: 'failure',
      checks: [{ name: 'ci/build', state: 'error', required: true }],
      reviewDecision: 'REVIEW_REQUIRED',
      changesRequested: 1,
      draft: true,
      mergeableState: 'dirty',
      labels: ['wip'],
    });
    const closedUpstream = makeReadyPr({
      ref: 'acme/lib#2',
      state: 'closed',
      merged: false,
    });

    const report = evaluateGate(
      root,
      [closedUpstream],
      makeDefaultRules({
        requiredLabels: ['release-ok'],
        blockingLabels: ['wip'],
      }),
    );

    const kinds = new Set<BlockerKind>(report.blockers.map((b) => b.kind));
    expect(kinds).toEqual(
      new Set<BlockerKind>([
        'zuul-check',
        'status-check',
        'reviews',
        'changes-requested',
        'draft',
        'mergeable',
        'label-missing',
        'label-blocking',
        'closed',
        'upstream',
      ]),
    );
  });
});
