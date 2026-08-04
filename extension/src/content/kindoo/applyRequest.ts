// The one provisioning orchestration. Two surfaces drive it:
//
//   1. `panel/RequestCard.tsx` — the operator's "Provision & Complete"
//      button.
//   2. `content/remoteApply/runner.ts` — a job the manager queued from
//      their phone.
//
// They MUST share this code. If each kept its own copy of the
// session → seat → envs → site-check → provision → markRequestComplete
// sequence, the phone would eventually report a different result than
// the desktop for the same request, and the operator would have no way
// to tell which one lied.
//
// The return value is a discriminated outcome rather than thrown
// errors: the card renders it into `ResultDialog`, the runner
// serialises it into the job doc. `code` maps 1:1 onto
// `RemoteApplyOutcomeCode` so the phone can branch on a stable
// discriminator, and `message` is the operator-facing sentence authored
// here so both surfaces word failures identically.
//
// `partial` is its own outcome — Kindoo succeeded but SBA's
// `markRequestComplete` did not. It carries `markCompleteInput` so the
// desktop's retry button (and only the SBA half) can re-run without
// touching Kindoo a second time.

import type {
  AccessRequest,
  MarkRequestCompleteInput,
  OverCapEntry,
  RemoteApplyOutcomeCode,
} from '@kindoo/shared';
import {
  getSeatByEmail,
  markRequestComplete,
  writeKindooSiteEid,
  type StakeConfigBundle,
} from '../../lib/extensionApi';
import { readKindooSession, type KindooSessionError } from './auth';
import { KindooApiError } from './client';
import { getEnvironments, type KindooEnvironment } from './endpoints';
import {
  provisionAddOrChange,
  provisionEdit,
  provisionRemove,
  ProvisionBuildingsMissingRuleError,
  ProvisionEditUserMissingError,
  ProvisionEnvironmentNotFoundError,
  ProvisionStakeAutoEditError,
  type ProvisionResult,
} from './provision';
import {
  checkRequestSite,
  ProvisionForeignSiteMissingError,
  ProvisionHomeSiteNotConfiguredError,
  ProvisionSiteMismatchError,
} from './siteCheck';

/** Codes `applyRequest` itself can produce. `request_not_pending` is
 * the runner's to raise (it resolves the request before calling in),
 * and `applied` / `sba_incomplete` ride the non-`failed` variants. */
export type ApplyRequestFailureCode = Extract<
  RemoteApplyOutcomeCode,
  'site_mismatch' | 'kindoo_session_lost' | 'building_rule_missing' | 'error'
>;

export type ApplyRequestResult =
  | {
      status: 'applied';
      /** Provisioning summary; rendered on both surfaces. */
      note: string;
      /** Kindoo `UserID`; `null` on the no-op remove path. */
      kindooUid: string | null;
      /** Post-completion over-cap snapshot from `markRequestComplete`. */
      overCaps: OverCapEntry[];
    }
  | {
      status: 'partial';
      note: string;
      kindooUid: string | null;
      /** Why the SBA half failed — verbatim from the callable. */
      message: string;
      /** Replay payload for an SBA-only retry. No Kindoo work repeats. */
      markCompleteInput: MarkRequestCompleteInput;
    }
  | { status: 'failed'; code: ApplyRequestFailureCode; message: string };

export interface ApplyRequestArgs {
  /** Active stake — the caller has already resolved it. */
  stakeId: string;
  request: AccessRequest;
  bundle: StakeConfigBundle;
}

/** Recovery copy for each way the Kindoo session can be unusable. */
const SESSION_MESSAGES: Record<KindooSessionError, string> = {
  'no-token': 'Sign into Kindoo first, then retry.',
  'no-eid':
    "Open a specific Kindoo site (click into one from the My Sites list) and retry. The extension can't tell which site you're working on otherwise.",
};

/**
 * Run the full Kindoo provision for one pending request, then mark it
 * complete in SBA. Never throws — every failure mode comes back as a
 * `failed` / `partial` outcome so both callers render the same words.
 *
 * Ordering is load-bearing:
 *   - the site check runs before ANY Kindoo write, so a session pointed
 *     at the wrong site can't grant access in the wrong buildings;
 *   - its `populate` instruction persists the discovered foreign-site
 *     EID before the orchestrator runs, so the next provision against
 *     that site short-circuits.
 */
export async function applyRequest({
  stakeId,
  request,
  bundle,
}: ApplyRequestArgs): Promise<ApplyRequestResult> {
  // 1. Resolve the Kindoo session from localStorage + the active-site
  //    DOM scrape (we run inside a web.kindoo.tech page).
  const sessionResult = readKindooSession();
  if (!sessionResult.ok) {
    return {
      status: 'failed',
      code: 'kindoo_session_lost',
      message: SESSION_MESSAGES[sessionResult.error],
    };
  }
  const session = sessionResult.session;

  // 2. Both add and remove paths need the SBA seat (read-first /
  //    merged-state: remove computes the post-removal shape to drive
  //    scope-specific Kindoo reconciliation) + envs (TimeZone on
  //    editUser).
  let seat: Awaited<ReturnType<typeof getSeatByEmail>>;
  try {
    seat = await getSeatByEmail(stakeId, request.member_canonical);
  } catch (err) {
    return { status: 'failed', code: 'error', message: describeError(err) };
  }
  let envs: KindooEnvironment[];
  try {
    envs = await getEnvironments(session);
  } catch (err) {
    return { status: 'failed', code: 'error', message: describeKindooError(err) };
  }

  // 3. Kindoo Sites Phase 3 — refuse when the active session points at
  //    the wrong site for this request.
  let siteCheck: ReturnType<typeof checkRequestSite>;
  try {
    siteCheck = checkRequestSite({
      request,
      session,
      envs,
      stake: bundle.stake,
      wards: bundle.wards,
      buildings: bundle.buildings,
      kindooSites: bundle.kindooSites,
    });
  } catch (err) {
    return { status: 'failed', code: 'error', message: describeProvisionError(err) };
  }
  if (!siteCheck.ok) {
    return {
      status: 'failed',
      code: siteCheck.error instanceof ProvisionSiteMismatchError ? 'site_mismatch' : 'error',
      message: siteCheck.error.message,
    };
  }
  if (siteCheck.populate) {
    try {
      await writeKindooSiteEid(
        stakeId,
        siteCheck.populate.kindooSiteId,
        siteCheck.populate.kindooEid,
      );
    } catch (err) {
      return { status: 'failed', code: 'error', message: describeError(err) };
    }
  }

  // 4. Drive Kindoo.
  let result: ProvisionResult;
  try {
    if (request.type === 'remove') {
      result = await provisionRemove({
        request,
        seat,
        stake: bundle.stake,
        buildings: bundle.buildings,
        wards: bundle.wards,
        envs,
        session,
      });
    } else if (
      request.type === 'edit_auto' ||
      request.type === 'edit_manual' ||
      request.type === 'edit_temp'
    ) {
      result = await provisionEdit({
        request,
        seat,
        stake: bundle.stake,
        buildings: bundle.buildings,
        wards: bundle.wards,
        envs,
        session,
      });
    } else {
      result = await provisionAddOrChange({
        request,
        seat,
        stake: bundle.stake,
        buildings: bundle.buildings,
        wards: bundle.wards,
        envs,
        session,
      });
    }
  } catch (err) {
    return {
      status: 'failed',
      code: err instanceof ProvisionBuildingsMissingRuleError ? 'building_rule_missing' : 'error',
      message: describeProvisionError(err),
    };
  }

  // 5. Kindoo is done. Mark the SBA request complete; a failure here is
  //    `partial`, not `failed` — access HAS been granted / revoked and
  //    reporting otherwise would send the operator chasing a ghost.
  const note = result.note;
  const markCompleteInput: MarkRequestCompleteInput = {
    stakeId,
    requestId: request.request_id,
    completionNote: note,
    provisioningNote: note,
    ...(result.kindoo_uid ? { kindooUid: result.kindoo_uid } : {}),
  };
  try {
    const completed = await markRequestComplete(markCompleteInput);
    return {
      status: 'applied',
      note,
      kindooUid: result.kindoo_uid,
      overCaps: completed.over_caps,
    };
  } catch (err) {
    return {
      status: 'partial',
      note,
      kindooUid: result.kindoo_uid,
      message: describeError(err),
      markCompleteInput,
    };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function describeKindooError(err: unknown): string {
  if (err instanceof KindooApiError) {
    return `Kindoo API error (${err.code}): ${err.message}`;
  }
  return describeError(err);
}

/**
 * Every provision-side error class already carries operator-facing
 * copy; unwrap to `message` and fall through to the Kindoo-API framing
 * for anything else.
 */
export function describeProvisionError(err: unknown): string {
  if (
    err instanceof ProvisionBuildingsMissingRuleError ||
    err instanceof ProvisionEnvironmentNotFoundError ||
    err instanceof ProvisionEditUserMissingError ||
    err instanceof ProvisionStakeAutoEditError ||
    err instanceof ProvisionSiteMismatchError ||
    err instanceof ProvisionHomeSiteNotConfiguredError ||
    err instanceof ProvisionForeignSiteMissingError
  ) {
    return err.message;
  }
  return describeKindooError(err);
}
