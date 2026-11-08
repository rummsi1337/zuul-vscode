import { type BranchMergeRules } from '../clients/gheTypes';

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
  | 'upstream'
  | 'load-error';

export interface PrGateCheck {
  name: string;
  state: CheckState;
  required: boolean;
}

export interface PrGateFacts {
  ref: string /* owner/repo#n */;
  url?: string;
  draft: boolean;
  merged: boolean;
  state: 'open' | 'closed';
  mergeableState?: string;
  labels: string[];
  reviewDecision?: ReviewDecision;
  approvals: number;
  changesRequested: number;
  checks: PrGateCheck[];
  /** True when the branch's required status check list could be read. */
  requiredChecksKnown: boolean;
  /** Branch rules besides status checks that can cause `blocked`. Absent when they can't be read. */
  mergeRules?: BranchMergeRules;
  zuulCheck?: ZuulCheckState;
  /** Set when this PR could not be checked. The other facts are then only placeholders. */
  loadError?: string;
}

export interface GateRules {
  requiredApprovals: number;
  requiredStatusChecks: Record<string, string[]>;
  requiredLabels: string[];
  blockingLabels: string[];
  /** Status checks that only report once a PR enters Zuul's gate (case-insensitive). */
  gateStatusChecks: string[];
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
  url?: string;
  checks: GateCheckItem[];
}

export interface GateReport {
  ready: boolean;
  items: PrGateItem[];
  blockers: Blocker[];
}

const PASSING_MERGE_STATES = new Set(['clean', 'behind', 'unstable', 'has_hooks', 'draft']);

const UNKNOWN_REQUIRED_BLOCKED_MESSAGE =
  "Merge is blocked, and this repo's required checks can't be read. List them in zuul.gate.requiredStatusChecks to tell whether only the Zuul gate is left.";

const UNKNOWN_MERGE_RULES_BLOCKED_MESSAGE =
  "Merge is blocked, and this branch's other merge rules can't be read. List its required checks in zuul.gate.requiredStatusChecks to tell whether only the Zuul gate is left.";

const UNKNOWN_REQUIRED_ROW_MESSAGE = "Required checks can't be read, relying on the merge state";

const GATE_FAILED_MESSAGE = 'Zuul gate failed on this commit. It needs a new trigger.';

function extractRepoKey(ref: string): string {
  const hashIndex = ref.indexOf('#');
  return (hashIndex >= 0 ? ref.slice(0, hashIndex) : ref).trim();
}

function rulesCheckNamesForRepo(facts: PrGateFacts, rules: GateRules): string[] {
  const names = [...(rules.requiredStatusChecks['*'] ?? [])];
  const repoKey = extractRepoKey(facts.ref).toLowerCase();
  for (const [key, list] of Object.entries(rules.requiredStatusChecks)) {
    if (key !== '*' && key.toLowerCase() === repoKey) {
      names.push(...list);
    }
  }
  return names;
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

  for (const name of rulesCheckNamesForRepo(facts, rules)) {
    add(name);
  }

  return requiredNames;
}

function uncheckableRuleMessage(rule: string): string {
  return `Merge is blocked, and this branch requires ${rule}. That can't be checked here, so it may be more than the Zuul gate.`;
}

/** Why a `blocked` PR can't be put down to the Zuul gate alone, or undefined when it can. */
function otherBlockedCause(facts: PrGateFacts, listedInSettings: boolean): string | undefined {
  const mergeRules = facts.mergeRules;
  if (mergeRules === undefined) {
    return listedInSettings ? undefined : UNKNOWN_MERGE_RULES_BLOCKED_MESSAGE;
  }
  if (mergeRules.requiresConversationResolution) {
    return uncheckableRuleMessage('resolved conversations');
  }
  if (mergeRules.requiresSignatures) {
    return uncheckableRuleMessage('signed commits');
  }
  const requiredCount = mergeRules.requiredApprovingReviewCount;
  if (facts.reviewDecision !== 'APPROVED' && facts.approvals < requiredCount) {
    return `Merge is blocked: this branch requires at least ${requiredCount} approval(s) (currently ${facts.approvals})`;
  }
  return undefined;
}

/** Replaces `{tenant}` in the configured status check names. */
export function resolveGateRules(rules: GateRules, tenant: string): GateRules {
  const fill = (name: string): string => name.split('{tenant}').join(tenant);
  return {
    ...rules,
    requiredStatusChecks: Object.fromEntries(
      Object.entries(rules.requiredStatusChecks).map(([repo, names]) => [repo, names.map(fill)]),
    ),
    gateStatusChecks: rules.gateStatusChecks.map(fill),
  };
}

/** A not-ready report for when gate data could not be loaded at all. */
export function gateLoadFailureReport(pr: string, reason: string): GateReport {
  const message = `Could not load gate data: ${reason}`;
  return {
    ready: false,
    items: [{ pr, checks: [{ label: 'Gate data', ok: false, message }] }],
    blockers: [{ pr, kind: 'load-error', message }],
  };
}

function evaluatePr(
  facts: PrGateFacts,
  rules: GateRules,
): { item: PrGateItem; blockers: Blocker[] } {
  if (facts.loadError !== undefined) {
    return {
      item: {
        pr: facts.ref,
        checks: [{ label: 'Pull request', ok: false, message: facts.loadError }],
      },
      blockers: [{ pr: facts.ref, kind: 'load-error', message: facts.loadError }],
    };
  }

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

  const gateNames: string[] = [];
  const gateNameSet = new Set<string>();
  for (const name of rules.gateStatusChecks) {
    const lower = name.toLowerCase();
    if (!gateNameSet.has(lower)) {
      gateNameSet.add(lower);
      gateNames.push(name);
    }
  }
  const isGateName = (name: string): boolean => gateNameSet.has(name.toLowerCase());
  const gateCheckState = (name: string): CheckState | undefined =>
    facts.checks.find((c) => c.name.toLowerCase() === name.toLowerCase())?.state;

  const requiredNames = collectRequiredStatusCheckNames(facts, rules);
  const otherRequiredNames = requiredNames.filter((name) => !isGateName(name));
  const listedInSettings = rulesCheckNamesForRepo(facts, rules).length > 0;
  const requiredKnown = facts.requiredChecksKnown || listedInSettings;
  if (otherRequiredNames.length === 0) {
    checks.push({
      label: 'Status checks',
      ok: true,
      message: requiredKnown ? 'No required status checks' : UNKNOWN_REQUIRED_ROW_MESSAGE,
    });
  } else {
    for (const name of otherRequiredNames) {
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

  // 2b. Zuul gate status checks: they only report once the PR is in the gate.
  for (const name of gateNames) {
    const state = gateCheckState(name);
    if (state === undefined || state === 'missing') {
      checks.push({ label: 'Zuul gate', ok: true, message: 'Starts once everything else is done' });
    } else if (state === 'pending') {
      checks.push({ label: 'Zuul gate', ok: true, message: 'Running' });
    } else if (state === 'success') {
      checks.push({ label: 'Zuul gate', ok: true, message: 'success' });
    } else {
      checks.push({ label: 'Zuul gate', ok: false, message: GATE_FAILED_MESSAGE });
      blockers.push({ pr: facts.ref, kind: 'status-check', message: GATE_FAILED_MESSAGE });
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

  // The merge state row is decided last (the `blocked` exception needs every other blocker),
  // but keeps its place in the row and blocker order.
  const mergeRowIndex = checks.length;
  const mergeBlockerIndex = blockers.length;

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

  // 4b. Merge state
  const mergeableLower = facts.mergeableState?.trim().toLowerCase();
  let mergeRow: GateCheckItem;
  let mergeBlocker: Blocker | undefined;
  if (mergeableLower !== undefined && PASSING_MERGE_STATES.has(mergeableLower)) {
    mergeRow = {
      label: 'Merge state',
      ok: true,
      message: `Merge state is ${facts.mergeableState}`,
    };
  } else if (mergeableLower === 'blocked') {
    const gateOutstanding = requiredNames.some((name) => {
      if (!isGateName(name)) {
        return false;
      }
      const state = gateCheckState(name);
      return state === undefined || state === 'missing' || state === 'pending';
    });
    const othersSucceeded = otherRequiredNames.every(
      (name) => checkStateByName.get(name) === 'success',
    );
    const onlyGateVisible =
      requiredKnown && gateOutstanding && othersSucceeded && blockers.length === 0;
    const otherCause = onlyGateVisible ? otherBlockedCause(facts, listedInSettings) : undefined;
    if (onlyGateVisible && otherCause === undefined) {
      mergeRow = { label: 'Merge state', ok: true, message: 'Blocked only by the Zuul gate' };
    } else {
      const message = requiredKnown
        ? (otherCause ?? 'Merge state is blocked')
        : UNKNOWN_REQUIRED_BLOCKED_MESSAGE;
      mergeRow = { label: 'Merge state', ok: false, message };
      mergeBlocker = { pr: facts.ref, kind: 'mergeable', message };
    }
  } else {
    const message = `Merge state is ${mergeableLower || 'unknown'}`;
    mergeRow = { label: 'Merge state', ok: false, message };
    mergeBlocker = { pr: facts.ref, kind: 'mergeable', message };
  }
  checks.splice(mergeRowIndex, 0, mergeRow);
  if (mergeBlocker) {
    blockers.splice(mergeBlockerIndex, 0, mergeBlocker);
  }

  return {
    item: {
      pr: facts.ref,
      ...(facts.url ? { url: facts.url } : {}),
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

    // The upstream PR's own rows stay in `items`; each problem counts once, as `upstream`.
    const upEval = evaluatePr(up, rules);
    items.push(upEval.item);

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
