import { describe, expect, it, vi } from 'vitest';
import { mapWithConcurrency } from '../../src/util/concurrency';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('mapWithConcurrency', () => {
  it('returns an empty list without calling the worker', async () => {
    const worker = vi.fn(async (item: number) => item);

    expect(await mapWithConcurrency([], 3, worker)).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it('keeps input order when workers finish out of order', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const finished: number[] = [];

    const run = mapWithConcurrency(['a', 'b', 'c'], 3, async (item, index) => {
      await gates[index].promise;
      finished.push(index);
      return item.toUpperCase();
    });

    gates[2].resolve();
    gates[0].resolve();
    gates[1].resolve();

    expect(await run).toEqual(['A', 'B', 'C']);
    expect(finished).toEqual([2, 0, 1]);
  });

  it('never runs more than limit workers at once', async () => {
    let active = 0;
    let maxActive = 0;

    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      await Promise.resolve();
      active -= 1;
      return item * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(maxActive).toBe(3);
  });

  it('still processes every item when limit is 0', async () => {
    const seen: number[] = [];

    const results = await mapWithConcurrency([1, 2, 3], 0, async (item) => {
      seen.push(item);
      return item + 1;
    });

    expect(results).toEqual([2, 3, 4]);
    expect(seen).toEqual([1, 2, 3]);
  });
});
