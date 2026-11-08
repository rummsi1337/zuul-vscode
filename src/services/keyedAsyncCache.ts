interface Entry<T> {
  readonly key: string;
  readonly value: T;
  readonly at: number;
}

interface Running<T> {
  readonly key: string;
  readonly token: number;
  readonly promise: Promise<T>;
}

/**
 * Holds one keyed async value at a time, with a TTL counted from when the load finished.
 * A newer load or `invalidate()` makes a running load stale.
 */
export class KeyedAsyncCache<T> {
  private entry: Entry<T> | undefined;
  private running: Running<T> | undefined;
  private generation = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  peek(key: string): T | undefined {
    return this.entry?.key === key ? this.entry.value : undefined;
  }

  isFresh(key: string): boolean {
    return this.entry?.key === key && this.now() - this.entry.at < this.ttlMs;
  }

  get(key: string, load: (isCurrent: () => boolean) => Promise<T>): Promise<T> {
    if (this.entry?.key === key && this.isFresh(key)) {
      return Promise.resolve(this.entry.value);
    }
    if (this.running?.key === key) {
      return this.running.promise;
    }

    const token = ++this.generation;
    const isCurrent = (): boolean => this.generation === token;
    const promise = (async (): Promise<T> => {
      const value = await load(isCurrent);
      if (isCurrent()) {
        this.entry = { key, value, at: this.now() };
      }
      return value;
    })();
    this.running = { key, token, promise };
    const clear = (): void => {
      if (this.running?.token === token) {
        this.running = undefined;
      }
    };
    promise.then(clear, clear);
    return promise;
  }

  invalidate(): void {
    this.generation += 1;
    this.entry = undefined;
    this.running = undefined;
  }
}
