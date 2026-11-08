import { gunzipSync } from 'node:zlib';
import { type Logger } from '../util/logger';
import { type RateLimitBucket, type RateLimitGuard } from './rateLimit';

export type QueryParams = Record<string, string | number | boolean | undefined>;

export type HttpLogger = Pick<Logger, 'info' | 'warn'>;

export interface HttpClientOptions {
  baseUrl: string;
  getAuthHeader?: () => Promise<string | undefined>;
  fetchFn?: typeof fetch;
  userAgent?: string;
  logger?: HttpLogger;
  /** Send If-None-Match / If-Modified-Since on GETs made via getJsonWithHeaders. */
  conditionalGet?: boolean;
  /** Refuses requests while a GitHub rate limit is in force, and learns limits from responses. */
  rateLimit?: RateLimitGuard;
  /** Throw HttpError(401) instead of sending a same-origin request without an Authorization header. */
  requireAuth?: boolean;
}

interface ConditionalEntry {
  etag?: string;
  lastModified?: string;
  data: unknown;
  headers: Headers;
}

const MAX_CONDITIONAL_ENTRIES = 200;

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly url?: string;
  readonly method?: string;

  constructor(status: number, body: string, message?: string, url?: string, method?: string) {
    const defaultMessage = url
      ? `HTTP ${status} (${method ? `${method} ` : ''}${url}): ${body}`
      : `HTTP ${status}: ${body}`;
    super(message ?? defaultMessage);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
    this.method = method;
  }
}

/** No token could be read, so nothing was sent. Can be brief (a slow `gh`), unlike a refused token. */
export class NoTokenError extends HttpError {
  constructor() {
    super(401, 'No GitHub token available');
    this.name = 'NoTokenError';
  }
}

interface GraphQLPayload<T> {
  data?: T;
  errors?: { message?: string; type?: string }[];
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT = 'zuul-vscode';

export class HttpClient {
  private readonly baseUrl: string;
  private readonly getAuthHeader?: () => Promise<string | undefined>;
  private readonly fetchFn: typeof fetch;
  private readonly userAgent: string;
  private readonly logger?: HttpLogger;
  private readonly conditionalGet: boolean;
  private readonly rateLimit?: RateLimitGuard;
  private readonly requireAuth: boolean;
  private readonly conditionalEntries = new Map<string, ConditionalEntry>();
  private lastGetAuth: string | undefined;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.getAuthHeader = opts.getAuthHeader;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.logger = opts.logger;
    this.conditionalGet = opts.conditionalGet ?? false;
    this.rateLimit = opts.rateLimit;
    this.requireAuth = opts.requireAuth ?? false;
  }

  resolveUrl(path: string, query?: QueryParams): string {
    let url: string;
    if (/^https?:\/\//i.test(path)) {
      url = path;
    } else {
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      url = `${this.baseUrl}${normalizedPath}`;
    }

    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          params.set(key, String(value));
        }
      }
      const qs = params.toString();
      if (qs.length > 0) {
        url += (url.includes('?') ? '&' : '?') + qs;
      }
    }

    return url;
  }

  private isSameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.baseUrl).origin;
    } catch {
      return false;
    }
  }

  private async buildHeaders(
    url: string,
    extra?: Record<string, string>,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      ...extra,
    };

    if (!this.isSameOrigin(url)) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'authorization') {
          delete headers[key];
        }
      }
      return headers;
    }

    if (this.getAuthHeader) {
      const auth = await this.getAuthHeader();
      if (auth) {
        headers.Authorization = auth;
      }
    }

    if (this.requireAuth && !headers.Authorization) {
      throw new NoTokenError();
    }

    return headers;
  }

  private async request(
    method: string,
    path: string,
    opts?: {
      query?: QueryParams;
      body?: string;
      headers?: Record<string, string>;
      allowNotModified?: boolean;
      /** Leave the rate-limit success record to the caller (GraphQL errors arrive in a 200). */
      deferSuccess?: boolean;
      onRequestHeaders?: (headers: Record<string, string>) => void;
    },
  ): Promise<Response> {
    const url = this.resolveUrl(path, opts?.query);
    const bucket = this.rateLimit?.bucketFor(url);
    if (bucket) {
      this.rateLimit?.check(bucket, url, method);
    }
    this.logger?.info(`[HTTP] ${method} ${url}`);
    const headers = await this.buildHeaders(url, opts?.headers);
    opts?.onRequestHeaders?.(headers);

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers,
        body: opts?.body,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger?.warn(`[HTTP] ${method} ${url} failed with error: ${String(err)}`);
      throw err;
    }

    if (res.status === 304 && opts?.allowNotModified) {
      if (bucket) {
        this.rateLimit?.recordSuccess(bucket);
      }
      this.logger?.info(`[HTTP] ${method} ${url} -> 304`);
      return res;
    }

    if (!res.ok) {
      const text = await res.text();
      const message = `[HTTP] ${method} ${url} -> ${res.status}: ${text}`;
      if (res.status === 404) {
        this.logger?.info(message);
      } else {
        this.logger?.warn(message);
      }
      const limited = (bucket ? this.rateLimit : undefined)?.recordFailure(
        bucket as RateLimitBucket,
        res.status,
        res.headers,
        text,
        url,
        method,
      );
      if (limited) {
        throw limited;
      }
      throw new HttpError(res.status, text, undefined, url, method);
    }

    if (bucket && !opts?.deferSuccess) {
      this.rateLimit?.recordSuccess(bucket);
    }
    this.logger?.info(`[HTTP] ${method} ${url} -> ${res.status}`);
    return res;
  }

  async getJsonWithHeaders<T>(
    path: string,
    query?: QueryParams,
    headers?: Record<string, string>,
  ): Promise<{ data: T; headers: Headers }> {
    if (!this.conditionalGet) {
      return this.getJsonUnconditional<T>(path, query, headers);
    }

    const url = this.resolveUrl(path, query);
    const stored = this.conditionalEntries.get(url);
    const extra: Record<string, string> = { Accept: 'application/json', ...headers };
    if (stored?.etag) {
      extra['If-None-Match'] = stored.etag;
    } else if (stored?.lastModified) {
      extra['If-Modified-Since'] = stored.lastModified;
    }

    let sentAuth: string | undefined;
    const res = await this.request('GET', path, {
      query,
      headers: extra,
      allowNotModified: stored !== undefined,
      onRequestHeaders: (sent) => {
        sentAuth = sent.Authorization;
        if (sentAuth !== this.lastGetAuth) {
          this.conditionalEntries.clear();
          this.lastGetAuth = sentAuth;
          delete sent['If-None-Match'];
          delete sent['If-Modified-Since'];
        }
      },
    });

    if (res.status === 304 && stored && this.conditionalEntries.get(url) === stored) {
      this.conditionalEntries.delete(url);
      this.conditionalEntries.set(url, stored);
      return { data: stored.data as T, headers: stored.headers };
    }
    if (res.status === 304) {
      // Entry was dropped (token change) while the request was in flight; retry unconditionally.
      return this.getJsonUnconditional<T>(path, query, headers);
    }

    const data = (await res.json()) as T;
    const etag = res.headers.get('etag') ?? undefined;
    const lastModified = res.headers.get('last-modified') ?? undefined;
    // A token change while this request was in flight makes the answer unsafe to reuse.
    if (res.status === 200 && (etag || lastModified) && sentAuth === this.lastGetAuth) {
      this.conditionalEntries.delete(url);
      this.conditionalEntries.set(url, { etag, lastModified, data, headers: res.headers });
      while (this.conditionalEntries.size > MAX_CONDITIONAL_ENTRIES) {
        const oldest = this.conditionalEntries.keys().next().value;
        if (oldest === undefined) break;
        this.conditionalEntries.delete(oldest);
      }
    }
    return { data, headers: res.headers };
  }

  private async getJsonUnconditional<T>(
    path: string,
    query?: QueryParams,
    headers?: Record<string, string>,
  ): Promise<{ data: T; headers: Headers }> {
    const res = await this.request('GET', path, {
      query,
      headers: { Accept: 'application/json', ...headers },
    });
    return { data: (await res.json()) as T, headers: res.headers };
  }

  async getJson<T>(
    path: string,
    query?: QueryParams,
    headers?: Record<string, string>,
  ): Promise<T> {
    const { data } = await this.getJsonWithHeaders<T>(path, query, headers);
    return data;
  }

  async postJson<T = unknown>(
    path: string,
    body?: unknown,
    opts?: { deferSuccess?: boolean },
  ): Promise<T> {
    const res = await this.request('POST', path, {
      deferSuccess: opts?.deferSuccess,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    const text = await res.text();
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  async patchJson<T = unknown>(path: string, body?: unknown): Promise<T> {
    const res = await this.request('PATCH', path, {
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    const text = await res.text();
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  async graphql<T>(url: string, query: string, variables?: Record<string, unknown>): Promise<T> {
    this.logger?.info(`[GraphQL] POST ${url} (variables=${JSON.stringify(variables ?? {})})`);
    const payload = await this.postJson<GraphQLPayload<T>>(
      url,
      { query, variables },
      { deferSuccess: true },
    );
    if (payload.errors?.some((e) => e.type === 'RATE_LIMITED') && this.rateLimit) {
      const message = payload.errors.map((e) => e.message ?? 'RATE_LIMITED').join('; ');
      this.logger?.warn(`[GraphQL] POST ${url} rate limited: ${message}`);
      throw this.rateLimit.trip(this.rateLimit.bucketFor(url), message, url, 'POST');
    }
    this.rateLimit?.recordSuccess(this.rateLimit.bucketFor(url));
    if (payload.errors && payload.errors.length > 0) {
      const message =
        payload.errors.map((e) => e.message ?? 'Unknown GraphQL error').join('; ') ||
        'GraphQL error';
      this.logger?.warn(`[GraphQL] POST ${url} errors: ${message}`);
      throw new Error(message);
    }
    if (payload.data === undefined) {
      this.logger?.warn(`[GraphQL] POST ${url} response missing data`);
      throw new Error('GraphQL response missing data');
    }
    return payload.data;
  }

  async getBytes(
    absoluteUrl: string,
    options: { query?: QueryParams; headers?: Record<string, string> } = {},
  ): Promise<Uint8Array> {
    const res = await this.request('GET', absoluteUrl, options);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      return new Uint8Array(gunzipSync(bytes));
    }
    return bytes;
  }

  async getText(
    absoluteUrl: string,
    query?: QueryParams,
    headers?: Record<string, string>,
  ): Promise<string> {
    const bytes = await this.getBytes(absoluteUrl, { query, headers });
    return new TextDecoder('utf-8').decode(bytes);
  }
}
