// Timings and predicates for remote apply. Shared so the phone and the
// desktop extension agree on when a desktop counts as online — a split
// definition would show the manager a button that can never be claimed.
// Doc shapes live in `types/remoteApply.ts`.

import type {
  RemoteApplyDesktopWithId,
  RemoteApplyJobStatus,
  RemoteApplyPresence,
} from './types/remoteApply.js';

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

/** The profile-wide opt-in. Absent or false ⇒ no desktop may be used. */
export function isRemoteApplyEnabled(presence: RemoteApplyPresence | null | undefined): boolean {
  return presence?.remote_apply_enabled === true;
}

/**
 * Every desktop tab that is opted in, fresh, and sitting in the stake the
 * manager is looking at. A tab parked in another stake can't help, and a
 * stale one has stopped heartbeating — usually because its Kindoo tab was
 * closed or its Kindoo session expired.
 */
export function freshRemoteApplyDesktops(
  presence: RemoteApplyPresence | null | undefined,
  desktops: readonly RemoteApplyDesktopWithId[] | null | undefined,
  activeStakeId: string,
  nowMs: number,
): RemoteApplyDesktopWithId[] {
  if (!isRemoteApplyEnabled(presence) || !desktops) return [];
  return desktops.filter(
    (d) =>
      d.stake_id === activeStakeId && nowMs - d.last_seen_at.toMillis() < REMOTE_APPLY_STALE_MS,
  );
}

/**
 * The desktop that can run a given request, or null if none can.
 *
 * A request names its target Kindoo site, and a tab can only provision for
 * the site it is currently inside — so this is per-request, not per-manager.
 * A request with no site (single-site stakes, and every request predating
 * multi-site) is servable by any fresh tab in the stake.
 *
 * Returning the desktop rather than a boolean lets the caller name the site
 * in the UI, which is the difference between "your desktop is offline" and
 * "open <site> in Kindoo to apply this one".
 */
export function remoteApplyDesktopForRequest(
  presence: RemoteApplyPresence | null | undefined,
  desktops: readonly RemoteApplyDesktopWithId[] | null | undefined,
  activeStakeId: string,
  kindooSiteId: string | null | undefined,
  nowMs: number,
): RemoteApplyDesktopWithId | null {
  const fresh = freshRemoteApplyDesktops(presence, desktops, activeStakeId, nowMs);
  if (fresh.length === 0) return null;
  if (kindooSiteId == null) return fresh[0] ?? null;
  return fresh.find((d) => d.site_id === kindooSiteId) ?? null;
}

/**
 * Whether a tab inside `kindooSiteId` may claim `job`. The extension's
 * poller consults this before claiming: a job it cannot serve must be left
 * for the sibling tab that can, not claimed and failed.
 */
export function canClaimRemoteApplyJob(
  job: { stake_id: string; kindoo_site_id?: string | null },
  tabStakeId: string,
  tabSiteId: string | null,
): boolean {
  if (job.stake_id !== tabStakeId) return false;
  if (job.kindoo_site_id == null) return true;
  return job.kindoo_site_id === tabSiteId;
}

/** True once a job has reached a state the extension will no longer touch. */
export function isRemoteApplyTerminal(status: RemoteApplyJobStatus): boolean {
  return REMOTE_APPLY_TERMINAL_STATUSES.includes(status);
}
