import { gunzipSync } from 'node:zlib';

export type QueryParams = Record<string, string | number | boolean | undefined>;

interface HttpClientOptions {
  baseUrl: string;
  getAuthHeader?: () => Promise<string | undefined>;
  fetchFn?: typeof fetch;
  userAgent?: string;
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? `HTTP ${status}: ${body}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
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

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.getAuthHeader = opts.getAuthHeader;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
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
    const headers = await this.buildHeaders(opts?.headers);

    const res = await this.fetchFn(url, {
      method,
      headers,
      body: opts?.body,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new HttpError(res.status, text);
    }

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
    const payload = await this.postJson<GraphQLPayload<T>>(url, { query, variables });
    if (payload.errors && payload.errors.length > 0) {
      const message =
        payload.errors.map((e) => e.message ?? 'Unknown GraphQL error').join('; ') ||
        'GraphQL error';
      throw new Error(message);
    }
    if (payload.data === undefined) {
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
