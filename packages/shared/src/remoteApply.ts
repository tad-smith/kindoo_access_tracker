// Timings and predicates for remote apply. Shared so the phone and the
// desktop extension agree on when a desktop counts as online — a split
// definition would show the manager a button that can never be claimed.
// Doc shapes live in `types/remoteApply.ts`.

import type { RemoteApplyJobStatus, RemoteApplyPresence } from './types/remoteApply.js';

/** Heartbeat period. The extension republishes presence this often. */
export const REMOTE_APPLY_HEARTBEAT_MS = 60_000;

/**
 * How long a heartbeat stays trustworthy. Deliberately >2 heartbeats so a
 * single missed tick (suspended service worker, throttled background tab)
 * doesn't flap the phone's button.
 */
export const REMOTE_APPLY_STALE_MS = 150_000;

/** Poll period for the extension's job query while its Kindoo tab is visible. */
export const REMOTE_APPLY_POLL_VISIBLE_MS = 10_000;

/** Poll period while the Kindoo tab is hidden. */
export const REMOTE_APPLY_POLL_HIDDEN_MS = 60_000;

/**
 * How long the phone waits for a claim before giving up on a queued job.
 * Longer than one hidden-tab poll so a backgrounded desktop still wins.
 */
export const REMOTE_APPLY_PICKUP_TIMEOUT_MS = 90_000;

/** Statuses the extension will no longer touch. */
export const REMOTE_APPLY_TERMINAL_STATUSES: readonly RemoteApplyJobStatus[] = [
  'applied',
  'partial',
  'failed',
  'cancelled',
];

/**
 * Whether the phone should offer the button. Requires an opted-in desktop
 * whose heartbeat is fresh and whose resolved stake matches the one the
 * manager is looking at — a desktop parked in another stake can't help.
 */
export function isRemoteApplyOnline(
  presence: RemoteApplyPresence | null | undefined,
  activeStakeId: string,
  nowMs: number,
): boolean {
  if (!presence || presence.remote_apply_enabled !== true) return false;
  if (presence.stake_id !== activeStakeId) return false;
  return nowMs - presence.last_seen_at.toMillis() < REMOTE_APPLY_STALE_MS;
}

/** True once a job has reached a state the extension will no longer touch. */
export function isRemoteApplyTerminal(status: RemoteApplyJobStatus): boolean {
  return REMOTE_APPLY_TERMINAL_STATUSES.includes(status);
}
