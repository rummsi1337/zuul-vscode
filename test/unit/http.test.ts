import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { HttpClient, HttpError } from '../../src/clients/http';

function jsonResponse(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('HttpClient', () => {
  it('resolves relative paths, strips trailing base slash, and uses http(s) URLs as-is', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = new HttpClient({
      baseUrl: 'https://zuul.example.com/api///',
      fetchFn,
    });

    await client.getJson('/tenants');
    expect(fetchFn).toHaveBeenLastCalledWith(
      'https://zuul.example.com/api/tenants',
      expect.objectContaining({
        method: 'GET',
        headers: {
          'User-Agent': 'zuul-vscode',
          Accept: 'application/json',
        },
      }),
    );

    await client.getJson('status', { change: 42, live: true, ignored: undefined });
    expect(fetchFn).toHaveBeenLastCalledWith(
      'https://zuul.example.com/api/status?change=42&live=true',
      expect.anything(),
    );

    await client.getJson('https://other.example.com/v1/items?existing=1', { page: 2 });
    expect(fetchFn).toHaveBeenLastCalledWith(
      'https://other.example.com/v1/items?existing=1&page=2',
      expect.anything(),
    );
  });

  it('includes Authorization header when getAuthHeader returns a value and supports custom userAgent', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ user: 'alice' }));
    let token: string | undefined = 'Bearer secret-token';
    const client = new HttpClient({
      baseUrl: 'https://ghe.example.com/api/v3',
      getAuthHeader: async () => token,
      fetchFn,
      userAgent: 'custom-agent/1.0',
    });

    await client.getJson('/user');
    expect(fetchFn).toHaveBeenLastCalledWith(
      'https://ghe.example.com/api/v3/user',
      expect.objectContaining({
        headers: {
          'User-Agent': 'custom-agent/1.0',
          Accept: 'application/json',
          Authorization: 'Bearer secret-token',
        },
        signal: expect.any(AbortSignal),
      }),
    );

    token = undefined;
    await client.getJson('/user');
    const lastInit = fetchFn.mock.calls.at(-1)?.[1] as { headers: Record<string, string> };
    expect(lastInit.headers.Authorization).toBeUndefined();
  });

  it('sends no token to another origin and drops a per-call Authorization there', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const getAuthHeader = vi.fn(async () => 'Bearer secret');
    const client = new HttpClient({
      baseUrl: 'https://ghe.example.com/api/v3',
      getAuthHeader,
      fetchFn,
    });

    await client.getJson('https://evil.example.org/next?page=2');
    let init = fetchFn.mock.calls.at(-1)?.[1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBeUndefined();
    expect(getAuthHeader).not.toHaveBeenCalled();

    await client.getJson('https://evil.example.org/x', undefined, { authorization: 'Bearer zuul' });
    init = fetchFn.mock.calls.at(-1)?.[1] as { headers: Record<string, string> };
    expect(Object.keys(init.headers).map((k) => k.toLowerCase())).not.toContain('authorization');

    // Same origin keeps its token, including the GHE GraphQL URL.
    await client.getJson('https://ghe.example.com/api/graphql');
    init = fetchFn.mock.calls.at(-1)?.[1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer secret');
  });

  it('keeps the token for the github.com GraphQL URL', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ data: { ok: 1 } }));
    const client = new HttpClient({
      baseUrl: 'https://api.github.com',
      getAuthHeader: async () => 'Bearer secret',
      fetchFn,
    });

    await client.graphql('https://api.github.com/graphql', 'query { a }');
    const init = fetchFn.mock.calls.at(-1)?.[1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer secret');
  });

  it('sends JSON bodies for postJson and patchJson and handles empty responses', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 1 }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ updated: true }, 200))
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    const client = new HttpClient({
      baseUrl: 'https://ghe.example.com/api/v3',
      fetchFn,
    });

    const created = await client.postJson<{ id: number }>('/comments', { body: 'recheck' });
    expect(created).toEqual({ id: 1 });
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      'https://ghe.example.com/api/v3/comments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ body: 'recheck' }),
      }),
    );

    const emptyPost = await client.postJson('/noop');
    expect(emptyPost).toBeUndefined();

    const patched = await client.patchJson<{ updated: boolean }>('/pulls/1', { body: 'new' });
    expect(patched).toEqual({ updated: true });
    expect(fetchFn).toHaveBeenNthCalledWith(
      3,
      'https://ghe.example.com/api/v3/pulls/1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ body: 'new' }),
      }),
    );

    const emptyPatch = await client.patchJson('/pulls/1');
    expect(emptyPatch).toBeUndefined();
  });

  it('throws HttpError with status and body on non-2xx responses', async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response('{"message":"Not Found"}', { status: 404 }),
    );
    const client = new HttpClient({
      baseUrl: 'https://ghe.example.com/api/v3',
      fetchFn,
    });

    await expect(client.getJson('/repos/acme/missing')).rejects.toThrowError(HttpError);
    try {
      await client.getJson('/repos/acme/missing');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.status).toBe(404);
      expect(httpErr.body).toBe('{"message":"Not Found"}');
      expect(httpErr.name).toBe('HttpError');
    }
  });

  it('executes GraphQL queries and throws on GraphQL errors or missing data', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { viewer: { login: 'alice' } } }))
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: 'Field does not exist' }, {}] }))
      .mockResolvedValueOnce(jsonResponse({}));

    const client = new HttpClient({
      baseUrl: 'https://ghe.example.com/api/v3',
      fetchFn,
    });

    const data = await client.graphql<{ viewer: { login: string } }>(
      'https://ghe.example.com/api/graphql',
      'query { viewer { login } }',
      { id: 1 },
    );
    expect(data).toEqual({ viewer: { login: 'alice' } });

    await expect(
      client.graphql('https://ghe.example.com/api/graphql', 'query { bad }'),
    ).rejects.toThrow('Field does not exist; Unknown GraphQL error');

    await expect(
      client.graphql('https://ghe.example.com/api/graphql', 'query { empty }'),
    ).rejects.toThrow('GraphQL response missing data');
  });

  it('fetches plain and gzip-compressed bytes and text via getBytes and getText', async () => {
    const plainText = '2026-11-07 18:00:00 INFO Job started\n';
    const gzippedBytes = gzipSync(Buffer.from(plainText, 'utf-8'));
    expect(gzippedBytes[0]).toBe(0x1f);
    expect(gzippedBytes[1]).toBe(0x8b);

    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(plainText, { status: 200 }))
      .mockResolvedValueOnce(new Response(gzippedBytes, { status: 200 }))
      .mockResolvedValueOnce(new Response(gzippedBytes, { status: 200 }));

    const client = new HttpClient({
      baseUrl: 'https://zuul.example.com',
      fetchFn,
    });

    expect(await client.getText('https://logs.example.com/42/job-output.txt')).toBe(plainText);
    expect(await client.getText('https://logs.example.com/42/job-output.txt.gz')).toBe(plainText);

    const rawUnzipped = await client.getBytes('https://logs.example.com/42/job-output.txt.gz');
    expect(new TextDecoder().decode(rawUnzipped)).toBe(plainText);
  });

  it('logs outgoing requests and responses when logger is provided', async () => {
    const infos: string[] = [];
    const warns: string[] = [];
    const fakeLogger = {
      info: (msg: string) => infos.push(msg),
      warn: (msg: string) => warns.push(msg),
      error: vi.fn(),
    };

    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"message":"Not found"}', { status: 404 }))
      .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    const client = new HttpClient({
      baseUrl: 'https://zuul.example.com',
      fetchFn,
      logger: fakeLogger,
    });

    await client.getJson('/api/tenants');
    expect(infos).toContain('[HTTP] GET https://zuul.example.com/api/tenants');
    expect(infos).toContain('[HTTP] GET https://zuul.example.com/api/tenants -> 200');

    let httpErr: HttpError | undefined;
    try {
      await client.getJson('/api/tenant/acme/builds', { project: 'org/repo', change: 123 });
      expect.fail('Expected HttpError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      httpErr = err as HttpError;
    }
    expect(httpErr.url).toBe(
      'https://zuul.example.com/api/tenant/acme/builds?project=org%2Frepo&change=123',
    );
    expect(httpErr.method).toBe('GET');
    expect(httpErr.message).toContain(
      'HTTP 404 (GET https://zuul.example.com/api/tenant/acme/builds?project=org%2Frepo&change=123): {"message":"Not found"}',
    );
    expect(infos).toContain(
      '[HTTP] GET https://zuul.example.com/api/tenant/acme/builds?project=org%2Frepo&change=123 -> 404: {"message":"Not found"}',
    );
    expect(warns).not.toContain(
      '[HTTP] GET https://zuul.example.com/api/tenant/acme/builds?project=org%2Frepo&change=123 -> 404: {"message":"Not found"}',
    );

    await expect(client.getJson('/api/broken')).rejects.toThrow(HttpError);
    expect(warns).toContain(
      '[HTTP] GET https://zuul.example.com/api/broken -> 500: Internal Server Error',
    );
  });

  describe('conditionalGet', () => {
    const base = 'https://ghe.example.com/api/v3';
    const sentHeaders = (fetchFn: ReturnType<typeof vi.fn<typeof fetch>>, i: number) =>
      (fetchFn.mock.calls[i]?.[1] as { headers: Record<string, string> }).headers;

    it('sends If-None-Match on the second GET and returns the first body on 304', async () => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ a: 1 }, 200, { ETag: '"v1"', Link: 'x' }))
        .mockResolvedValueOnce(new Response(null, { status: 304 }));
      const client = new HttpClient({ baseUrl: base, fetchFn, conditionalGet: true });

      await client.getJsonWithHeaders('/x');
      const second = await client.getJsonWithHeaders<{ a: number }>('/x');

      expect(sentHeaders(fetchFn, 0)['If-None-Match']).toBeUndefined();
      expect(sentHeaders(fetchFn, 1)['If-None-Match']).toBe('"v1"');
      expect(second.data).toEqual({ a: 1 });
      expect(second.headers.get('link')).toBe('x');
    });

    it('uses If-Modified-Since when only last-modified is present', async () => {
      const lm = 'Wed, 21 Oct 2015 07:28:00 GMT';
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ a: 1 }, 200, { 'Last-Modified': lm }))
        .mockResolvedValueOnce(new Response(null, { status: 304 }));
      const client = new HttpClient({ baseUrl: base, fetchFn, conditionalGet: true });
      await client.getJson('/x');
      await client.getJson('/x');
      expect(sentHeaders(fetchFn, 1)['If-Modified-Since']).toBe(lm);
      expect(sentHeaders(fetchFn, 1)['If-None-Match']).toBeUndefined();
    });

    it('revalidates each page of a two-page list on its own', async () => {
      const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
        const h = (init as { headers: Record<string, string> }).headers;
        const etag = String(url).includes('page=2') ? '"p2"' : '"p1"';
        if (h['If-None-Match'] === etag) return new Response(null, { status: 304 });
        return jsonResponse([1], 200, { ETag: etag });
      });
      const client = new HttpClient({ baseUrl: base, fetchFn, conditionalGet: true });
      await client.getJson('/list');
      await client.getJson('/list', { page: 2 });
      await client.getJson('/list');
      await client.getJson('/list', { page: 2 });

      expect(fetchFn).toHaveBeenCalledTimes(4);
      expect(sentHeaders(fetchFn, 2)['If-None-Match']).toBe('"p1"');
      expect(sentHeaders(fetchFn, 3)['If-None-Match']).toBe('"p2"');
    });

    it('drops stored entries when the Authorization value changes', async () => {
      let token = 'Bearer a';
      const fetchFn = vi.fn<typeof fetch>(async () =>
        jsonResponse({ a: 1 }, 200, { ETag: '"v1"' }),
      );
      const client = new HttpClient({
        baseUrl: base,
        fetchFn,
        conditionalGet: true,
        getAuthHeader: async () => token,
      });
      await client.getJson('/x');
      token = 'Bearer b';
      await client.getJson('/x');
      expect(sentHeaders(fetchFn, 1)['If-None-Match']).toBeUndefined();
      await client.getJson('/x');
      expect(sentHeaders(fetchFn, 2)['If-None-Match']).toBe('"v1"');
    });

    it('keeps at most 200 entries, dropping the oldest', async () => {
      const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({}, 200, { ETag: '"e"' }));
      const client = new HttpClient({ baseUrl: base, fetchFn, conditionalGet: true });
      for (let i = 0; i < 201; i++) await client.getJson(`/p${i}`);
      fetchFn.mockClear();
      await client.getJson('/p0');
      await client.getJson('/p200');
      expect(sentHeaders(fetchFn, 0)['If-None-Match']).toBeUndefined();
      expect(sentHeaders(fetchFn, 1)['If-None-Match']).toBe('"e"');
    });

    it('does nothing unless enabled, and never for POST', async () => {
      const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({}, 200, { ETag: '"e"' }));
      const off = new HttpClient({ baseUrl: base, fetchFn });
      await off.getJson('/x');
      await off.getJson('/x');
      expect(sentHeaders(fetchFn, 1)['If-None-Match']).toBeUndefined();

      const on = new HttpClient({ baseUrl: base, fetchFn, conditionalGet: true });
      await on.postJson('/x', {});
      await on.postJson('/x', {});
      expect(sentHeaders(fetchFn, 3)['If-None-Match']).toBeUndefined();
    });
  });
});
