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

export type GateTreeNode = GateHeaderNode | GatePrNode | GateCheckNode;

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
    return nodes;
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
