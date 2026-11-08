import { describe, expect, it } from 'vitest';
import { type PullRequest, type SearchItem } from '../../src/clients/gheTypes';
import { type ChangeStatus } from '../../src/clients/zuulTypes';
import {
  extractRemovalCoordinates,
  formatDownstreamLabel,
  formatUpstreamDescription,
  formatUpstreamLabel,
  formatUpstreamTooltip,
  formatUpstreamZuulSummary,
  getUpstreamIconId,
  resolveUpstreamUrl,
} from '../../src/services/dependsOnPresentation';
import { type UpstreamDep } from '../../src/services/dependsOnService';

function status(overrides: Partial<ChangeStatus> = {}): ChangeStatus {
  return { pipeline: 'check', queue: 'q', live: true, jobs: [], itemsAhead: [], ...overrides };
}

function job(result: string | undefined): ChangeStatus['jobs'][number] {
  return { name: 'j', result } as ChangeStatus['jobs'][number];
}

function dep(overrides: Partial<UpstreamDep> = {}): UpstreamDep {
  return {
    ref: { raw: 'org/repo#5', line: 0, kind: 'shorthand', owner: 'org', repo: 'repo', number: 5 },
    state: 'open',
    inTenant: true,
    ...overrides,
  };
}

describe('getUpstreamIconId', () => {
  it('maps every state', () => {
    expect(getUpstreamIconId('open')).toBe('git-pull-request');
    expect(getUpstreamIconId('merged')).toBe('git-merge');
    expect(getUpstreamIconId('closed')).toBe('git-pull-request-closed');
    expect(getUpstreamIconId('missing')).toBe('warning');
  });
});

describe('formatUpstreamLabel', () => {
  it('formats owner/repo#n', () => {
    expect(formatUpstreamLabel(dep())).toBe('org/repo#5');
  });

  it('falls back to the raw text', () => {
    expect(formatUpstreamLabel(dep({ ref: { raw: 'weird', line: 0, kind: 'unknown' } }))).toBe(
      'weird',
    );
  });
});

describe('formatUpstreamZuulSummary', () => {
  it('handles missing statuses', () => {
    expect(formatUpstreamZuulSummary(undefined)).toBe('not in Zuul');
    expect(formatUpstreamZuulSummary([])).toBe('not in Zuul');
  });

  it('shows queued when there are no jobs, defaulting the pipeline to check', () => {
    expect(formatUpstreamZuulSummary([status({ pipeline: 'gate' })])).toBe('gate: queued');
    expect(formatUpstreamZuulSummary([status({ pipeline: '' })])).toBe('check: queued');
  });

  it('prefers the gate pipeline', () => {
    expect(
      formatUpstreamZuulSummary([status({ pipeline: 'check' }), status({ pipeline: 'gate' })]),
    ).toBe('gate: queued');
  });

  it('shows progress, success and failure', () => {
    expect(formatUpstreamZuulSummary([status({ jobs: [job('SUCCESS'), job(undefined)] })])).toBe(
      'check: 1/2',
    );
    expect(formatUpstreamZuulSummary([status({ jobs: [job('SUCCESS')] })])).toBe('check: SUCCESS');
    expect(formatUpstreamZuulSummary([status({ jobs: [job('SUCCESS'), job('FAILURE')] })])).toBe(
      'check: FAILURE',
    );
  });
});

describe('description and tooltip', () => {
  it('joins state and zuul summary', () => {
    expect(formatUpstreamDescription(dep())).toBe('open · not in Zuul');
  });

  it('builds a tooltip with title and warning', () => {
    const tooltip = formatUpstreamTooltip(
      dep({ pr: { title: 'My title' } as PullRequest, warning: 'careful' }),
    );
    expect(tooltip).toBe('org/repo#5: My title\nState: open\nZuul: not in Zuul\nWarning: careful');
  });

  it('omits title and warning when absent', () => {
    expect(formatUpstreamTooltip(dep())).toBe('org/repo#5\nState: open\nZuul: not in Zuul');
  });
});

describe('resolveUpstreamUrl', () => {
  it('prefers the PR html_url, then the ref url, then builds one', () => {
    expect(resolveUpstreamUrl(dep({ pr: { html_url: 'https://pr' } as PullRequest }))).toBe(
      'https://pr',
    );
    expect(resolveUpstreamUrl(dep({ ref: { ...dep().ref, url: 'https://ref' } }))).toBe(
      'https://ref',
    );
    expect(resolveUpstreamUrl(dep(), 'ghe.example.com')).toBe(
      'https://ghe.example.com/org/repo/pull/5',
    );
    expect(resolveUpstreamUrl(dep({ ref: { ...dep().ref, host: 'other.com' } }), 'x')).toBe(
      'https://other.com/org/repo/pull/5',
    );
  });

  it('returns undefined with no host', () => {
    expect(resolveUpstreamUrl(dep())).toBeUndefined();
  });
});

describe('formatDownstreamLabel', () => {
  const item: SearchItem = {
    number: 9,
    title: 't',
    html_url: 'https://ghe.example.com/org/repo/pull/9',
    state: 'open',
  };

  it('formats from the html_url', () => {
    expect(formatDownstreamLabel(item, 'ghe.example.com')).toBe('org/repo#9');
  });

  it('falls back to #n', () => {
    expect(formatDownstreamLabel({ ...item, html_url: '' })).toBe('#9');
  });
});

describe('extractRemovalCoordinates', () => {
  const coords = { owner: 'org', repo: 'repo', number: 5 };

  it('reads plain coordinates, refs and upstream nodes', () => {
    expect(extractRemovalCoordinates(coords)).toEqual(coords);
    expect(extractRemovalCoordinates({ ref: coords })).toEqual(coords);
    expect(extractRemovalCoordinates({ kind: 'upstream-dep', dep: dep() })).toEqual(coords);
  });

  it('returns undefined for anything else', () => {
    expect(extractRemovalCoordinates(undefined)).toBeUndefined();
    expect(extractRemovalCoordinates('x')).toBeUndefined();
    expect(extractRemovalCoordinates({ owner: 'a', repo: 'b' })).toBeUndefined();
  });
});
