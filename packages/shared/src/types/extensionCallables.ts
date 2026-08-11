// Input / output shapes for the HTTPS callables in the Chrome MV3
// extension's path (`extension/`). The extension calls
// `getMyPendingRequests` to surface the FIFO queue while a Kindoo
// Manager works the Kindoo UI, then calls `markRequestComplete` to
// flip a pending request to `complete`. `mintExtensionToken` is the
// odd one out — the SPA's `/auth/extension` route calls it on the
// extension's behalf during the sign-in handoff.
//
// The SPA-side completion path (`apps/web/src/features/manager/queue/hooks.ts`)
// performs more work in a client transaction (it writes the new seat
// doc for add-type requests; for remove-type it lets the
// `removeSeatOnRequestComplete` Cloud Function delete the seat). The
// extension callable handles only the request-doc flip — it is scoped
// to the simpler case where the manager has already worked the door
// system in the Kindoo UI and just needs to record completion. The
// audit trigger writes the audit row from the request-doc write; the
// `notifyOnRequestWrite` trigger fires the requester email from the
// same write. No extra wiring needed.
//
// Types live here so the extension wrapper (web-engineer's lane) and
// the callable (`functions/src/callable/`) share one shape.
import type { AccessRequest } from './request.js';
import type { OverCapEntry } from './stake.js';

export type GetMyPendingRequestsInput = {
  stakeId: string;
};

export type GetMyPendingRequestsOutput = {
  /** Pending requests for the stake, oldest first by `requested_at`. */
  requests: AccessRequest[];
};

export type MarkRequestCompleteInput = {
  stakeId: string;
  requestId: string;
  /**
   * Optional free-text note from the manager. Trimmed server-side; an
   * empty result is dropped from the write so the request doc stays
   * clean. The `notifyRequesterCompleted` trigger surfaces this value
   * on the email body when present.
   */
  completionNote?: string;
  /**
   * Extension v2.2 — Kindoo internal user id captured by the
   * "Provision & Complete" flow. When present, persisted on the
   * request doc as `kindoo_uid`. The SPA mark-complete path does
   * not set this.
   */
  kindooUid?: string;
  /**
   * Extension v2.2 — human-readable summary of what the provision
   * flow did in Kindoo. Trimmed server-side; max ~500 chars. When
   * present, persisted on the request doc as `provisioning_note`.
   */
  provisioningNote?: string;
};

/**
 * `mintExtensionToken` takes no payload — the caller's own session is
 * the whole input, and the token is minted for `request.auth.uid`.
 */
export type MintExtensionTokenOutput = {
  /**
   * Firebase custom token for the calling user's uid. The extension
   * exchanges it via `signInWithCustomToken` to get a session with its
   * own refresh token — it is the handoff, not the session.
   *
   * Short-lived (1h) but **not** single-use: it can be redeemed
   * repeatedly until it expires, and each redemption yields a full
   * session. Anything that leaks it inside that hour is a session
   * compromise, which is why the handoff rides the URL fragment and
   * why the redirect target is allowlisted rather than shape-checked.
   */
  token: string;
};

export type MarkRequestCompleteOutput = {
  ok: true;
  /**
   * Post-completion over-cap snapshot. Recomputed inside the same
   * transaction that flips the request and writes to `last_over_caps_json`
   * on the stake doc. The extension renders a warning when this is
   * non-empty. Always returned (`[]` when all pools are within cap) so
   * the consumer can distinguish "no over-caps" from "field absent for
   * other reasons".
   */
  over_caps: OverCapEntry[];
};
