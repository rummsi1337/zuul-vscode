import { describe, expect, it } from 'vitest';
import { type ChangeStatus } from '../../src/clients/zuulTypes';
import {
  FAST_POLL_DELAY_MS,
  IDLE_POLL_DELAY_MS,
  nextPollDelayMs,
  QUEUED_POLL_DELAY_MS,
} from '../../src/services/pollSchedule';

const queuedStatus: ChangeStatus = {
  pipeline: 'check',
  queue: 'shared',
  live: true,
  jobs: [],
  itemsAhead: [],
};

describe('nextPollDelayMs', () => {
  it('returns 3000ms while now < fastUntil regardless of snapshot state', () => {
    expect(nextPollDelayMs(undefined, 10_000, 9_999)).toBe(FAST_POLL_DELAY_MS);
    expect(nextPollDelayMs({ statuses: [] }, 10_000, 5_000)).toBe(FAST_POLL_DELAY_MS);
    expect(nextPollDelayMs({ statuses: [queuedStatus] }, 10_000, 5_000)).toBe(FAST_POLL_DELAY_MS);
  });

  it('returns 15000ms when fastUntil has expired or is undefined and ChangeStatus exists', () => {
    expect(nextPollDelayMs({ statuses: [queuedStatus] }, undefined, 10_000)).toBe(
      QUEUED_POLL_DELAY_MS,
    );
    expect(nextPollDelayMs({ statuses: [queuedStatus] }, 10_000, 10_000)).toBe(
      QUEUED_POLL_DELAY_MS,
    );
    expect(nextPollDelayMs({ statuses: [queuedStatus] }, 10_000, 15_000)).toBe(
      QUEUED_POLL_DELAY_MS,
    );
  });

  it('returns 60000ms when no ChangeStatus exists and not in fast-watch mode', () => {
    expect(nextPollDelayMs(undefined, undefined, 10_000)).toBe(IDLE_POLL_DELAY_MS);
    expect(nextPollDelayMs({ statuses: [] }, undefined, 10_000)).toBe(IDLE_POLL_DELAY_MS);
    expect(nextPollDelayMs({ statuses: [] }, 10_000, 10_000)).toBe(IDLE_POLL_DELAY_MS);
  });
});
