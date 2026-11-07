import { type ChangeStatus } from '../clients/zuulTypes';

export const FAST_POLL_DELAY_MS = 3_000;
export const QUEUED_POLL_DELAY_MS = 15_000;
export const IDLE_POLL_DELAY_MS = 60_000;

export interface PollSnapshotLike {
  readonly statuses: readonly ChangeStatus[];
}

export function nextPollDelayMs(
  snapshot: PollSnapshotLike | undefined,
  fastUntil?: number,
  now: number = Date.now(),
): number {
  if (fastUntil !== undefined && now < fastUntil) {
    return FAST_POLL_DELAY_MS;
  }
  if (snapshot && snapshot.statuses.length > 0) {
    return QUEUED_POLL_DELAY_MS;
  }
  return IDLE_POLL_DELAY_MS;
}
