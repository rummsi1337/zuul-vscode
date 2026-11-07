import { describe, expect, it } from 'vitest';
import {
  addDependsOn,
  parseDependsOn,
  removeDependsOn,
  toPrUrl,
} from '../../src/services/dependsOnParser';

describe('dependsOnParser', () => {
  describe('toPrUrl', () => {
    it('builds a canonical PR URL with lowercased host', () => {
      expect(toPrUrl('GHE.Example.com', 'org', 'repo', 42)).toBe(
        'https://ghe.example.com/org/repo/pull/42',
      );
    });
  });

  describe('parseDependsOn', () => {
    it('returns empty array for null or empty body', () => {
      expect(parseDependsOn(null)).toEqual([]);
      expect(parseDependsOn('')).toEqual([]);
      expect(parseDependsOn('Just a regular PR description without dependencies.')).toEqual([]);
    });

    it('parses URL, shorthand, and unknown forms case-insensitively across LF and CRLF', () => {
      const body = [
        '## Summary',
        '- [x] Unit tests',
        '',
        'Depends-On: https://ghe.example.com/org/lib/pull/12',
        '  depends-on:   https://ghe.example.com/org/api/pull/34/files#diff-abc  ',
        'DEPENDS-ON: https://ghe.example.com/org/web/pull/56/',
        'Depends-On: org/other#78',
        'Depends-On: I1234567890abcdef',
      ].join('\r\n');

      const refs = parseDependsOn(body);
      expect(refs).toEqual([
        {
          raw: 'https://ghe.example.com/org/lib/pull/12',
          line: 4,
          kind: 'url',
          host: 'ghe.example.com',
          owner: 'org',
          repo: 'lib',
          number: 12,
          url: 'https://ghe.example.com/org/lib/pull/12',
        },
        {
          raw: 'https://ghe.example.com/org/api/pull/34/files#diff-abc',
          line: 5,
          kind: 'url',
          host: 'ghe.example.com',
          owner: 'org',
          repo: 'api',
          number: 34,
          url: 'https://ghe.example.com/org/api/pull/34',
        },
        {
          raw: 'https://ghe.example.com/org/web/pull/56/',
          line: 6,
          kind: 'url',
          host: 'ghe.example.com',
          owner: 'org',
          repo: 'web',
          number: 56,
          url: 'https://ghe.example.com/org/web/pull/56',
        },
        {
          raw: 'org/other#78',
          line: 7,
          kind: 'shorthand',
          owner: 'org',
          repo: 'other',
          number: 78,
        },
        {
          raw: 'I1234567890abcdef',
          line: 8,
          kind: 'unknown',
        },
      ]);
    });

    it('deduplicates by owner/repo#n keeping the first occurrence', () => {
      const body = [
        'Depends-On: https://ghe.example.com/org/repo/pull/42',
        'Depends-On: https://ghe.example.com/org/repo/pull/42/files',
        'Depends-On: ORG/REPO#42',
        'Depends-On: org/repo#99',
      ].join('\n');

      const refs = parseDependsOn(body);
      expect(refs).toHaveLength(2);
      expect(refs[0]).toMatchObject({
        line: 1,
        kind: 'url',
        owner: 'org',
        repo: 'repo',
        number: 42,
      });
      expect(refs[1]).toMatchObject({
        line: 4,
        kind: 'shorthand',
        owner: 'org',
        repo: 'repo',
        number: 99,
      });
    });

    it('treats invalid owner/repo segments as unknown', () => {
      const body = [
        'Depends-On: https://ghe.example.com/./repo/pull/10',
        'Depends-On: ../repo#10',
      ].join('\n');

      const refs = parseDependsOn(body);
      expect(refs).toEqual([
        { raw: 'https://ghe.example.com/./repo/pull/10', line: 1, kind: 'unknown' },
        { raw: '../repo#10', line: 2, kind: 'unknown' },
      ]);
    });
  });

  describe('addDependsOn', () => {
    const url1 = 'https://ghe.example.com/org/repo/pull/10';
    const url2 = 'https://ghe.example.com/org/repo/pull/20';

    it('returns just the Depends-On line when body is empty or null', () => {
      expect(addDependsOn('', url1)).toBe(`Depends-On: ${url1}`);
      expect(addDependsOn(null, url1)).toBe(`Depends-On: ${url1}`);
    });

    it('appends after two EOLs when body ends with normal markdown/checklists (LF and CRLF)', () => {
      const lfBody = '## Checklist\n- [x] Tested\n- [ ] Reviewed';
      expect(addDependsOn(lfBody, url1)).toBe(`${lfBody}\n\nDepends-On: ${url1}`);

      const crlfBody = '## Checklist\r\n- [x] Tested\r\n- [ ] Reviewed';
      expect(addDependsOn(crlfBody, url1)).toBe(`${crlfBody}\r\n\r\nDepends-On: ${url1}`);
    });

    it('appends after a single EOL when body already ends with a blank line', () => {
      const body = '## Summary\nSome details\n';
      expect(addDependsOn(body, url1)).toBe(`## Summary\nSome details\n\nDepends-On: ${url1}`);

      const crlfBody = '## Summary\r\nSome details\r\n';
      expect(addDependsOn(crlfBody, url1)).toBe(
        `## Summary\r\nSome details\r\n\r\nDepends-On: ${url1}`,
      );
    });

    it('appends directly to an existing contiguous block of Depends-On lines', () => {
      const body = `## Summary\n\nDepends-On: ${url1}`;
      expect(addDependsOn(body, url2)).toBe(
        `## Summary\n\nDepends-On: ${url1}\nDepends-On: ${url2}`,
      );
    });

    it('is a no-op if the same PR is already referenced in URL or shorthand form', () => {
      const withUrl = `## Summary\n\nDepends-On: ${url1}`;
      expect(addDependsOn(withUrl, url1)).toBe(withUrl);
      expect(addDependsOn(withUrl, `${url1}/files`)).toBe(withUrl);

      const withShorthand = '## Summary\n\nDepends-On: org/repo#10';
      expect(addDependsOn(withShorthand, url1)).toBe(withShorthand);

      const withUnknown = 'Depends-On: custom-token';
      expect(addDependsOn(withUnknown, 'custom-token')).toBe(withUnknown);
    });
  });

  describe('removeDependsOn', () => {
    const url1 = 'https://ghe.example.com/org/repo/pull/10';
    const url2 = 'https://ghe.example.com/org/repo/pull/20';

    it('handles empty or null body and non-matching refs as no-op', () => {
      expect(removeDependsOn('', { owner: 'org', repo: 'repo', number: 10 })).toBe('');
      expect(removeDependsOn(null, { owner: 'org', repo: 'repo', number: 10 })).toBe('');

      const body = `## Summary\n\nDepends-On: ${url1}`;
      expect(removeDependsOn(body, { owner: 'org', repo: 'repo', number: 999 })).toBe(body);
    });

    it('removes every matching line in any form and collapses trailing blank lines', () => {
      const body = [
        '## Summary',
        '- [x] Item 1',
        '',
        '',
        '',
        `Depends-On: ${url1}`,
        'Depends-On: org/repo#10',
        `Depends-On: ${url1}/files#diff`,
      ].join('\n');

      expect(removeDependsOn(body, { owner: 'org', repo: 'repo', number: 10 })).toBe(
        '## Summary\n- [x] Item 1',
      );
    });

    it('keeps other Depends-On lines intact when removing one of multiple dependencies', () => {
      const body = `## Summary\n\nDepends-On: ${url1}\nDepends-On: ${url2}`;
      expect(removeDependsOn(body, { owner: 'org', repo: 'repo', number: 10 })).toBe(
        `## Summary\n\nDepends-On: ${url2}`,
      );
      expect(removeDependsOn(body, { owner: 'org', repo: 'repo', number: 20 })).toBe(
        `## Summary\n\nDepends-On: ${url1}`,
      );
    });

    it('satisfies round-trip add -> remove = original for LF, CRLF, and empty bodies', () => {
      const originals = [
        '',
        'Simple one-liner',
        '## Title\n\n- [x] Check 1\n- [ ] Check 2\n\nParagraph with **markdown**.',
        '## Title\r\n\r\n- [x] Check 1\r\n- [ ] Check 2',
        `## Title\n\nDepends-On: ${url1}`,
        `## Title\r\n\r\nDepends-On: ${url1}`,
      ];

      for (const original of originals) {
        const added = addDependsOn(original, url2);
        const removed = removeDependsOn(added, { owner: 'org', repo: 'repo', number: 20 });
        expect(removed).toBe(original);
      }
    });
  });
});
