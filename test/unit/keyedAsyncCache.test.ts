import { describe, expect, it, vi } from 'vitest';
import { KeyedAsyncCache } from '../../src/services/keyedAsyncCache';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('KeyedAsyncCache', () => {
  it('serves a fresh value and reloads after the TTL', async () => {
    let t = 0;
    const cache = new KeyedAsyncCache<number>(100, () => t);
    const load = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    expect(await cache.get('a', load)).toBe(1);
    expect(cache.isFresh('a')).toBe(true);
    t = 99;
    expect(await cache.get('a', load)).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);

    t = 100;
    expect(cache.isFresh('a')).toBe(false);
    expect(cache.peek('a')).toBe(1);
    expect(await cache.get('a', load)).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('counts age from when the load finished', async () => {
    let t = 0;
    const cache = new KeyedAsyncCache<number>(100, () => t);
    const d = deferred<number>();
    const p = cache.get('a', () => d.promise);
    t = 80;
    d.resolve(5);
    await p;
    t = 170;
    expect(cache.isFresh('a')).toBe(true);
  });

  it('calls load synchronously and joins a running load for the same key', async () => {
    const cache = new KeyedAsyncCache<number>(100);
    const d = deferred<number>();
    const load = vi.fn(() => d.promise);

    const p1 = cache.get('a', load);
    expect(load).toHaveBeenCalledTimes(1);
    const p2 = cache.get('a', load);
    expect(load).toHaveBeenCalledTimes(1);
    d.resolve(7);
    expect(await p1).toBe(7);
    expect(await p2).toBe(7);
  });

  it('makes the old load stale when a newer key starts', async () => {
    const cache = new KeyedAsyncCache<string>(1000);
    const dA = deferred<string>();
    const dB = deferred<string>();
    let currentA: (() => boolean) | undefined;

    const pA = cache.get('a', (isCurrent) => {
      currentA = isCurrent;
      return dA.promise;
    });
    const pB = cache.get('b', () => dB.promise);

    expect(currentA?.()).toBe(false);
    dA.resolve('A');
    await pA;
    expect(cache.peek('a')).toBeUndefined();

    // The stale load finishing must not clear the newer load's entry.
    const joined = cache.get('b', () => Promise.reject(new Error('should join')));
    dB.resolve('B');
    expect(await pB).toBe('B');
    expect(await joined).toBe('B');
    expect(cache.peek('b')).toBe('B');
  });

  it('drops a running load on invalidate()', async () => {
    const cache = new KeyedAsyncCache<number>(1000);
    const d = deferred<number>();
    let isCurrent: (() => boolean) | undefined;
    const p = cache.get('a', (cur) => {
      isCurrent = cur;
      return d.promise;
    });
    cache.invalidate();
    expect(isCurrent?.()).toBe(false);
    d.resolve(1);
    await p;
    expect(cache.peek('a')).toBeUndefined();
    expect(cache.isFresh('a')).toBe(false);

    const load = vi.fn().mockResolvedValue(2);
    expect(await cache.get('a', load)).toBe(2);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('invalidate() drops a stored value', async () => {
    const cache = new KeyedAsyncCache<number>(1000);
    await cache.get('a', () => Promise.resolve(1));
    cache.invalidate();
    expect(cache.peek('a')).toBeUndefined();
  });

  it('stores nothing for a rejected load and retries next time', async () => {
    const cache = new KeyedAsyncCache<number>(1000);
    await expect(cache.get('a', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(cache.peek('a')).toBeUndefined();
    expect(cache.isFresh('a')).toBe(false);

    const load = vi.fn().mockResolvedValue(3);
    expect(await cache.get('a', load)).toBe(3);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps an expired value available through peek', async () => {
    let t = 0;
    const cache = new KeyedAsyncCache<number>(10, () => t);
    await cache.get('a', () => Promise.resolve(9));
    t = 1000;
    expect(cache.peek('a')).toBe(9);
    expect(cache.peek('other')).toBeUndefined();
  });
});
