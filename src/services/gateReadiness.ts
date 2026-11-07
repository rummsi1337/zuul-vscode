export type CheckState = 'success' | 'pending' | 'failure' | 'error' | 'missing';
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
export type ZuulCheckState = 'success' | 'failure' | 'running' | 'none';
export type BlockerKind =
  | 'zuul-check'
  | 'status-check'
  | 'reviews'
  | 'changes-requested'
  | 'draft'
  | 'mergeable'
  | 'label-missing'
  | 'label-blocking'
  | 'closed'
  | 'upstream';

export interface PrGateCheck {
  name: string;
  state: CheckState;
  required: boolean;
}

export interface PrGateFacts {
  ref: string /* owner/repo#n */;
  draft: boolean;
  merged: boolean;
  state: 'open' | 'closed';
  mergeableState?: string;
  labels: string[];
  reviewDecision?: ReviewDecision;
  approvals: number;
  changesRequested: number;
  checks: PrGateCheck[];
  zuulCheck?: ZuulCheckState;
}

export interface GateRules {
  requiredApprovals: number;
  requiredStatusChecks: Record<string, string[]>;
  requiredLabels: string[];
  blockingLabels: string[];
}

export interface Blocker {
  pr: string;
  kind: BlockerKind;
  message: string;
}

export interface GateCheckItem {
  label: string;
  ok: boolean;
  message?: string;
}

export interface PrGateItem {
  pr: string;
  checks: GateCheckItem[];
}

export interface GateReport {
  ready: boolean;
  items: PrGateItem[];
  blockers: Blocker[];
}

function extractRepoKey(ref: string): string {
  const hashIndex = ref.indexOf('#');
  return (hashIndex >= 0 ? ref.slice(0, hashIndex) : ref).trim();
}

function collectRequiredStatusCheckNames(facts: PrGateFacts, rules: GateRules): string[] {
  const requiredNames: string[] = [];
  const seen = new Set<string>();

  const add = (name: string): void => {
    if (!seen.has(name)) {
      seen.add(name);
      requiredNames.push(name);
    }
  };

  for (const check of facts.checks) {
    if (check.required) {
      add(check.name);
    }
  }

  for (const name of rules.requiredStatusChecks['*'] ?? []) {
    add(name);
  }

  const repoKey = extractRepoKey(facts.ref).toLowerCase();
  for (const [key, names] of Object.entries(rules.requiredStatusChecks)) {
    if (key !== '*' && key.toLowerCase() === repoKey) {
      for (const name of names) {
        add(name);
      }
    }
  }

  return requiredNames;
}

function evaluatePr(
  facts: PrGateFacts,
  rules: GateRules,
): { item: PrGateItem; blockers: Blocker[] } {
  const checks: GateCheckItem[] = [];
  const blockers: Blocker[] = [];

  // 1. Zuul check
  const zuulState: ZuulCheckState = facts.zuulCheck ?? 'none';
  if (zuulState === 'success') {
    checks.push({
      label: 'Zuul check',
      ok: true,
      message: 'Zuul check is success on HEAD',
    });
  } else {
    const message = `Zuul check is ${zuulState} on HEAD`;
    checks.push({
      label: 'Zuul check',
      ok: false,
      message,
    });
    blockers.push({
      pr: facts.ref,
      kind: 'zuul-check',
      message,
    });
  }

  // 2. Status checks
  const checkStateByName = new Map<string, CheckState>();
  for (const check of facts.checks) {
    checkStateByName.set(check.name, check.state);
  }

  const requiredNames = collectRequiredStatusCheckNames(facts, rules);
  if (requiredNames.length === 0) {
    checks.push({
      label: 'Status checks',
      ok: true,
      message: 'No required status checks',
    });
  } else {
    for (const name of requiredNames) {
      const state: CheckState = checkStateByName.get(name) ?? 'missing';
      if (state === 'success') {
        checks.push({
          label: `Status check: ${name}`,
          ok: true,
          message: 'success',
        });
      } else {
        const message = `Required status check \`${name}\` is ${state}`;
        checks.push({
          label: `Status check: ${name}`,
          ok: false,
          message,
        });
        blockers.push({
          pr: facts.ref,
          kind: 'status-check',
          message,
        });
      }
    }
  }

  // 3. Reviews & Changes requested
  if (facts.reviewDecision !== undefined) {
    if (facts.reviewDecision === 'APPROVED') {
      checks.push({
        label: 'Reviews',
        ok: true,
        message: 'Approved',
      });
    } else {
      const message = `Review decision is ${facts.reviewDecision}`;
      checks.push({
        label: 'Reviews',
        ok: false,
        message,
      });
      blockers.push({
        pr: facts.ref,
        kind: 'reviews',
        message,
      });
    }
  } else if (facts.approvals >= rules.requiredApprovals) {
    checks.push({
      label: 'Reviews',
      ok: true,
      message: `${facts.approvals}/${rules.requiredApprovals} approval(s)`,
    });
  } else {
    const message = `Requires at least ${rules.requiredApprovals} approval(s) (currently ${facts.approvals})`;
    checks.push({
      label: 'Reviews',
      ok: false,
      message,
    });
    blockers.push({
      pr: facts.ref,
      kind: 'reviews',
      message,
    });
  }

  if (facts.changesRequested > 0) {
    const message = `Changes requested by ${facts.changesRequested} reviewer(s)`;
    checks.push({
      label: 'Changes requested',
      ok: false,
      message,
    });
    blockers.push({
      pr: facts.ref,
      kind: 'changes-requested',
      message,
    });
  }

  // 4. Draft & MergeableState
  if (facts.draft) {
    const message = 'Pull request is a draft';
    checks.push({
      label: 'Draft',
      ok: false,
      message,
    });
    blockers.push({
      pr: facts.ref,
      kind: 'draft',
      message,
    });
  } else {
    checks.push({
      label: 'Draft',
      ok: true,
      message: 'Ready for review',
    });
  }

  const mergeableLower = facts.mergeableState?.toLowerCase();
  if (mergeableLower === 'dirty' || mergeableLower === 'blocked') {
    const message = `Merge state is ${mergeableLower}`;
    checks.push({
      label: 'Merge state',
      ok: false,
      message,
    });
    blockers.push({
      pr: facts.ref,
      kind: 'mergeable',
      message,
    });
  } else {
    checks.push({
      label: 'Merge state',
      ok: true,
      message: facts.mergeableState ? `Merge state is ${facts.mergeableState}` : 'Mergeable',
    });
  }

  // 5. Labels (missing required, present blocking — case-insensitive)
  const prLabelsLower = new Set(facts.labels.map((label) => label.toLowerCase()));
  for (const requiredLabel of rules.requiredLabels) {
    if (prLabelsLower.has(requiredLabel.toLowerCase())) {
      checks.push({
        label: `Required label: ${requiredLabel}`,
        ok: true,
        message: `Label \`${requiredLabel}\` present`,
      });
    } else {
      const message = `Missing required label \`${requiredLabel}\``;
      checks.push({
        label: `Required label: ${requiredLabel}`,
        ok: false,
        message,
      });
      blockers.push({
        pr: facts.ref,
        kind: 'label-missing',
        message,
      });
    }
  }

  for (const blockingLabel of rules.blockingLabels) {
    const matched = facts.labels.find(
      (label) => label.toLowerCase() === blockingLabel.toLowerCase(),
    );
    if (matched !== undefined) {
      const message = `Blocking label \`${matched}\` is present`;
      checks.push({
        label: `Blocking label: ${matched}`,
        ok: false,
        message,
      });
      blockers.push({
        pr: facts.ref,
        kind: 'label-blocking',
        message,
      });
    }
  }

  // 6. Closed (not merged)
  if (facts.state === 'closed' && !facts.merged) {
    const message = 'Pull request is closed without being merged';
    checks.push({
      label: 'PR state',
      ok: false,
      message,
    });
    blockers.push({
      pr: facts.ref,
      kind: 'closed',
      message,
    });
  }

  return {
    item: {
      pr: facts.ref,
      checks,
    },
    blockers,
  };
}

export function evaluateGate(
  root: PrGateFacts,
  upstream: PrGateFacts[],
  rules: GateRules,
): GateReport {
  const items: PrGateItem[] = [];
  const blockers: Blocker[] = [];

  const rootEval = evaluatePr(root, rules);
  items.push(rootEval.item);
  blockers.push(...rootEval.blockers);

  for (const up of upstream) {
    if (up.merged) {
      continue;
    }

    const upEval = evaluatePr(up, rules);
    items.push(upEval.item);
    blockers.push(...upEval.blockers);

    for (const blocker of upEval.blockers) {
      blockers.push({
        pr: root.ref,
        kind: 'upstream',
        message: `Blocked by upstream \`${up.ref}\`: ${blocker.message}`,
      });
    }
  }

  return {
    ready: blockers.length === 0,
    items,
    blockers,
  };
}
