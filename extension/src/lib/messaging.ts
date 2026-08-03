// Cross-context message protocol shared by the service worker and the
// content-script panel.
//
// Content scripts CANNOT call chrome.identity or interact directly
// with the Firebase Auth SDK. The service worker owns auth state +
// callable invocations; the content script asks via
// chrome.runtime.sendMessage and renders the response. This module
// declares the wire shapes so both ends agree.
//
// On serialisation: chrome.runtime.sendMessage serialises via the
// structured-clone algorithm. The only payloads we send are plain JSON
// (callable inputs / outputs are JSON-safe; auth state is reduced to
// { email, displayName } before crossing the boundary). Firestore
// Timestamp values surface as `{ seconds, nanoseconds }` once they
// pass through httpsCallable, which is the shape the panel renderer
// already handles.

import type {
  Access,
  Building,
  GetMyPendingRequestsInput,
  GetMyPendingRequestsOutput,
  KindooManager,
  KindooSite,
  MarkRequestCompleteInput,
  MarkRequestCompleteOutput,
  RemoteApplyOutcome,
  Seat,
  Stake,
  SyncApplyFixInput,
  SyncApplyFixResult,
  Ward,
} from '@kindoo/shared';

/** Reduced user shape — the only auth fields the panel renders. The
 * panel does NOT consume custom claims directly; the SW re-reads
 * `managerStakes` on every `data.resolveEidStakes` to avoid staleness
 * windows between snapshot read and resolver dispatch. */
export interface PrincipalSnapshot {
  uid: string;
  email: string | null;
  displayName: string | null;
}

export type AuthSnapshot =
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: PrincipalSnapshot };

/** Wire shape for errors crossing the SW boundary. */
export interface WireError {
  /** Stable code the panel can switch on (`'permission-denied'`,
   * `'consent_dismissed'`, etc.). */
  code: string;
  message: string;
}

// ---- Request envelopes -------------------------------------------------

export interface AuthGetStateRequest {
  type: 'auth.getState';
}

export interface AuthSignInRequest {
  type: 'auth.signIn';
}

export interface AuthSignOutRequest {
  type: 'auth.signOut';
}

export interface ApiGetMyPendingRequestsRequest {
  type: 'api.getMyPendingRequests';
  payload: GetMyPendingRequestsInput;
}

export interface ApiMarkRequestCompleteRequest {
  type: 'api.markRequestComplete';
  payload: MarkRequestCompleteInput;
}

export interface PanelTogglePushRequest {
  type: 'panel.togglePushedFromSw';
}

// ---- v2.1 configuration -----------------------------------------------

/**
 * One-shot read of the stake doc + every building doc under it. The
 * Configure panel uses this to (a) verify the stake name against
 * Kindoo's site name, and (b) render one row per building for rule
 * assignment.
 */
export interface DataGetStakeConfigRequest {
  type: 'data.getStakeConfig';
  /** Stake to read against. Threaded from the picker / single-resolution
   * step in `App.tsx`; the SW does not assume a default. */
  stakeId: string;
}

export interface DataGetStakeConfigPayload {
  stake: Stake;
  buildings: Building[];
  /**
   * Every ward under the stake — needed by v2.2's provision flow to
   * resolve a ward-scoped request's display name (`request.scope` is
   * a ward_code; the orchestrator maps it to `ward.ward_name` for the
   * Kindoo Description field). Empty for stakes with no wards yet.
   */
  wards: Ward[];
  /**
   * Foreign Kindoo sites configured for the stake — see Kindoo Sites
   * (spec §15). Empty for stakes operating only their home site.
   * Phase 3 reads this on the provision flow to validate the active
   * Kindoo session's EID matches the request's target site.
   */
  kindooSites: KindooSite[];
}

/**
 * Persist the operator's site-verification + per-building rule
 * assignments. SW does a single batched write so partial application
 * is impossible.
 */
export interface DataWriteKindooConfigRequest {
  type: 'data.writeKindooConfig';
  /** Stake to write against. */
  stakeId: string;
  payload: WriteKindooConfigPayload;
}

export interface WriteKindooConfigPayload {
  /**
   * Which configured Kindoo site this save applies to:
   *   - `null` → home site. Writes `stake.kindoo_config` + per-building
   *     `kindoo_rule` on home-site buildings.
   *   - `<string>` → foreign `KindooSite` doc id. Writes per-building
   *     `kindoo_rule` on foreign-site buildings + (when supplied)
   *     auto-populates `kindoo_eid` on the foreign site doc. Does NOT
   *     touch `stake.kindoo_config`.
   *
   * Phase 5 — the configure wizard scopes to one site per run. See
   * `extension/docs/v2-design.md` "Per-site configuration".
   */
  kindooSiteId: string | null;
  /** Active Kindoo session's EID. Persisted onto `stake.kindoo_config`
   * for the home save; persisted onto the foreign `KindooSite` doc as
   * `kindoo_eid` for a foreign save when the foreign doc doesn't carry
   * one yet (Phase 3 auto-populate path, run from the wizard). */
  siteId: number;
  /** Active Kindoo session's site `Name`. Persisted onto
   * `stake.kindoo_config.site_name` for the home save; foreign saves
   * carry it for diagnostics but don't write it (foreign sites already
   * carry `kindoo_expected_site_name` from the Configuration UI). */
  siteName: string;
  buildingRules: Array<{
    buildingId: string;
    ruleId: number;
    ruleName: string;
  }>;
}

/**
 * One-shot read of the SBA `Seat` doc for a request's subject. v2.2's
 * read-first orchestrator uses this to compute the post-completion
 * seat state (which buildings to grant, which to drop, what to
 * synthesize as the Kindoo Description). `null` is a valid return
 * — first-time-add cases have no seat yet.
 */
export interface DataGetSeatByEmailRequest {
  type: 'data.getSeatByEmail';
  /** Stake to read against. */
  stakeId: string;
  /** Canonical email — caller has already run `canonicalEmail()`. */
  canonical: string;
}

/**
 * One-shot read of the `access` doc for a request's requester. The panel
 * live-derives the requester's display name + calling from it
 * (`deriveRequesterDisplay` / `formatRequesterLabel`) for the "Requester:"
 * card line — nothing is captured on the request at submit time (Option
 * A). `null` is a valid return (no access doc); the label degrades to the
 * raw requester email.
 */
export interface DataGetAccessByEmailRequest {
  type: 'data.getAccessByEmail';
  /** Stake to read against. */
  stakeId: string;
  /** Canonical email — the `access` doc id. */
  canonical: string;
}

/**
 * One-shot read of the `kindooManagers` doc for a request's requester.
 * Kindoo Managers may submit a request in ANY scope without holding an
 * `access` row, so this doc backstops the requester line — the panel
 * passes it to `deriveRequesterDisplay` alongside the `access` doc to
 * render `{Name} (Kindoo Manager)`. `null` is a valid return (requester
 * is not a manager); the label then derives from `access` alone.
 */
export interface DataGetKindooManagerByEmailRequest {
  type: 'data.getKindooManagerByEmail';
  /** Stake to read against. */
  stakeId: string;
  /** Canonical email — the `kindooManagers` doc id. */
  canonical: string;
}

/**
 * Persist a discovered Kindoo environment ID onto a foreign
 * `KindooSite` doc. Kindoo Sites Phase 3 — the manager UI captures
 * only display name + expected site name; the extension auto-
 * populates `kindoo_eid` the first time the operator runs a provision
 * on a session whose site name matches the foreign site. One doc-id
 * + eid pair per call; rules already gate the write manager-only.
 */
export interface DataWriteKindooSiteEidRequest {
  type: 'data.writeKindooSiteEid';
  /** Stake to write against. */
  stakeId: string;
  payload: {
    /** Foreign `KindooSite` doc id under `stakes/{stakeId}/kindooSites/`. */
    kindooSiteId: string;
    /** EID discovered on the active Kindoo session. */
    kindooEid: number;
  };
}

/**
 * One-shot read of every collection the Sync feature needs to compute
 * drift between SBA's seat state and Kindoo's user state.
 */
export interface DataGetSyncDataRequest {
  type: 'data.getSyncData';
  /** Stake to read against. */
  stakeId: string;
}

/**
 * Reject a pending request. SW-side write that mirrors the web's
 * `useRejectRequest`: a transaction flips `status` pending → rejected
 * with a required `rejectionReason`. The Firestore rule's reject
 * transition gates on `isManager(stakeId)`, a non-empty
 * `rejection_reason`, `completer_canonical == auth canonical`, and a
 * `hasOnly` allowlist of exactly the six written fields — the SW
 * handler stamps that set and nothing else.
 */
export interface DataRejectRequestRequest {
  type: 'data.rejectRequest';
  /** Stake the request lives under. */
  stakeId: string;
  /** `requests/{requestId}` doc id. */
  requestId: string;
  /** Required free-text reason. Trimmed + non-empty checked SW-side. */
  rejectionReason: string;
}

/**
 * Apply a single per-row Sync Phase 2 fix on the SBA side. The callable
 * itself stamps the seat write with the `SyncActor:<code>` sentinel;
 * the extension just shuttles the operator's discriminated payload
 * through. Kindoo is authoritative: every fix — including the
 * `sba-only` "Remove From SBA" delete — flows through this handler;
 * sync never writes SBA → Kindoo.
 */
export interface DataSyncApplyFixRequest {
  type: 'data.syncApplyFix';
  payload: SyncApplyFixInput;
}

export interface SyncDataBundle {
  stake: Stake;
  wards: Ward[];
  buildings: Building[];
  seats: Seat[];
  /**
   * Foreign Kindoo sites (`stakes/{stakeId}/kindooSites/*`). Used by
   * the Sync detector to scope drift comparisons to the active Kindoo
   * site (see `content/kindoo/sync/activeSite.ts`).
   */
  kindooSites: KindooSite[];
}

/**
 * Resolve the set of stakes the signed-in operator manages that are
 * configured with the given Kindoo EID — either as a stake's home site
 * (`stake.kindoo_config.site_id`) or as one of its `kindooSites/<id>`
 * foreign entries (`kindoo_eid`). Drives the slide-over panel's stake
 * picker when an EID is shared across multiple managed stakes.
 */
export interface DataResolveEidStakesRequest {
  type: 'data.resolveEidStakes';
  /** Active Kindoo session's EID (DOM-scraped by the content script). */
  eid: number;
}

/** One candidate stake for a given EID. */
export interface EidStakeCandidate {
  stakeId: string;
  /** Display label sourced from the stake doc (`stake_name`). */
  label: string;
  /** Why the EID matched this stake — drives an inline hint in the
   * picker. `home` = `stake.kindoo_config.site_id === eid`;
   * `foreign` = some `kindooSites/<id>.kindoo_eid === eid`. */
  match: 'home' | 'foreign';
  /** When `match === 'foreign'`, the foreign site's display name. */
  siteLabel?: string;
}

/** Wire shape for resolveEidStakes result. The count + flag fields let
 * the panel disambiguate three structurally distinct empty-candidates
 * cases without re-querying:
 *   - `managedStakeCount === 0`                          → NotAuthorized
 *   - `partialFailure && candidates.length === 0`        → wire-error
 *     (every per-stake read threw — transient outage; misleading to
 *      tell the operator to reconfigure SBA)
 *   - `managedStakeCount > 0 && !partialFailure && candidates.length === 0`
 *                                                       → no-candidates
 *     (genuine "EID isn't configured under any of your stakes")
 *
 * `failedStakes` carries the stakeIds whose reads threw, so a partial
 * failure with surviving candidates can surface a non-modal banner
 * above the picker / resolved view (T-48). `partialFailure` is a
 * convenience alias for `failedStakes.length > 0`. */
export interface ResolveEidStakesPayload {
  candidates: EidStakeCandidate[];
  /** Total number of stakes on which the signed-in user holds
   * `manager: true`. Zero routes to NotAuthorized. */
  managedStakeCount: number;
  /** StakeIds of every per-stake closure that caught (rules denial,
   * Firestore hiccup, transient outage). Empty array means no
   * read-side failures. */
  failedStakes: string[];
  /** True iff at least one per-stake closure caught. Convenience alias
   * for `failedStakes.length > 0`. */
  partialFailure: boolean;
}

// ---- Remote apply (phone → desktop mailbox) ---------------------------
//
// The mailbox lives at `remoteApply/{canonicalEmail}` with a `jobs`
// subcollection. The canonical email is NEVER sent across this
// boundary: the SW derives it from its own auth token, so a
// compromised page context can't address someone else's mailbox even
// if it could forge a message. See `docs/architecture.md` D27 and
// `packages/shared/src/types/remoteApply.ts`.

/**
 * Publish (or clear) this desktop's presence. The content script sends
 * this on its heartbeat, and once more with `enabled: false` the moment
 * the operator switches the opt-in off — clearing eagerly is what makes
 * the phone's button disappear immediately instead of after the
 * staleness window.
 */
export interface DataWriteRemotePresenceRequest {
  type: 'data.writeRemotePresence';
  payload: RemoteApplyPresenceInput;
}

export interface RemoteApplyPresenceInput {
  /** Stake the extension has resolved for its active Kindoo site. */
  stakeId: string;
  /** Active Kindoo EID; `null` only on the disable write, where the
   * Kindoo session may already be gone. */
  kindooEid: number | null;
  /** Active Kindoo site's display name; `null` when unresolvable. */
  kindooSiteName: string | null;
  /** `chrome.runtime.getManifest().version`. */
  extVersion: string;
  /** Mirrors the `chrome.storage.local` opt-in toggle. */
  enabled: boolean;
}

/**
 * Fetch at most one `queued` job from the operator's mailbox. One
 * `getDocs` per poll tick; no composite index needed (single equality
 * filter + limit).
 */
export interface DataRemoteApplyNextJobRequest {
  type: 'data.remoteApplyNextJob';
}

/** The fields the runner needs off a queued job doc. */
export interface RemoteApplyJobRef {
  jobId: string;
  requestId: string;
  stakeId: string;
}

/**
 * Fetch every `running` job in the operator's mailbox — the input to the
 * stranded-job sweep. A job strands when the tab that claimed it dies (or
 * its terminal write fails) between `queued → running` and the terminal
 * write: the poller only ever queries `queued`, and the phone's cancel
 * path is `queued → cancelled`, so nothing else would ever move it again.
 */
export interface DataRemoteApplyRunningJobsRequest {
  type: 'data.remoteApplyRunningJobs';
}

/** A `running` job plus the age the sweep judges it by. */
export interface RemoteApplyRunningJobRef extends RemoteApplyJobRef {
  /**
   * `claimed_at` in epoch ms, falling back to `created_at`. `null` when
   * neither resolved to a real timestamp — an unaged job is never swept,
   * since the sweep's only safety argument is that it is too old to still
   * be in flight.
   */
  claimedAtMs: number | null;
}

/**
 * Claim a queued job (`queued → running`). The rules enforce the
 * compare-and-set, so a second Kindoo tab racing for the same job gets
 * `permission-denied` — which the SW reports as `claimed: false`, NOT
 * an error. Losing a race is the expected outcome of a healthy
 * multi-tab setup, not a fault to surface.
 */
export interface DataRemoteApplyClaimJobRequest {
  type: 'data.remoteApplyClaimJob';
  jobId: string;
  payload: {
    extVersion: string;
    kindooEid: number | null;
  };
}

/** Write a job's terminal status + outcome. */
export interface DataRemoteApplyFinishJobRequest {
  type: 'data.remoteApplyFinishJob';
  jobId: string;
  payload: {
    /** Terminal statuses the extension may write. `cancelled` belongs
     * to the phone's no-pickup timeout, not to us. */
    status: 'applied' | 'partial' | 'failed';
    outcome: RemoteApplyOutcome;
  };
}

/** Discriminated union of every request the panel may send. */
export type ExtensionRequest =
  | AuthGetStateRequest
  | AuthSignInRequest
  | AuthSignOutRequest
  | ApiGetMyPendingRequestsRequest
  | ApiMarkRequestCompleteRequest
  | PanelTogglePushRequest
  | DataGetStakeConfigRequest
  | DataWriteKindooConfigRequest
  | DataGetSeatByEmailRequest
  | DataGetAccessByEmailRequest
  | DataGetKindooManagerByEmailRequest
  | DataGetSyncDataRequest
  | DataSyncApplyFixRequest
  | DataWriteKindooSiteEidRequest
  | DataResolveEidStakesRequest
  | DataRejectRequestRequest
  | DataWriteRemotePresenceRequest
  | DataRemoteApplyNextJobRequest
  | DataRemoteApplyRunningJobsRequest
  | DataRemoteApplyClaimJobRequest
  | DataRemoteApplyFinishJobRequest;

// ---- Response envelopes ------------------------------------------------

export type Result<T> = { ok: true; data: T } | { ok: false; error: WireError };

export type AuthGetStateResponse = Result<AuthSnapshot>;
export type AuthSignInResponse = Result<AuthSnapshot>;
export type AuthSignOutResponse = Result<{ done: true }>;
export type ApiGetMyPendingRequestsResponse = Result<GetMyPendingRequestsOutput>;
export type ApiMarkRequestCompleteResponse = Result<MarkRequestCompleteOutput>;
export type DataGetStakeConfigResponse = Result<DataGetStakeConfigPayload>;
export type DataWriteKindooConfigResponse = Result<{ ok: true }>;
export type DataGetSeatByEmailResponse = Result<Seat | null>;
export type DataGetAccessByEmailResponse = Result<Access | null>;
export type DataGetKindooManagerByEmailResponse = Result<KindooManager | null>;
export type DataGetSyncDataResponse = Result<SyncDataBundle>;
export type DataSyncApplyFixResponse = Result<SyncApplyFixResult>;
export type DataWriteKindooSiteEidResponse = Result<{ ok: true }>;
export type DataResolveEidStakesResponse = Result<ResolveEidStakesPayload>;
export type DataRejectRequestResponse = Result<{ ok: true }>;
export type DataWriteRemotePresenceResponse = Result<{ ok: true }>;
export type DataRemoteApplyNextJobResponse = Result<RemoteApplyJobRef | null>;
export type DataRemoteApplyRunningJobsResponse = Result<RemoteApplyRunningJobRef[]>;
export type DataRemoteApplyClaimJobResponse = Result<{ claimed: boolean }>;
export type DataRemoteApplyFinishJobResponse = Result<{ ok: true }>;

/** Lookup from a request `type` to its response shape. */
export type ResponseFor<R extends ExtensionRequest> = R extends AuthGetStateRequest
  ? AuthGetStateResponse
  : R extends AuthSignInRequest
    ? AuthSignInResponse
    : R extends AuthSignOutRequest
      ? AuthSignOutResponse
      : R extends ApiGetMyPendingRequestsRequest
        ? ApiGetMyPendingRequestsResponse
        : R extends ApiMarkRequestCompleteRequest
          ? ApiMarkRequestCompleteResponse
          : R extends DataGetStakeConfigRequest
            ? DataGetStakeConfigResponse
            : R extends DataWriteKindooConfigRequest
              ? DataWriteKindooConfigResponse
              : R extends DataGetSeatByEmailRequest
                ? DataGetSeatByEmailResponse
                : R extends DataGetAccessByEmailRequest
                  ? DataGetAccessByEmailResponse
                  : R extends DataGetKindooManagerByEmailRequest
                    ? DataGetKindooManagerByEmailResponse
                    : R extends DataGetSyncDataRequest
                      ? DataGetSyncDataResponse
                      : R extends DataSyncApplyFixRequest
                        ? DataSyncApplyFixResponse
                        : R extends DataWriteKindooSiteEidRequest
                          ? DataWriteKindooSiteEidResponse
                          : R extends DataResolveEidStakesRequest
                            ? DataResolveEidStakesResponse
                            : R extends DataRejectRequestRequest
                              ? DataRejectRequestResponse
                              : R extends DataWriteRemotePresenceRequest
                                ? DataWriteRemotePresenceResponse
                                : R extends DataRemoteApplyNextJobRequest
                                  ? DataRemoteApplyNextJobResponse
                                  : R extends DataRemoteApplyRunningJobsRequest
                                    ? DataRemoteApplyRunningJobsResponse
                                    : R extends DataRemoteApplyClaimJobRequest
                                      ? DataRemoteApplyClaimJobResponse
                                      : R extends DataRemoteApplyFinishJobRequest
                                        ? DataRemoteApplyFinishJobResponse
                                        : never;

// ---- Push (SW → CS) ---------------------------------------------------

/**
 * Pushed by the service worker to all content scripts when the
 * signed-in user changes (sign-in, sign-out, refresh). The panel
 * subscribes via `chrome.runtime.onMessage` and re-renders.
 */
export interface AuthStateChangedPush {
  type: 'auth.stateChanged';
  state: AuthSnapshot;
}

export type ExtensionPush = AuthStateChangedPush;

/** Storage key used by both ends; lifted into a const to keep them in sync. */
export const STORAGE_KEYS = {
  /** Cached access token returned by `chrome.identity.getAuthToken`. */
  googleAccessToken: 'sba.googleAccessToken',
  /** Last-known principal snapshot for instant signed-in UI on SW revive. */
  principalSnapshot: 'sba.principalSnapshot',
  /** Whether the slide-over panel is open. Persists across Kindoo
   * SPA navigations + page reloads. */
  panelOpen: 'sba.panelOpen',
  /**
   * Per-EID stake choice. Value is `Record<eidString, stakeId>` — one
   * single chrome.storage.local slot rather than one slot per EID so
   * sign-out can wipe every choice in a single `remove()`. Written by
   * the picker's confirm handler; read on every panel mount during
   * App.tsx's active-stake resolution. Stored choices are validated
   * against the live `data.resolveEidStakes` result and dropped if the
   * stake is no longer a candidate (role revocation, config change).
   */
  eidStakeChoice: 'sba.eidStakeChoice',
  /**
   * Remote-apply opt-in ("Allow requests from my phone"). Absent ⇒ off:
   * this grants a second device authority to provision access, so a
   * profile that predates the feature must never read as consent.
   * Single owner: `lib/remoteApplyPrefs.ts`.
   */
  remoteApplyEnabled: 'sba.remoteApplyEnabled',
} as const;

/** Shape stored under `STORAGE_KEYS.eidStakeChoice`. */
export type EidStakeChoiceMap = Record<string, string>;
