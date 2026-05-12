// Input / output shapes for the two HTTPS callables consumed by the
// Chrome MV3 side-panel extension (`extension/`). The extension calls
// `getMyPendingRequests` to surface the FIFO queue while a Kindoo
// Manager works the Kindoo UI, then calls `markRequestComplete` to
// flip a pending request to `complete`.
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
};

export type MarkRequestCompleteOutput = {
  ok: true;
};
