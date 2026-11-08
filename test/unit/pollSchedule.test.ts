import { describe, expect, it } from 'vitest';
import { type ChangeStatus } from '../../src/clients/zuulTypes';
import { nextPollDelayMs } from '../../src/services/pollSchedule';

const liveStatus: ChangeStatus = {
  pipeline: 'check',
  queue: 'shared',
  live: true,
  jobs: [],
  itemsAhead: [],
};
const notLiveStatus: ChangeStatus = { ...liveStatus, live: false };

describe('nextPollDelayMs', () => {
  it('uses the interval when a status is live', () => {
    expect(nextPollDelayMs({ statuses: [liveStatus] }, 60_000, undefined, 10_000)).toBe(60_000);
    expect(nextPollDelayMs({ statuses: [liveStatus] }, 20_000, 10_000, 10_000)).toBe(20_000);
  });

  it('uses 5 times the interval when nothing is running', () => {
    expect(nextPollDelayMs(undefined, 60_000, undefined, 10_000)).toBe(300_000);
    expect(nextPollDelayMs({ statuses: [] }, 60_000, undefined, 10_000)).toBe(300_000);
    expect(nextPollDelayMs({ statuses: [notLiveStatus] }, 10_000, 5_000, 10_000)).toBe(50_000);
  });

  it('uses 15s after a trigger while now < fastUntil', () => {
    expect(nextPollDelayMs(undefined, 60_000, 10_000, 9_999)).toBe(15_000);
    expect(nextPollDelayMs({ statuses: [liveStatus] }, 60_000, 10_000, 5_000)).toBe(15_000);
  });

  it('never slows polling down after a trigger when the interval is under 15s', () => {
    expect(nextPollDelayMs(undefined, 10_000, 10_000, 5_000)).toBe(10_000);
  });
});
