import { type PullRequest } from '../../src/clients/gheTypes';

export function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 42,
    html_url: 'https://ghe.example.com/acme/service/pull/42',
    title: 'Add feature X',
    state: 'open',
    draft: false,
    merged: false,
    body: 'PR description',
    head: {
      sha: 'pr-head-sha-1',
      ref: 'feat/x',
      repo: { full_name: 'acme/service' },
    },
    base: {
      ref: 'main',
      repo: { full_name: 'acme/service' },
    },
    user: { login: 'alice' },
    labels: [],
    ...overrides,
  };
}
