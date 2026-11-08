import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../../src/util/ttlCache';

describe('TtlCache', () => {
  it('reuses a value until the ttl has passed', async () => {
    let time = 0;
    const cache = new TtlCache(() => time);
    const load = vi.fn(async () => 'v');

    await cache.get('k', 1000, load);
    await cache.get('k', 1000, load);
    expect(load).toHaveBeenCalledTimes(1);

    time = 1000;
    await cache.get('k', 1000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not store a failed load', async () => {
    const cache = new TtlCache(() => 0);
    const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('x'));
    load.mockResolvedValueOnce('ok');

    await expect(cache.get('k', 1000, load)).rejects.toThrow('x');
    expect(await cache.get('k', 1000, load)).toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('stores undefined and clears on request', async () => {
    const cache = new TtlCache(() => 0);
    const load = vi.fn(async () => undefined);

    await cache.get('k', 1000, load);
    await cache.get('k', 1000, load);
    expect(load).toHaveBeenCalledTimes(1);

    cache.clear();
    await cache.get('k', 1000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
