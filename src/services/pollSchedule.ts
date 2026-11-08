import { type ChangeStatus } from '../clients/zuulTypes';

export const TRIGGER_POLL_DELAY_MS = 15_000;
export const IDLE_POLL_MULTIPLIER = 5;

export interface PollSnapshotLike {
  readonly statuses: readonly ChangeStatus[];
}

export function nextPollDelayMs(
  snapshot: PollSnapshotLike | undefined,
  intervalMs: number,
  fastUntil?: number,
  now: number = Date.now(),
): number {
  if (fastUntil !== undefined && now < fastUntil) {
    return Math.min(TRIGGER_POLL_DELAY_MS, intervalMs);
  }
  if (snapshot && snapshot.statuses.some((s) => s.live)) {
    return intervalMs;
  }
  return intervalMs * IDLE_POLL_MULTIPLIER;
}
