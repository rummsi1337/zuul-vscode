import { describe, expect, it } from 'vitest';
import { type SearchItem } from '../../src/clients/gheTypes';
import {
  buildSectionedQuickPickItems,
  buildTenantProjectSet,
  type DependsOnCandidate,
  HTTP_PR_URL_RE,
  parsePrUrlCandidate,
  searchItemToCandidate,
  toQuickPickItem,
} from '../../src/services/dependsOnCandidates';

function cand(n: number, title?: string): DependsOnCandidate {
  return {
    host: 'ghe.example.com',
    owner: 'org',
    repo: 'repo',
    number: n,
    url: `https://ghe.example.com/org/repo/pull/${n}`,
    ...(title ? { title } : {}),
  };
}

describe('parsePrUrlCandidate', () => {
  it('parses a full PR URL', () => {
    expect(parsePrUrlCandidate('https://GHE.example.com/org/repo/pull/12')).toMatchObject({
      host: 'ghe.example.com',
      owner: 'org',
      repo: 'repo',
      number: 12,
      url: 'https://ghe.example.com/org/repo/pull/12',
    });
  });

  it('accepts a /files suffix', () => {
    expect(parsePrUrlCandidate('https://ghe.example.com/org/repo/pull/12/files')?.number).toBe(12);
  });

  it('returns undefined for empty or non-PR input', () => {
    expect(parsePrUrlCandidate('   ')).toBeUndefined();
    expect(parsePrUrlCandidate('https://ghe.example.com/org/repo/issues/12')).toBeUndefined();
    expect(parsePrUrlCandidate('hello')).toBeUndefined();
  });

  it('matches the HTTP regex only for pull URLs', () => {
    expect(HTTP_PR_URL_RE.test('https://h/o/r/pull/0')).toBe(false);
    expect(HTTP_PR_URL_RE.test('http://h/o/r/pull/3')).toBe(true);
  });
});

describe('searchItemToCandidate', () => {
  const base: SearchItem = { number: 3, title: 'Hello', html_url: '', state: 'open' };

  it('copies the title onto the candidate', () => {
    const c = searchItemToCandidate(
      { ...base, html_url: 'https://ghe.example.com/org/repo/pull/3' },
      'ghe.example.com',
    );
    expect(c).toMatchObject({ owner: 'org', repo: 'repo', number: 3, title: 'Hello' });
  });

  it('returns undefined without a usable html_url', () => {
    expect(searchItemToCandidate(base, 'ghe.example.com')).toBeUndefined();
    expect(
      searchItemToCandidate({ ...base, html_url: 'https://x/y' }, 'ghe.example.com'),
    ).toBeUndefined();
  });
});

describe('buildTenantProjectSet', () => {
  it('lowercases and normalises names, including the current project', () => {
    const set = buildTenantProjectSet(
      [{ name: 'Org/Repo', canonical_name: 'ghe.example.com/Org/Repo' }, { name: 'a/b' }] as never,
      'ghe.example.com/Cur/Proj',
    );
    expect([...set].sort()).toEqual(['a/b', 'cur/proj', 'org/repo']);
  });
});

describe('toQuickPickItem', () => {
  it('uses the title as description and URL as detail', () => {
    const c = cand(1, 'Title');
    expect(toQuickPickItem(c, true)).toEqual({
      label: 'org/repo#1',
      description: 'Title',
      detail: c.url,
      alwaysShow: true,
      candidate: c,
    });
  });

  it('falls back to the URL when there is no title', () => {
    const c = cand(2);
    expect(toQuickPickItem(c)).toMatchObject({
      description: c.url,
      detail: undefined,
      alwaysShow: false,
    });
  });
});

describe('buildSectionedQuickPickItems', () => {
  it('orders sections pasted, search, mine, workspace', () => {
    const rows = buildSectionedQuickPickItems({
      pastedCandidate: cand(1),
      searchPrs: [cand(2)],
      myPrs: [cand(3)],
      workspacePrs: [cand(4)],
    });
    expect(rows.map((r) => (r.separator ? `-${r.label}` : r.label))).toEqual([
      '-Pasted URL',
      '$(link) org/repo#1',
      '-Search results',
      'org/repo#2',
      '-My open PRs',
      'org/repo#3',
      '-Workspace repositories',
      'org/repo#4',
    ]);
    expect(rows[0]).toEqual({ label: 'Pasted URL', separator: true });
    expect(rows[1].alwaysShow).toBe(true);
    expect(rows[3].alwaysShow).toBe(true);
    expect(rows[5].alwaysShow).toBe(false);
  });

  it('omits empty sections', () => {
    expect(buildSectionedQuickPickItems({ myPrs: [], workspacePrs: [] })).toEqual([]);
  });
});
