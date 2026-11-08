import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../../src/clients/http';
import { bucketForUrl, RateLimitedError, RateLimitGuard } from '../../src/clients/rateLimit';

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function setup(responses: Response[]) {
  let now = 1_000_000;
  const guard = new RateLimitGuard(() => now);
  const fetchFn = vi.fn<typeof fetch>();
  for (const r of responses) fetchFn.mockResolvedValueOnce(r);
  const client = new HttpClient({
    baseUrl: 'https://ghe.example.com/api/v3',
    fetchFn,
    rateLimit: guard,
  });
  return {
    client,
    fetchFn,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe('bucketForUrl', () => {
  it('splits core, search and graphql', () => {
    expect(bucketForUrl('https://ghe.example.com/api/v3/repos/a/b')).toBe('core');
    expect(bucketForUrl('https://ghe.example.com/api/v3/search/issues?q=x')).toBe('search');
    expect(bucketForUrl('https://api.github.com/graphql')).toBe('graphql');
    expect(bucketForUrl('https://ghe.example.com/api/graphql')).toBe('graphql');
  });

  it('keeps repos and branches named search or graphql in core', () => {
    const base = 'https://ghe.example.com/api/v3/repos';
    expect(bucketForUrl(`${base}/acme/search/pulls/1`)).toBe('core');
    expect(bucketForUrl(`${base}/o/r/branches/search/protection`)).toBe('core');
    expect(bucketForUrl(`${base}/acme/graphql`)).toBe('core');
    expect(bucketForUrl('https://api.github.com/search/issues')).toBe('search');
  });
});

describe('RateLimitGuard through HttpClient', () => {
  it('waits for retry-after seconds on a 429', async () => {
    const t = setup([res(429, {}, { 'retry-after': '120' })]);
    const err = await t.client.getJson('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAt).toBe(t.now() + 120_000);
    expect((err as RateLimitedError).status).toBe(429);
  });

  it('waits until x-ratelimit-reset when remaining is 0 on a 403', async () => {
    const t = setup([res(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1000' })]);
    const err = await t.client.getJson('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAt).toBe(1_000_000);
  });

  it('prefers retry-after over the reset header', async () => {
    const t = setup([
      res(
        403,
        {},
        { 'retry-after': '10', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999' },
      ),
    ]);
    const err = (await t.client.getJson('/x').catch((e: unknown) => e)) as RateLimitedError;
    expect(err.retryAt).toBe(t.now() + 10_000);
  });

  it('uses 60 s, doubling per hit in a row up to 15 min, and a success resets it', async () => {
    const t = setup([
      res(403, { message: 'API rate limit exceeded' }),
      res(403, { message: 'API rate limit exceeded' }),
      res(403, { message: 'API rate limit exceeded' }),
      res(200, {}),
      res(403, { message: 'API rate limit exceeded' }),
    ]);
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      const before = t.now();
      const err = (await t.client.getJson('/x').catch((e: unknown) => e)) as RateLimitedError;
      waits.push(err.retryAt - before);
      t.advance(err.retryAt - before);
    }
    expect(waits).toEqual([60_000, 120_000, 240_000]);
    await t.client.getJson('/x');
    const before = t.now();
    const err = (await t.client.getJson('/x').catch((e: unknown) => e)) as RateLimitedError;
    expect(err.retryAt - before).toBe(60_000);
  });

  it('caps the wait at 15 minutes', () => {
    let now = 0;
    const guard = new RateLimitGuard(() => now);
    let last = 0;
    for (let i = 0; i < 8; i++) {
      const e = guard.trip('core', 'x');
      last = e.retryAt - now;
      now = e.retryAt;
    }
    expect(last).toBe(15 * 60_000);
  });

  it('does not treat a plain 403 as a rate limit', async () => {
    const t = setup([res(403, { message: 'forbidden' })]);
    const err = await t.client.getJson('/x').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RateLimitedError);
  });

  it('treats any 429 as a rate limit, even with no headers or rate limit text', async () => {
    const t = setup([res(429, { message: 'Too Many Requests' })]);
    const err = (await t.client.getJson('/x').catch((e: unknown) => e)) as RateLimitedError;
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAt).toBe(t.now() + 60_000);
  });

  it('sends nothing while blocked, only for the blocked bucket, and resumes later', async () => {
    const t = setup([
      res(429, {}, { 'retry-after': '30' }),
      res(200, { items: [] }),
      res(200, { ok: true }),
    ]);
    await t.client.getJson('/x').catch(() => undefined);
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
    await expect(t.client.getJson('/y')).rejects.toBeInstanceOf(RateLimitedError);
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
    await t.client.getJson('/search/issues');
    expect(t.fetchFn).toHaveBeenCalledTimes(2);
    t.advance(30_000);
    await t.client.getJson('/y');
    expect(t.fetchFn).toHaveBeenCalledTimes(3);
  });

  it('trips the graphql bucket on a RATE_LIMITED error in a 200', async () => {
    const t = setup([
      res(200, { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }),
      res(200, {}),
    ]);
    const url = 'https://ghe.example.com/api/graphql';
    await expect(t.client.graphql(url, 'query { a }')).rejects.toBeInstanceOf(RateLimitedError);
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
    await expect(t.client.graphql(url, 'query { a }')).rejects.toBeInstanceOf(RateLimitedError);
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
    await t.client.getJson('/x');
    expect(t.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('doubles GraphQL waits on repeated RATE_LIMITED, and a clean 200 resets them', async () => {
    const limited = () =>
      res(200, { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] });
    const t = setup([limited(), limited(), res(200, { data: { a: 1 } }), limited()]);
    const url = 'https://ghe.example.com/api/graphql';
    const waitAfterHit = async (): Promise<number> => {
      const before = t.now();
      const err = (await t.client
        .graphql(url, 'query { a }')
        .catch((e: unknown) => e)) as RateLimitedError;
      expect(err).toBeInstanceOf(RateLimitedError);
      t.advance(err.retryAt - before);
      return err.retryAt - before;
    };
    expect(await waitAfterHit()).toBe(60_000);
    expect(await waitAfterHit()).toBe(120_000);
    await t.client.graphql(url, 'query { a }');
    expect(await waitAfterHit()).toBe(60_000);
  });
});
