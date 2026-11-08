import { gunzipSync } from 'node:zlib';
import { type Logger } from '../util/logger';

export type QueryParams = Record<string, string | number | boolean | undefined>;

export type HttpLogger = Pick<Logger, 'info' | 'warn'>;

export interface HttpClientOptions {
  baseUrl: string;
  getAuthHeader?: () => Promise<string | undefined>;
  fetchFn?: typeof fetch;
  userAgent?: string;
  logger?: HttpLogger;
}

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

interface GraphQLPayload<T> {
  data?: T;
  errors?: { message?: string }[];
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT = 'zuul-vscode';

export class HttpClient {
  private readonly baseUrl: string;
  private readonly getAuthHeader?: () => Promise<string | undefined>;
  private readonly fetchFn: typeof fetch;
  private readonly userAgent: string;
  private readonly logger?: HttpLogger;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.getAuthHeader = opts.getAuthHeader;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.logger = opts.logger;
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

  private async buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      ...extra,
    };

    if (this.getAuthHeader) {
      const auth = await this.getAuthHeader();
      if (auth) {
        headers.Authorization = auth;
      }
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
    },
  ): Promise<Response> {
    const url = this.resolveUrl(path, opts?.query);
    this.logger?.info(`[HTTP] ${method} ${url}`);
    const headers = await this.buildHeaders(opts?.headers);

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

    if (!res.ok) {
      const text = await res.text();
      const message = `[HTTP] ${method} ${url} -> ${res.status}: ${text}`;
      if (res.status === 404) {
        this.logger?.info(message);
      } else {
        this.logger?.warn(message);
      }
      throw new HttpError(res.status, text, undefined, url, method);
    }

    this.logger?.info(`[HTTP] ${method} ${url} -> ${res.status}`);
    return res;
  }

  async getJsonWithHeaders<T>(
    path: string,
    query?: QueryParams,
  ): Promise<{ data: T; headers: Headers }> {
    const res = await this.request('GET', path, {
      query,
      headers: { Accept: 'application/json' },
    });
    const data = (await res.json()) as T;
    return { data, headers: res.headers };
  }

  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const { data } = await this.getJsonWithHeaders<T>(path, query);
    return data;
  }

  async postJson<T = unknown>(path: string, body?: unknown): Promise<T> {
    const res = await this.request('POST', path, {
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
    const payload = await this.postJson<GraphQLPayload<T>>(url, { query, variables });
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

  async getBytes(absoluteUrl: string): Promise<Uint8Array> {
    const res = await this.request('GET', absoluteUrl);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      return new Uint8Array(gunzipSync(bytes));
    }
    return bytes;
  }

  async getText(absoluteUrl: string): Promise<string> {
    const bytes = await this.getBytes(absoluteUrl);
    return new TextDecoder('utf-8').decode(bytes);
  }
}
