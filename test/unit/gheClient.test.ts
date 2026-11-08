import { describe, expect, it, vi } from 'vitest';
import { GheClient, parseNextLink } from '../../src/clients/gheClient';
import { HttpError } from '../../src/clients/http';
import { RateLimitedError } from '../../src/clients/rateLimit';
import checkRunsFixture from '../fixtures/ghe/check-runs.json';
import combinedStatusFixture from '../fixtures/ghe/combined-status.json';
import prRollupFixture from '../fixtures/ghe/pr-rollup.json';
import pullRequestFixture from '../fixtures/ghe/pull-request.json';
import requiredStatusChecksFixture from '../fixtures/ghe/required-status-checks.json';
import reviewsPage1Fixture from '../fixtures/ghe/reviews-page1.json';
import reviewsPage2Fixture from '../fixtures/ghe/reviews-page2.json';
import searchPrsFixture from '../fixtures/ghe/search-prs.json';

function jsonResponse(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('parseNextLink', () => {
  it('extracts next page URL from Link header', () => {
    expect(parseNextLink(null)).toBeUndefined();
    expect(
      parseNextLink(
        '<https://ghe.example.com/api/v3/repos/acme/service/pulls/42/reviews?page=1>; rel="prev"',
      ),
    ).toBeUndefined();
    expect(
      parseNextLink(
        '<https://ghe.example.com/api/v3/repos/acme/service/pulls/42/reviews?page=2>; rel="next", <https://ghe.example.com/api/v3/repos/acme/service/pulls/42/reviews?page=4>; rel="last"',
      ),
    ).toBe('https://ghe.example.com/api/v3/repos/acme/service/pulls/42/reviews?page=2');
  });
});

describe('GheClient', () => {
  it('uses /api/v3 and /api/graphql for GHE hosts and api.github.com for github.com', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ login: 'alice' }));

    const ghe = new GheClient('ghe.example.com', async () => 'ghp_123', fetchFn);
    expect(ghe.restBaseUrl).toBe('https://ghe.example.com/api/v3');
    expect(ghe.graphqlUrl).toBe('https://ghe.example.com/api/graphql');

    const user = await ghe.getUser();
    expect(user).toEqual({ login: 'alice' });
    expect(fetchFn).toHaveBeenLastCalledWith(
      'https://ghe.example.com/api/v3/user',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer ghp_123',
        }),
      }),
    );

    const ghCom = new GheClient('GitHub.com', async () => undefined, fetchFn);
    expect(ghCom.restBaseUrl).toBe('https://api.github.com');
    expect(ghCom.graphqlUrl).toBe('https://api.github.com/graphql');

    const callsBefore = fetchFn.mock.calls.length;
    await expect(ghCom.getUser()).rejects.toMatchObject({ status: 401 });
    expect(fetchFn.mock.calls.length).toBe(callsBefore);
  });

  it('sends no GET or GraphQL request without a token', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const client = new GheClient('ghe.example.com', async () => undefined, fetchFn);

    const err = await client.getPr('o', 'r', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
    await expect(client.getPrRollup('o', 'r', 1)).rejects.toMatchObject({ status: 401 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('finds open PR for a branch or returns undefined when none exists', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([pullRequestFixture]))
      .mockResolvedValueOnce(jsonResponse([]));

    const client = new GheClient('ghe.example.com', async () => 'tok', fetchFn);

    const pr = await client.findOpenPrForBranch('acme', 'service', 'feat/zuul-pipeline');
    expect(pr?.number).toBe(42);
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      'https://ghe.example.com/api/v3/repos/acme/service/pulls?state=open&head=acme%3Afeat%2Fzuul-pipeline',
      expect.anything(),
    );

    const none = await client.findOpenPrForBranch('acme', 'service', 'no-pr');
    expect(none).toBeUndefined();
  });

  it('gets a PR, updates PR body, and throws HttpError on 404', async () => {
    const updatedFixture = { ...pullRequestFixture, body: 'Updated body' };
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(pullRequestFixture))
      .mockResolvedValueOnce(jsonResponse(updatedFixture))
      .mockResolvedValueOnce(new Response('{"message":"Not Found"}', { status: 404 }));

    const client = new GheClient('ghe.example.com', async () => 'tok', fetchFn);

    const pr = await client.getPr('acme', 'service', 42);
    expect(pr.title).toBe('Add Zuul check pipeline');

    const updated = await client.updatePrBody('acme', 'service', 42, 'Updated body');
    expect(updated.body).toBe('Updated body');
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      'https://ghe.example.com/api/v3/repos/acme/service/pulls/42',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ body: 'Updated body' }),
      }),
    );

    await expect(client.getPr('acme', 'service', 999)).rejects.toThrowError(HttpError);
  });

  it('sends no token to a Link next page on another origin', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse([{ id: 1 }], 200, {
          Link: '<https://evil.example.org/steal?page=2>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(jsonResponse([{ id: 2 }]));
    const client = new GheClient('ghe.example.com', async () => 'tok', fetchFn);

    await client.listReviews('acme', 'service', 42);

    const first = fetchFn.mock.calls[0]?.[1] as { headers: Record<string, string> };
    const second = fetchFn.mock.calls[1]?.[1] as { headers: Record<string, string> };
    expect(fetchFn.mock.calls[1]?.[0]).toBe('https://evil.example.org/steal?page=2');
    expect(first.headers.Authorization).toBe('Bearer tok');
    expect(second.headers.Authorization).toBeUndefined();
  });

  it('paginates listReviews following Link rel="next" and stops at 10 pages max', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(reviewsPage1Fixture, 200, {
          Link: '<https://ghe.example.com/api/v3/repos/acme/service/pulls/42/reviews?page=2>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(reviewsPage2Fixture, 200));

    const client = new GheClient('ghe.example.com', async () => 'tok', fetchFn);
    const reviews = await client.listReviews('acme', 'service', 42);

    expect(reviews).toHaveLength(3);
    expect(reviews.map((r) => r.id)).toEqual([101, 102, 103]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'https://ghe.example.com/api/v3/repos/acme/service/pulls/42/reviews?per_page=100',
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      'https://ghe.example.com/api/v3/repos/acme/service/pulls/42/reviews?page=2',
      expect.anything(),
    );

    // Cap at 10 pages when Link header always returns a next page
    let pageCounter = 1;
    const infiniteFetchFn = vi.fn<typeof fetch>(async () => {
      pageCounter += 1;
      return jsonResponse([{ id: pageCounter, user: { login: 'u' }, state: 'APPROVED' }], 200, {
        Link: `<https://ghe.example.com/api/v3/repos/acme/service/pulls/42/reviews?page=${pageCounter}>; rel="next"`,
      });
    });

    const cappedClient = new GheClient('ghe.example.com', async () => 'tok', infiniteFetchFn);
    const cappedReviews = await cappedClient.listReviews('acme', 'service', 42);
    expect(infiniteFetchFn).toHaveBeenCalledTimes(10);
    expect(cappedReviews).toHaveLength(10);
  });

  it('lists commit statuses and check runs', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(combinedStatusFixture))
      .mockResolvedValueOnce(jsonResponse(checkRunsFixture))
      .mockResolvedValueOnce(jsonResponse(checkRunsFixture.check_runs));

    const client = new GheClient('ghe.example.com', async () => 'tok', fetchFn);

    const status = await client.listCommitStatuses('acme', 'service', '9f8e7d6c5b4a3210');
    expect(status.state).toBe('success');
    expect(status.statuses).toHaveLength(2);

    const runs = await client.listCheckRuns('acme', 'service', '9f8e7d6c5b4a3210');
    expect(runs).toHaveLength(2);
    expect(runs[0]?.name).toBe('sonarqube');

    const directArrayRuns = await client.listCheckRuns('acme', 'service', '9f8e7d6c5b4a3210');
    expect(directArrayRuns).toHaveLength(2);
  });

  it('gets required status checks and returns undefined on 403 or 404', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(requiredStatusChecksFixture))
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

    const client = new GheClient('ghe.example.com', async () => 'tok', fetchFn);

    const checks = await client.getRequiredStatusChecks('acme', 'service', 'main');
    expect(checks?.contexts).toEqual(['acme-tenant/check', 'sonarqube']);

    expect(await client.getRequiredStatusChecks('acme', 'service', 'main')).toBeUndefined();
    expect(await client.getRequiredStatusChecks('acme', 'service', 'main')).toBeUndefined();

    await expect(client.getRequiredStatusChecks('acme', 'service', 'main')).rejects.toThrowError(
      HttpError,
    );
  });

  it('paginates check runs across pages (e.g. 31 runs)', async () => {
    const page1Runs = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      name: `check-${i + 1}`,
      status: 'completed',
      conclusion: 'success',
    }));
    const page2Runs = [{ id: 31, name: 'check-31', status: 'completed', conclusion: 'success' }];
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ check_runs: page1Runs }, 200, {
          Link: '<https://ghe.example.com/api/v3/repos/acme/service/commits/sha/check-runs?per_page=100&page=2>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ check_runs: page2Runs }, 200));

    const client = new GheClient('ghe.example.com', async () => 'tok', fetchFn);
    const runs = await client.listCheckRuns('acme', 'service', 'sha');
    expect(runs).toHaveLength(31);
    expect(runs[0]?.name).toBe('check-1');
    expect(runs[30]?.name).toBe('check-31');
  });

  it('gets required contexts via GraphQL refUpdateRule and falls back to REST on failure', async () => {
    // 1. GraphQL succeeds
    const graphqlSuccessFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: {
          repository: {
            ref: {
              refUpdateRule: {
                requiredStatusCheckContexts: ['ci/build', 'ci/test', 'ci/build', null],
              },
            },
          },
        },
      }),
    );
    const client1 = new GheClient('ghe.example.com', async () => 'tok', graphqlSuccessFetch);
    const contexts1 = await client1.getRequiredContexts('acme', 'service', 'main');
    expect(contexts1).toEqual(['ci/build', 'ci/test']);

    // 2. GraphQL fails, falls back to REST
    const fallbackFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('GraphQL not supported', { status: 500 }))
      .mockResolvedValueOnce(
        jsonResponse({
          strict: true,
          contexts: ['rest/lint'],
          checks: [{ context: 'rest/sonar' }, { context: 'rest/lint' }],
        }),
      );
    const client2 = new GheClient('ghe.example.com', async () => 'tok', fallbackFetch);
    const contexts2 = await client2.getRequiredContexts('acme', 'service', 'main');
    expect(contexts2).toEqual(['rest/lint', 'rest/sonar']);

    // 3. GraphQL refUpdateRule is null/missing, REST returns 404 -> undefined
    const missingFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            repository: {
              ref: {
                refUpdateRule: null,
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    const client3 = new GheClient('ghe.example.com', async () => 'tok', missingFetch);
    const contexts3 = await client3.getRequiredContexts('acme', 'service', 'main');
    expect(contexts3).toBeUndefined();
  });

  it('reads branch merge rules via GraphQL and returns undefined when it cannot', async () => {
    const ruleResponse = (rule: unknown): Response =>
      jsonResponse({ data: { repository: { ref: { refUpdateRule: rule } } } });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        ruleResponse({
          requiredApprovingReviewCount: 2,
          requiresConversationResolution: true,
          requiresSignatures: false,
        }),
      )
      .mockResolvedValueOnce(
        ruleResponse({
          requiredApprovingReviewCount: null,
          requiresConversationResolution: false,
          requiresSignatures: true,
        }),
      )
      .mockResolvedValueOnce(ruleResponse(null))
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: "Field 'requiresSignatures' doesn't exist" }] }),
      )
      .mockResolvedValueOnce(new Response('Internal Error', { status: 500 }));
    const client = new GheClient('ghe.example.com', async () => 'tok', fetchFn);

    expect(await client.getBranchMergeRules('acme', 'service', 'main')).toEqual({
      requiredApprovingReviewCount: 2,
      requiresConversationResolution: true,
      requiresSignatures: false,
    });
    expect(await client.getBranchMergeRules('acme', 'service', 'main')).toEqual({
      requiredApprovingReviewCount: 0,
      requiresConversationResolution: false,
      requiresSignatures: true,
    });
    expect(await client.getBranchMergeRules('acme', 'service', 'main')).toBeUndefined();
    expect(await client.getBranchMergeRules('acme', 'service', 'main')).toBeUndefined();
    expect(await client.getBranchMergeRules('acme', 'service', 'main')).toBeUndefined();
  });

  it('fetches PR rollup via GraphQL and returns undefined on GraphQL or HTTP errors', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(prRollupFixture))
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: 'Field isRequired is not supported' }] }),
      )
      .mockResolvedValueOnce(new Response('Internal Error', { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ data: { repository: { pullRequest: null } } }));

    const client = new GheClient('ghe.example.com', async () => 'tok', fetchFn);

    const rollup = await client.getPrRollup('acme', 'service', 42);
    expect(rollup?.reviewDecision).toBe('APPROVED');
    expect(rollup?.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes).toHaveLength(2);
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      'https://ghe.example.com/api/graphql',
      expect.objectContaining({
        method: 'POST',
      }),
    );

    expect(await client.getPrRollup('acme', 'service', 42)).toBeUndefined();
    expect(await client.getPrRollup('acme', 'service', 42)).toBeUndefined();
    expect(await client.getPrRollup('acme', 'service', 42)).toBeUndefined();
  });

  it('rethrows 401 and 403 from the PR rollup', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
    const client = new GheClient('ghe.example.com', async () => 'tok', fetchFn);

    await expect(client.getPrRollup('acme', 'service', 42)).rejects.toMatchObject({ status: 401 });
    await expect(client.getPrRollup('acme', 'service', 42)).rejects.toMatchObject({ status: 403 });
  });

  it('encodes owner and repo in REST paths', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ number: 1 }));
    const client = new GheClient('ghe.example.com', async () => 'tok', fetchFn);

    await client.getPr('a b', 'c/d', 1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'https://ghe.example.com/api/v3/repos/a%20b/c%2Fd/pulls/1',
    );
  });

  it('posts issue comments and searches PRs with +is:pr', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: 900,
          html_url: 'https://ghe.example.com/acme/service/pull/42#issuecomment-900',
          body: 'recheck',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(searchPrsFixture))
      .mockResolvedValueOnce(jsonResponse({ total_count: 0 }));

    const client = new GheClient('ghe.example.com', async () => 'tok', fetchFn);

    const comment = await client.postIssueComment('acme', 'service', 42, 'recheck');
    expect(comment.id).toBe(900);
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      'https://ghe.example.com/api/v3/repos/acme/service/issues/42/comments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ body: 'recheck' }),
      }),
    );

    const items = await client.searchPrs('is:open author:@me', 15);
    expect(items).toHaveLength(1);
    expect(items[0]?.number).toBe(99);
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      'https://ghe.example.com/api/v3/search/issues?q=is%3Aopen+author%3A%40me+is%3Apr&per_page=15',
      expect.anything(),
    );

    const emptyItems = await client.searchPrs('is:pr author:bob');
    expect(emptyItems).toEqual([]);
    expect(fetchFn).toHaveBeenNthCalledWith(
      3,
      'https://ghe.example.com/api/v3/search/issues?q=is%3Apr+author%3Abob&per_page=20',
      expect.anything(),
    );
  });

  it('sends conditional GETs and reuses the body on 304', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(pullRequestFixture, 200, { ETag: '"pr"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const client = new GheClient('ghe.example.com', async () => 'tok', fetchFn);

    const first = await client.getPr('acme', 'service', 42);
    const second = await client.getPr('acme', 'service', 42);

    expect(second).toEqual(first);
    const sent = fetchFn.mock.calls[1]?.[1] as { headers: Record<string, string> };
    expect(sent.headers['If-None-Match']).toBe('"pr"');
  });

  it('does not fall back to REST while rate limited', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 429, { 'retry-after': '60' }));
    const client = new GheClient('ghe.example.com', async () => 'tok', fetchFn);

    await expect(client.getRequiredContexts('acme', 'service', 'main')).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    await expect(client.getBranchMergeRules('acme', 'service', 'main')).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    await expect(client.getPrRollup('acme', 'service', 1)).rejects.toBeInstanceOf(RateLimitedError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
