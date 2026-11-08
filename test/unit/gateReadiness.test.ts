import { describe, expect, it } from 'vitest';
import {
  type BlockerKind,
  evaluateGate,
  gateLoadFailureReport,
  type GateRules,
  type PrGateFacts,
  resolveGateRules,
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
    requiredChecksKnown: true,
    mergeRules: {
      requiredApprovingReviewCount: 0,
      requiresConversationResolution: false,
      requiresSignatures: false,
    },
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
    gateStatusChecks: [],
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
    expect(noMergeState.blockers).toEqual([
      { pr: 'acme/service-a#42', kind: 'mergeable', message: 'Merge state is unknown' },
    ]);
  });

  it('passes and blocks merge states per the table', () => {
    const cases: [string | undefined, boolean][] = [
      ['clean', true],
      ['behind', true],
      ['unstable', true],
      ['has_hooks', true],
      ['draft', true],
      ['CLEAN', true],
      ['dirty', false],
      ['blocked', false],
      ['unknown', false],
      [undefined, false],
    ];
    for (const [mergeableState, ready] of cases) {
      const report = evaluateGate(makeReadyPr({ mergeableState }), [], makeDefaultRules());
      expect({ mergeableState, ready: report.ready }).toEqual({ mergeableState, ready });
      const row = report.items[0].checks.find((c) => c.label === 'Merge state');
      expect(row?.ok).toBe(ready);
      if (!ready) {
        expect(report.blockers.map((b) => b.kind)).toEqual(['mergeable']);
      }
    }
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
        pr: 'acme/frontend#100',
        kind: 'upstream',
        message: 'Blocked by upstream `acme/api#55`: Required status check `sonarqube` is pending',
      },
      {
        pr: 'acme/frontend#100',
        kind: 'upstream',
        message:
          'Blocked by upstream `acme/db-schema#12`: Pull request is closed without being merged',
      },
    ]);
    // The upstream PR's own detail stays in its item.
    expect(report.items[1].checks).toContainEqual({
      label: 'Status check: sonarqube',
      ok: false,
      message: 'Required status check `sonarqube` is pending',
    });
  });

  it('counts one upstream problem as one blocker', () => {
    const upstream = makeReadyPr({ ref: 'acme/lib#7', zuulCheck: 'failure' });
    const report = evaluateGate(makeReadyPr(), [upstream], makeDefaultRules());

    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual([
      {
        pr: 'acme/service-a#42',
        kind: 'upstream',
        message: 'Blocked by upstream `acme/lib#7`: Zuul check is failure on HEAD',
      },
    ]);
  });

  it('counts an unreadable upstream PR as one blocker', () => {
    const upstream = makeReadyPr({
      ref: 'acme/lib#7',
      zuulCheck: 'none',
      approvals: 0,
      mergeableState: undefined,
      loadError: 'Could not read this pull request',
    });
    const report = evaluateGate(makeReadyPr(), [upstream], makeDefaultRules());

    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual([
      {
        pr: 'acme/service-a#42',
        kind: 'upstream',
        message: 'Blocked by upstream `acme/lib#7`: Could not read this pull request',
      },
    ]);
    expect(report.items[1].checks).toEqual([
      { label: 'Pull request', ok: false, message: 'Could not read this pull request' },
    ]);
  });

  it('does not claim there are no required checks when the list cannot be read', () => {
    const report = evaluateGate(
      makeReadyPr({ requiredChecksKnown: false, checks: [] }),
      [],
      makeDefaultRules(),
    );

    expect(report.ready).toBe(true);
    expect(report.items[0].checks).toContainEqual({
      label: 'Status checks',
      ok: true,
      message: "Required checks can't be read, relying on the merge state",
    });
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
      state: 'closed',
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

describe('Zuul gate status checks', () => {
  const GATE = 'acme-tenant/gate';
  const gateRules = (overrides: Partial<GateRules> = {}): GateRules =>
    makeDefaultRules({ gateStatusChecks: [GATE], ...overrides });
  const gateRow = (report: ReturnType<typeof evaluateGate>) =>
    report.items[0].checks.find((c) => c.label === 'Zuul gate');

  it('treats the gate check per the table (absent, pending, success, failure)', () => {
    const absent = evaluateGate(makeReadyPr(), [], gateRules());
    expect(absent.ready).toBe(true);
    expect(gateRow(absent)).toEqual({
      label: 'Zuul gate',
      ok: true,
      message: 'Starts once everything else is done',
    });

    const missing = evaluateGate(
      makeReadyPr({
        checks: [
          { name: 'ci/unit', state: 'success', required: true },
          { name: GATE, state: 'missing', required: true },
        ],
      }),
      [],
      gateRules(),
    );
    expect(missing.ready).toBe(true);
    expect(gateRow(missing)?.message).toBe('Starts once everything else is done');

    const pending = evaluateGate(
      makeReadyPr({ checks: [{ name: 'ACME-tenant/Gate', state: 'pending', required: true }] }),
      [],
      gateRules(),
    );
    expect(pending.ready).toBe(true);
    expect(gateRow(pending)).toEqual({ label: 'Zuul gate', ok: true, message: 'Running' });

    const success = evaluateGate(
      makeReadyPr({ checks: [{ name: GATE, state: 'success', required: true }] }),
      [],
      gateRules(),
    );
    expect(success.ready).toBe(true);
    expect(gateRow(success)?.ok).toBe(true);

    for (const state of ['failure', 'error'] as const) {
      const failed = evaluateGate(
        makeReadyPr({ checks: [{ name: GATE, state, required: false }] }),
        [],
        gateRules(),
      );
      expect(failed.ready).toBe(false);
      expect(failed.blockers).toEqual([
        {
          pr: 'acme/service-a#42',
          kind: 'status-check',
          message: 'Zuul gate failed on this commit. It needs a new trigger.',
        },
      ]);
      expect(gateRow(failed)?.ok).toBe(false);
    }
  });

  it('excuses `blocked` when only the gate is outstanding', () => {
    for (const gateState of ['absent', 'pending'] as const) {
      const checks: PrGateFacts['checks'] = [{ name: 'ci/unit', state: 'success', required: true }];
      if (gateState === 'pending') {
        checks.push({ name: GATE, state: 'pending', required: true });
      }
      const report = evaluateGate(
        makeReadyPr({ mergeableState: 'blocked', checks }),
        [],
        gateRules({ requiredStatusChecks: gateState === 'absent' ? { '*': [GATE] } : {} }),
      );
      expect(report.ready).toBe(true);
      expect(report.items[0].checks).toContainEqual({
        label: 'Merge state',
        ok: true,
        message: 'Blocked only by the Zuul gate',
      });
    }
  });

  it('keeps `blocked` a blocker when the required list is unknown', () => {
    const report = evaluateGate(
      makeReadyPr({
        mergeableState: 'blocked',
        requiredChecksKnown: false,
        checks: [{ name: GATE, state: 'pending', required: true }],
      }),
      [],
      gateRules(),
    );
    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual([
      {
        pr: 'acme/service-a#42',
        kind: 'mergeable',
        message:
          "Merge is blocked, and this repo's required checks can't be read. List them in zuul.gate.requiredStatusChecks to tell whether only the Zuul gate is left.",
      },
    ]);
  });

  it('counts the required list as known when the settings name checks for this repo', () => {
    const report = evaluateGate(
      makeReadyPr({ mergeableState: 'blocked', requiredChecksKnown: false, checks: [] }),
      [],
      gateRules({ requiredStatusChecks: { 'ACME/service-a': [GATE] } }),
    );
    expect(report.ready).toBe(true);
  });

  it('keeps `blocked` a blocker when another required check has not reported', () => {
    const report = evaluateGate(
      makeReadyPr({
        mergeableState: 'blocked',
        checks: [
          { name: 'ci/unit', state: 'missing', required: true },
          { name: GATE, state: 'pending', required: true },
        ],
      }),
      [],
      gateRules(),
    );
    expect(report.ready).toBe(false);
    expect(report.blockers.map((b) => b.message)).toEqual([
      'Required status check `ci/unit` is missing',
      'Merge state is blocked',
    ]);
  });

  it('keeps `blocked` a blocker when the gate check is not in the required list', () => {
    const report = evaluateGate(
      makeReadyPr({
        mergeableState: 'blocked',
        checks: [
          { name: 'ci/unit', state: 'success', required: true },
          { name: GATE, state: 'pending', required: false },
        ],
      }),
      [],
      gateRules(),
    );
    expect(report.ready).toBe(false);
    expect(report.blockers.map((b) => b.message)).toEqual(['Merge state is blocked']);
  });

  it('keeps `blocked` a blocker when the PR has another blocker', () => {
    const report = evaluateGate(
      makeReadyPr({
        mergeableState: 'blocked',
        labels: ['wip'],
        checks: [{ name: GATE, state: 'pending', required: true }],
      }),
      [],
      gateRules(),
    );
    expect(report.blockers.map((b) => b.kind)).toEqual(['mergeable', 'label-blocking']);
  });

  describe('other causes of `blocked`', () => {
    const onlyGateLeft = (overrides: Partial<PrGateFacts>): PrGateFacts =>
      makeReadyPr({
        mergeableState: 'blocked',
        checks: [{ name: GATE, state: 'pending', required: true }],
        ...overrides,
      });
    const openRules = {
      requiredApprovingReviewCount: 0,
      requiresConversationResolution: false,
      requiresSignatures: false,
    };

    it.each([
      [
        'resolved conversations',
        { ...openRules, requiresConversationResolution: true },
        "Merge is blocked, and this branch requires resolved conversations. That can't be checked here, so it may be more than the Zuul gate.",
      ],
      [
        'signed commits',
        { ...openRules, requiresSignatures: true },
        "Merge is blocked, and this branch requires signed commits. That can't be checked here, so it may be more than the Zuul gate.",
      ],
    ])('keeps `blocked` a blocker when the branch requires %s', (_name, mergeRules, message) => {
      const report = evaluateGate(onlyGateLeft({ mergeRules }), [], gateRules());
      expect(report.ready).toBe(false);
      expect(report.blockers).toEqual([{ pr: 'acme/service-a#42', kind: 'mergeable', message }]);
    });

    it('keeps `blocked` a blocker when approvals are short of the branch rule', () => {
      const report = evaluateGate(
        onlyGateLeft({
          reviewDecision: undefined,
          approvals: 1,
          mergeRules: { ...openRules, requiredApprovingReviewCount: 2 },
        }),
        [],
        gateRules(),
      );
      expect(report.blockers.map((b) => b.message)).toEqual([
        'Merge is blocked: this branch requires at least 2 approval(s) (currently 1)',
      ]);
    });

    it("trusts GHE's APPROVED decision over the approval count", () => {
      const report = evaluateGate(
        onlyGateLeft({
          reviewDecision: 'APPROVED',
          approvals: 1,
          mergeRules: { ...openRules, requiredApprovingReviewCount: 2 },
        }),
        [],
        gateRules(),
      );
      expect(report.ready).toBe(true);
    });

    it('keeps `blocked` a blocker when the merge rules cannot be read', () => {
      const report = evaluateGate(onlyGateLeft({ mergeRules: undefined }), [], gateRules());
      expect(report.blockers.map((b) => b.message)).toEqual([
        "Merge is blocked, and this branch's other merge rules can't be read. List its required checks in zuul.gate.requiredStatusChecks to tell whether only the Zuul gate is left.",
      ]);
    });

    it('excuses `blocked` with unreadable merge rules when the settings list the checks', () => {
      const report = evaluateGate(
        onlyGateLeft({ mergeRules: undefined, requiredChecksKnown: false }),
        [],
        gateRules({ requiredStatusChecks: { '*': [GATE] } }),
      );
      expect(report.ready).toBe(true);
    });

    it('does not let the settings override a merge rule that is known to be on', () => {
      const report = evaluateGate(
        onlyGateLeft({ mergeRules: { ...openRules, requiresConversationResolution: true } }),
        [],
        gateRules({ requiredStatusChecks: { '*': [GATE] } }),
      );
      expect(report.ready).toBe(false);
    });
  });

  it('substitutes {tenant} in the configured names', () => {
    const rules = resolveGateRules(
      makeDefaultRules({
        gateStatusChecks: ['{tenant}/gate', 'static'],
        requiredStatusChecks: { '*': ['{tenant}/gate', 'ci/unit'], 'acme/app': ['{tenant}/check'] },
      }),
      'acme-tenant',
    );
    expect(rules.gateStatusChecks).toEqual(['acme-tenant/gate', 'static']);
    expect(rules.requiredStatusChecks).toEqual({
      '*': ['acme-tenant/gate', 'ci/unit'],
      'acme/app': ['acme-tenant/check'],
    });
  });

  it('removes names containing {tenant} when there is no tenant', () => {
    const rules = resolveGateRules(
      makeDefaultRules({
        gateStatusChecks: ['{tenant}/gate', 'static'],
        requiredStatusChecks: { '*': ['{tenant}/gate', 'ci/unit'], 'acme/app': ['{tenant}/check'] },
      }),
      undefined,
    );
    expect(rules.gateStatusChecks).toEqual(['static']);
    expect(rules.requiredStatusChecks).toEqual({ '*': ['ci/unit'], 'acme/app': [] });
  });

  it('excuses `blocked` when the settings list the gate as {tenant}/gate', () => {
    const report = evaluateGate(
      makeReadyPr({
        mergeableState: 'blocked',
        requiredChecksKnown: false,
        mergeRules: undefined,
        checks: [],
      }),
      [],
      resolveGateRules(
        makeDefaultRules({
          gateStatusChecks: ['{tenant}/gate'],
          requiredStatusChecks: { '*': ['{tenant}/gate'] },
        }),
        'acme-tenant',
      ),
    );
    expect(report.ready).toBe(true);
  });
});

describe('gateLoadFailureReport', () => {
  it('is never ready and carries one load-error blocker', () => {
    const report = gateLoadFailureReport('acme/service#42', 'HTTP 500');
    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual([
      {
        pr: 'acme/service#42',
        kind: 'load-error',
        message: 'Could not load gate data: HTTP 500',
      },
    ]);
    expect(report.items[0].checks[0]).toEqual({
      label: 'Gate data',
      ok: false,
      message: 'Could not load gate data: HTTP 500',
    });
  });
});
