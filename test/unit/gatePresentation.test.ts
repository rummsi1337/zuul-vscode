import { describe, expect, it } from 'vitest';
import { buildGateChildren, formatGateHeader } from '../../src/services/gatePresentation';
import { type GateReport } from '../../src/services/gateReadiness';

const report: GateReport = {
  ready: false,
  items: [
    {
      pr: 'org/a#1',
      checks: [
        { label: 'Open', ok: true },
        { label: 'Zuul', ok: false, message: 'x' },
      ],
    },
    { pr: 'org/b#2', checks: [{ label: 'Merged', ok: true }] },
  ],
  blockers: [
    { pr: 'org/a#1', kind: 'status-check', message: 'own' },
    { pr: 'org/b#2', kind: 'upstream', message: 'not ready' },
  ],
};

describe('formatGateHeader', () => {
  it('reports ready', () => {
    expect(formatGateHeader({ ready: true, items: [], blockers: [] })).toEqual({
      label: 'Ready for gate',
      icon: 'pass-filled',
    });
  });

  it('counts blockers when not ready', () => {
    expect(formatGateHeader(report)).toEqual({
      label: 'Not ready: 2 blockers',
      icon: 'circle-slash',
    });
  });

  it('uses the singular for one blocker', () => {
    expect(formatGateHeader({ ...report, blockers: [report.blockers[0]] }).label).toBe(
      'Not ready: 1 blocker',
    );
  });
});

describe('buildGateChildren', () => {
  it('returns header then one node per PR, first is root', () => {
    const nodes = buildGateChildren(undefined, report);
    expect(nodes.map((n) => n.kind)).toEqual(['header', 'pr', 'pr']);
    expect(nodes[1]).toMatchObject({ pr: 'org/a#1', isRoot: true });
    expect(nodes[2]).toMatchObject({ pr: 'org/b#2', isRoot: false });
  });

  it('lists checks for a root PR plus upstream blockers', () => {
    const root = buildGateChildren(undefined, report)[1];
    expect(buildGateChildren(root, report)).toEqual([
      { kind: 'check', label: 'Open', ok: true },
      { kind: 'check', label: 'Zuul', ok: false, message: 'x' },
      { kind: 'check', label: 'org/b#2', ok: false, message: 'not ready' },
    ]);
  });

  it('lists only own checks for an upstream PR', () => {
    const upstream = buildGateChildren(undefined, report)[2];
    expect(buildGateChildren(upstream, report)).toEqual([
      { kind: 'check', label: 'Merged', ok: true },
    ]);
  });

  it('returns no children for header and check nodes', () => {
    expect(buildGateChildren({ kind: 'header', report }, report)).toEqual([]);
    expect(buildGateChildren({ kind: 'check', label: 'x', ok: true }, report)).toEqual([]);
  });

  it('returns no children for an unknown PR', () => {
    expect(buildGateChildren({ kind: 'pr', pr: 'nope', isRoot: false, report }, report)).toEqual(
      [],
    );
  });
});

describe('buildGateChildren urls', () => {
  it('carries the item url on the pr node and none when absent', () => {
    const withUrl: GateReport = {
      ready: false,
      items: [
        { pr: 'org/a#1', url: 'https://ghe.example.com/org/a/pull/1', checks: [] },
        { pr: 'org/b#2', checks: [] },
      ],
      blockers: [],
    };
    const nodes = buildGateChildren(undefined, withUrl);
    expect(nodes[1]).toMatchObject({ url: 'https://ghe.example.com/org/a/pull/1' });
    expect(nodes[2]).not.toHaveProperty('url');
  });
});

describe('buildGateChildren triggers', () => {
  const triggers = [
    { label: 'Recheck', comment: 'recheck' },
    { label: 'Rebuild', comment: 'rebuild', icon: 'sync' },
  ];

  it('puts the header and PR nodes before the Triggers node', () => {
    const nodes = buildGateChildren(undefined, report, triggers);
    expect(nodes.map((n) => n.kind)).toEqual(['header', 'pr', 'pr', 'triggers']);
  });

  it('adds no Triggers node for an empty list', () => {
    const nodes = buildGateChildren(undefined, report, []);
    expect(nodes.some((n) => n.kind === 'triggers')).toBe(false);
  });

  it('lists rows in configured order with the default icon and keeps a configured icon', () => {
    const rows = buildGateChildren({ kind: 'triggers', triggers }, report);
    expect(rows).toEqual([
      { kind: 'trigger', label: 'Recheck', comment: 'recheck', icon: 'comment' },
      { kind: 'trigger', label: 'Rebuild', comment: 'rebuild', icon: 'sync' },
    ]);
  });
});
