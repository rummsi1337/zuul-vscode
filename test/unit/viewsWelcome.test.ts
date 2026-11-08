import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface Welcome {
  view: string;
  when?: string;
  contents: string;
}

const manifest = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
  contributes: { viewsWelcome: Welcome[] };
};

type Ctx = Record<string, string | boolean | undefined>;

// Minimal evaluator for the `when` syntax used in package.json: ! && || ( ) == != and keys.
function evaluate(expr: string, ctx: Ctx): boolean {
  const tokens = expr.match(/'[^']*'|==|!=|&&|\|\||!|\(|\)|[\w.]+/g) ?? [];
  let pos = 0;
  const value = (token: string): string | boolean | undefined =>
    token.startsWith("'") ? token.slice(1, -1) : ctx[token];
  const parseOr = (): boolean => {
    let left = parseAnd();
    while (tokens[pos] === '||') {
      pos++;
      const right = parseAnd();
      left = left || right;
    }
    return left;
  };
  const parseAnd = (): boolean => {
    let left = parseUnary();
    while (tokens[pos] === '&&') {
      pos++;
      const right = parseUnary();
      left = left && right;
    }
    return left;
  };
  const parseUnary = (): boolean => {
    if (tokens[pos] === '!') {
      pos++;
      return !parseUnary();
    }
    if (tokens[pos] === '(') {
      pos++;
      const inner = parseOr();
      pos++;
      return inner;
    }
    const key = tokens[pos++];
    const op = tokens[pos];
    if (op === '==' || op === '!=') {
      pos++;
      const rhs = value(tokens[pos++]);
      const equal = value(key) === rhs;
      return op === '==' ? equal : !equal;
    }
    return Boolean(value(key));
  };
  return parseOr();
}

const BASE: Ctx = {
  workbenchState: 'folder',
  'zuul.contextProblem': 'none',
  'zuul.authChecked': true,
  'zuul.signedIn': true,
  'zuul.hasPr': false,
  'zuul.zuulProblem': 'none',
  'zuul.pollState': 'no-pr',
};

const STATES: { name: string; ctx: Ctx; expected: Record<string, string> }[] = [
  {
    name: 'no folder',
    ctx: { ...BASE, workbenchState: 'empty' },
    expected: all('No folder is open'),
  },
  {
    name: 'no repo',
    ctx: { ...BASE, 'zuul.contextProblem': 'no-repo' },
    expected: all('No GitHub or GitHub Enterprise git remote'),
  },
  {
    name: 'no zuul.url',
    ctx: { ...BASE, 'zuul.contextProblem': 'no-zuul-url' },
    expected: all('Set `zuul.url`'),
  },
  {
    name: 'no tenant',
    ctx: { ...BASE, 'zuul.contextProblem': 'no-tenant' },
    expected: all('Could not resolve a Zuul tenant'),
  },
  {
    name: 'Zuul refused the token, pull request found',
    ctx: { ...BASE, 'zuul.hasPr': true, 'zuul.zuulProblem': 'zuul-auth' },
    expected: {
      'zuul.gateReadiness': '',
      'zuul.dependencies': '',
      'zuul.builds': '',
    },
  },
  {
    name: 'Zuul unreachable, pull request found',
    ctx: { ...BASE, 'zuul.hasPr': true, 'zuul.zuulProblem': 'zuul-unreachable' },
    expected: {
      'zuul.gateReadiness': '',
      'zuul.dependencies': '',
      'zuul.builds': '',
    },
  },
  {
    name: 'Zuul unreachable, no pull request',
    ctx: { ...BASE, 'zuul.zuulProblem': 'zuul-unreachable' },
    expected: all('No pull request found'),
  },
  {
    name: 'Zuul problem key not set yet, pull request found',
    ctx: { ...BASE, 'zuul.hasPr': true, 'zuul.zuulProblem': undefined },
    expected: {
      'zuul.gateReadiness': '',
      'zuul.dependencies': '',
      'zuul.builds': 'No Zuul builds for this pull request yet.',
    },
  },
  {
    name: 'loading (set to loading)',
    ctx: { ...BASE, 'zuul.contextProblem': 'loading', 'zuul.authChecked': undefined },
    expected: all('Loading Zuul context'),
  },
  {
    name: 'loading (key unset)',
    ctx: { workbenchState: 'folder' },
    expected: all('Loading Zuul context'),
  },
  {
    name: 'no token',
    ctx: { ...BASE, 'zuul.signedIn': false },
    expected: all('No GitHub token available'),
  },
  {
    name: 'no pull request',
    ctx: BASE,
    expected: all('No pull request found'),
  },
  {
    name: 'token not checked yet, no pull request',
    ctx: { ...BASE, 'zuul.authChecked': undefined, 'zuul.signedIn': undefined },
    expected: all('No pull request found'),
  },
  {
    name: 'load failed (not a missing pull request)',
    ctx: { ...BASE, 'zuul.pollState': 'failed' },
    expected: all('Could not load data from GitHub'),
  },
  {
    name: 'GitHub failing, still retrying',
    ctx: { ...BASE, 'zuul.pollState': 'retrying' },
    expected: all('Could not load data from GitHub, retrying'),
  },
  {
    name: 'no token while retrying',
    ctx: { ...BASE, 'zuul.signedIn': false, 'zuul.pollState': 'retrying' },
    expected: all('No GitHub token available'),
  },
  {
    name: 'no token while polling stopped on auth',
    ctx: { ...BASE, 'zuul.signedIn': false, 'zuul.pollState': 'auth' },
    expected: all('No GitHub token available'),
  },
  {
    name: 'rate limited',
    ctx: { ...BASE, 'zuul.pollState': 'rate-limited' },
    expected: all('Could not load data from GitHub'),
  },
  {
    name: 'pull request found',
    ctx: { ...BASE, 'zuul.hasPr': true },
    expected: {
      'zuul.gateReadiness': '',
      'zuul.dependencies': '',
      'zuul.builds': 'No Zuul builds for this pull request yet.',
    },
  },
];

function all(prefix: string): Record<string, string> {
  return {
    'zuul.gateReadiness': prefix,
    'zuul.dependencies': prefix,
    'zuul.builds': prefix,
  };
}

describe('viewsWelcome ladder', () => {
  const welcomes = manifest.contributes.viewsWelcome;

  for (const state of STATES) {
    for (const view of ['zuul.gateReadiness', 'zuul.dependencies', 'zuul.builds']) {
      it(`${state.name}: ${view} shows exactly the expected message`, () => {
        const matches = welcomes.filter(
          (w) => w.view === view && evaluate(w.when ?? 'true', state.ctx),
        );
        const expected = state.expected[view];
        if (expected === '') {
          expect(matches).toEqual([]);
          return;
        }
        expect(matches).toHaveLength(1);
        expect(matches[0].contents.startsWith(expected)).toBe(true);
      });
    }
  }
});
