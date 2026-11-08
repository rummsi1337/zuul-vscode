import { type TriggerComment } from '../config/settings';
import { type GateReport } from './gateReadiness';

export interface GateHeaderNode {
  readonly kind: 'header';
  readonly report: GateReport;
}

export interface GatePrNode {
  readonly kind: 'pr';
  readonly pr: string;
  readonly url?: string;
  readonly isRoot: boolean;
  readonly report: GateReport;
}

export interface GateCheckNode {
  readonly kind: 'check';
  readonly label: string;
  readonly ok: boolean;
  readonly message?: string;
}

export interface GateTriggersNode {
  readonly kind: 'triggers';
  readonly triggers: readonly TriggerComment[];
}

export interface GateTriggerNode {
  readonly kind: 'trigger';
  readonly label: string;
  readonly comment: string;
  readonly icon: string;
}

export type GateTreeNode =
  GateHeaderNode | GatePrNode | GateCheckNode | GateTriggersNode | GateTriggerNode;

export function formatGateHeader(report: GateReport): { label: string; icon: string } {
  if (report.ready) {
    return { label: 'Ready for gate', icon: 'pass-filled' };
  }
  const n = report.blockers.length;
  return { label: `Not ready: ${n} ${n === 1 ? 'blocker' : 'blockers'}`, icon: 'circle-slash' };
}

export function buildGateChildren(
  element: GateTreeNode | undefined,
  report: GateReport,
  triggers: readonly TriggerComment[] = [],
): GateTreeNode[] {
  if (!element) {
    const nodes: GateTreeNode[] = [{ kind: 'header', report }];
    report.items.forEach((item, index) => {
      nodes.push({
        kind: 'pr',
        pr: item.pr,
        ...(item.url ? { url: item.url } : {}),
        isRoot: index === 0,
        report,
      });
    });
    if (triggers.length > 0) {
      nodes.push({ kind: 'triggers', triggers });
    }
    return nodes;
  }
  if (element.kind === 'triggers') {
    return element.triggers.map((t) => ({
      kind: 'trigger',
      label: t.label,
      comment: t.comment,
      icon: t.icon ?? 'comment',
    }));
  }
  if (element.kind !== 'pr') {
    return [];
  }
  const item = element.report.items.find((i) => i.pr === element.pr);
  const children: GateCheckNode[] = (item?.checks ?? []).map((c) => ({
    kind: 'check',
    label: c.label,
    ok: c.ok,
    ...(c.message !== undefined ? { message: c.message } : {}),
  }));
  if (element.isRoot) {
    for (const b of element.report.blockers) {
      if (b.kind === 'upstream') {
        children.push({ kind: 'check', label: b.pr, ok: false, message: b.message });
      }
    }
  }
  return children;
}
