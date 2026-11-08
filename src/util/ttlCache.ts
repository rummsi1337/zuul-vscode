/** Keeps loaded values for a time. A failed load is not stored, and `undefined` is a valid value. */
export class TtlCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing !== undefined && this.now() < existing.expiresAt) {
      return existing.value as T;
    }
    const value = await load();
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
