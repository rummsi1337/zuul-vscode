import { HttpError } from './http';

export type RateLimitBucket = 'core' | 'search' | 'graphql';

const BASE_WAIT_MS = 60_000;
const MAX_WAIT_MS = 15 * 60_000;

/** A request was refused, or not sent, because GitHub's rate limit is in force until `retryAt`. */
export class RateLimitedError extends HttpError {
  readonly retryAt: number;

  constructor(
    status: number,
    body: string,
    retryAt: number,
    url?: string,
    method?: string,
    message?: string,
  ) {
    super(status, body, message, url, method);
    this.name = 'RateLimitedError';
    this.retryAt = retryAt;
  }
}

export function bucketForUrl(url: string): RateLimitBucket {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return 'core';
  }
  // Anchored to the API root: a repo or branch can be called "search" or "graphql".
  if (/^(?:\/api)?\/graphql\/?$/.test(pathname)) {
    return 'graphql';
  }
  if (/^(?:\/api\/v3)?\/search(?:\/|$)/.test(pathname)) {
    return 'search';
  }
  return 'core';
}

/** Remembers until when each rate-limit bucket is blocked. Never touches the network. */
export class RateLimitGuard {
  private readonly blockedUntil = new Map<RateLimitBucket, number>();
  private readonly hits = new Map<RateLimitBucket, number>();

  constructor(private readonly now: () => number = Date.now) {}

  bucketFor(url: string): RateLimitBucket {
    return bucketForUrl(url);
  }

  /** Throws without any request being sent when the bucket is blocked. */
  check(bucket: RateLimitBucket, url?: string, method?: string): void {
    const until = this.blockedUntil.get(bucket);
    if (until === undefined) {
      return;
    }
    if (this.now() >= until) {
      this.blockedUntil.delete(bucket);
      return;
    }
    throw new RateLimitedError(
      429,
      'GitHub rate limit in force',
      until,
      url,
      method,
      `GitHub rate limit in force until ${new Date(until).toISOString()}`,
    );
  }

  /** A successful response ends the doubling of waits. */
  recordSuccess(bucket: RateLimitBucket): void {
    this.hits.delete(bucket);
  }

  /**
   * Looks at a failed response. Returns a `RateLimitedError` (and blocks the bucket) when it is a
   * rate limit, otherwise `undefined`.
   */
  recordFailure(
    bucket: RateLimitBucket,
    status: number,
    headers: Headers,
    body: string,
    url?: string,
    method?: string,
  ): RateLimitedError | undefined {
    if (status !== 403 && status !== 429) {
      return undefined;
    }
    const retryAfter = headers.get('retry-after');
    const remaining = headers.get('x-ratelimit-remaining');
    const isLimit = retryAfter !== null || remaining === '0' || /rate limit/i.test(body);
    if (!isLimit) {
      return undefined;
    }
    const retryAt = this.block(bucket, retryAfter, remaining, headers.get('x-ratelimit-reset'));
    return new RateLimitedError(status, body, retryAt, url, method);
  }

  /** Blocks a bucket without response headers, e.g. for a GraphQL `RATE_LIMITED` error. */
  trip(bucket: RateLimitBucket, body: string, url?: string, method?: string): RateLimitedError {
    const retryAt = this.block(bucket, null, null, null);
    return new RateLimitedError(200, body, retryAt, url, method);
  }

  private block(
    bucket: RateLimitBucket,
    retryAfter: string | null,
    remaining: string | null,
    reset: string | null,
  ): number {
    const now = this.now();
    const hitCount = (this.hits.get(bucket) ?? 0) + 1;
    this.hits.set(bucket, hitCount);

    let waitMs: number | undefined;
    const retryAfterSeconds = retryAfter === null ? NaN : Number(retryAfter);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      waitMs = retryAfterSeconds * 1000;
    } else if (remaining === '0' && reset !== null && Number.isFinite(Number(reset))) {
      waitMs = Math.max(0, Number(reset) * 1000 - now);
    }
    waitMs ??= Math.min(BASE_WAIT_MS * 2 ** (hitCount - 1), MAX_WAIT_MS);

    const retryAt = now + waitMs;
    this.blockedUntil.set(bucket, retryAt);
    return retryAt;
  }
}
