// Timings and predicates for remote apply. Shared so the phone and the
// desktop extension agree on when a desktop counts as online — a split
// definition would show the manager a button that can never be claimed.
// Doc shapes live in `types/remoteApply.ts`.

import { resolveWardSite } from './resolveWardSite.js';
import type { AccessRequest } from './types/request.js';
import type { Building } from './types/building.js';
import type { Ward } from './types/ward.js';
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

/**
 * Doc-id form of "the home site". Home has no `kindooSites` document — it
 * lives on `stake.kindoo_config` — so the codebase represents it as
 * `kindoo_site_id: null` on wards and buildings. A Firestore doc id can't
 * be null, hence this reserved key.
 *
 * A manager-chosen foreign-site slug of `'home'` would collide. That is
 * why every surface derives its key through `remoteApplySiteKey` rather
 * than hand-rolling the `?? 'home'`: if the collision ever needs handling,
 * it is one function to change.
 */
export const REMOTE_APPLY_HOME_SITE_KEY = 'home';

/**
 * Kindoo site id → the key used for `desktops/{siteKey}` doc ids and for
 * a job's `target_site_key`. Null / undefined (home) becomes the reserved
 * home key; a foreign site keeps its `kindooSites` doc id.
 */
export function remoteApplySiteKey(kindooSiteId: string | null | undefined): string {
  return kindooSiteId == null ? REMOTE_APPLY_HOME_SITE_KEY : kindooSiteId;
}

/**
 * The Kindoo site a request must be provisioned on, as a site key.
 *
 * This MUST stay in step with the extension's `checkRequestSite`
 * (`content/kindoo/siteCheck.ts`), which is what actually refuses a
 * provision on the wrong site. If the phone derives a different answer it
 * offers a button the desktop then rejects — the exact failure the
 * per-site model exists to remove. The rule, mirrored from there:
 *
 *   - `scope === 'stake'` → home, unconditionally. A stake-scope request's
 *     `building_names` may span buildings on different sites; it is still
 *     provisioned on home, so buildings do not enter the derivation.
 *   - ward scope → the ward's building's site; null ⇒ home.
 *   - ward not in the ward set → home, matching `resolveWardForeignSite`
 *     returning null for an unknown ward.
 *
 * Note this can name a foreign site that has no `kindooSites` doc; the
 * desktop raises `ProvisionForeignSiteMissingError` in that case. The
 * phone just won't find a matching desktop and won't offer the button.
 */
export function remoteApplyTargetSiteKey(
  request: Pick<AccessRequest, 'scope'>,
  wards: readonly Ward[],
  buildings: readonly Building[],
): string {
  if (request.scope === 'stake') return REMOTE_APPLY_HOME_SITE_KEY;
  const ward = wards.find((w) => w.ward_code === request.scope);
  if (!ward) return REMOTE_APPLY_HOME_SITE_KEY;
  return remoteApplySiteKey(resolveWardSite(ward, buildings));
}

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
 * The desktop that can run a request targeting `targetSiteKey`, or null if
 * none can. A tab can only provision for the site it is currently inside,
 * so this is per-request, not per-manager.
 *
 * The match is exact, with no "any tab will do" fallback: home is a site
 * like any other here (`REMOTE_APPLY_HOME_SITE_KEY`), so a home request
 * routed to a foreign tab would be a doomed button — the phone would offer
 * it and the desktop's own site check would refuse it.
 *
 * Returning the desktop rather than a boolean lets the caller name the site
 * in the UI, which is the difference between "your desktop is offline" and
 * "open <site> in Kindoo to apply this one".
 */
export function remoteApplyDesktopForRequest(
  presence: RemoteApplyPresence | null | undefined,
  desktops: readonly RemoteApplyDesktopWithId[] | null | undefined,
  activeStakeId: string,
  targetSiteKey: string,
  nowMs: number,
): RemoteApplyDesktopWithId | null {
  const fresh = freshRemoteApplyDesktops(presence, desktops, activeStakeId, nowMs);
  return fresh.find((d) => d.site_key === targetSiteKey) ?? null;
}

/**
 * Whether a tab sitting in `tabSiteKey` may claim `job`. The extension's
 * poller consults this before claiming: a job it cannot serve must be left
 * for the sibling tab that can, not claimed and failed.
 */
export function canClaimRemoteApplyJob(
  job: { stake_id: string; target_site_key: string },
  tabStakeId: string,
  tabSiteKey: string | null,
): boolean {
  if (job.stake_id !== tabStakeId) return false;
  if (tabSiteKey == null) return false;
  return job.target_site_key === tabSiteKey;
}

/** True once a job has reached a state the extension will no longer touch. */
export function isRemoteApplyTerminal(status: RemoteApplyJobStatus): boolean {
  return REMOTE_APPLY_TERMINAL_STATUSES.includes(status);
}
