// One pending-request card.
//
// v1 surfaced a "Mark Complete" button that just round-tripped the SBA
// callable — the manager did all the Kindoo work manually. v2.2 closes
// the loop: the same button runs the full Kindoo provision flow first
// (add / change / remove) and only then marks the SBA request complete.
//
// State transitions:
//   - idle           → button rendered; click → provisioning
//   - provisioning   → button disabled, inline spinner; orchestrator runs
//   - error          → spinner clears, message shown below button,
//                      button re-enabled (orchestrator is idempotent —
//                      check/lookup-first; re-click resumes safely)
//   - done(ok)       → ResultDialog kind='ok' visible; dismiss removes card
//   - done(partial)  → ResultDialog kind='partial' visible; retry button
//                      calls markRequestComplete only

import { useCallback, useState } from 'react';
import { scopeLabel, type AccessRequest } from '@kindoo/shared';
import {
  getSeatByEmail,
  markRequestComplete,
  writeKindooSiteEid,
  type StakeConfigBundle,
} from '../lib/extensionApi';
import { readKindooSession, type KindooSession } from '../content/kindoo/auth';
import { KindooApiError } from '../content/kindoo/client';
import { getEnvironments, type KindooEnvironment } from '../content/kindoo/endpoints';
import {
  provisionAddOrChange,
  provisionEdit,
  provisionRemove,
  ProvisionBuildingsMissingRuleError,
  ProvisionEditUserMissingError,
  ProvisionEnvironmentNotFoundError,
  ProvisionStakeAutoEditError,
  type ProvisionResult,
} from '../content/kindoo/provision';
import {
  checkRequestSite,
  ProvisionForeignSiteMissingError,
  ProvisionHomeSiteNotConfiguredError,
  ProvisionSiteMismatchError,
} from '../content/kindoo/siteCheck';
import { ResultDialog, type ResultDialogState } from './ResultDialog';
import { RejectDialog } from './RejectDialog';

interface RequestCardProps {
  /** Active stake — threaded from App's resolution step. */
  stakeId: string;
  request: AccessRequest;
  bundle: StakeConfigBundle;
  /**
   * True when the request subject already has an SBA seat (any scope).
   * For `add_manual` / `add_temp` this blocks completion — `planAddMerge`
   * merges into the existing seat doc, but every add-on-existing case is
   * Reject-only by policy EXCEPT the stake-scope carve-out below. The
   * provision button is hidden and only Reject is offered. Parent
   * (`QueuePanel`) derives this from `getSeatByEmail`; a lookup failure
   * resolves to `false` so the provision button stays visible rather than
   * blocking the queue on a transient read miss.
   */
  memberHasSeat: boolean;
  /**
   * True when the seat already holds a stake-scope grant (primary OR any
   * duplicate). Backstops the stake-scope add carve-out: a stake-scope
   * `add_manual` for a member who has a seat but NO stake grant is
   * applyable — `markRequestComplete` → `planAddMerge` appends a
   * cross-scope `duplicate_grant` and succeeds — so the provision button
   * stays visible. If the member somehow ALREADY holds a stake grant the
   * add can't apply cleanly, so we keep blocking. Parent (`QueuePanel`)
   * derives this from the same seat object it fetches via
   * `getSeatByEmail`; absent / failed lookup resolves to `false`.
   */
  memberHasStakeGrant: boolean;
  /**
   * True when the request subject has NO SBA seat (lookup positively
   * resolved to null). For `edit_auto` / `edit_manual` / `edit_temp`
   * this blocks completion — `markRequestComplete` throws
   * `failed-precondition` ("no seat found for member … — cannot {type}")
   * against the missing seat doc before any slot planning runs — so the
   * provision button is hidden and only Reject is offered. Parent
   * (`QueuePanel`) derives this from `getSeatByEmail`. Fail-safe is the
   * opposite of `memberHasSeat`: an unknown/failed lookup resolves to
   * `false` so we do NOT false-block an editable request on a transient
   * miss — the server-side precondition is the backstop.
   */
  memberSeatAbsent: boolean;
  /** Called after the operator dismisses the result dialog OR after a
   * successful reject; parent drops the card from the queue list and
   * refetches. */
  onDismissed: (requestId: string) => void;
}

type CardState =
  | { kind: 'idle' }
  | { kind: 'provisioning' }
  | { kind: 'error'; message: string }
  | { kind: 'result'; dialog: ResultDialogState };

export function RequestCard({
  stakeId,
  request,
  bundle,
  memberHasSeat,
  memberHasStakeGrant,
  memberSeatAbsent,
  onDismissed,
}: RequestCardProps) {
  const [state, setState] = useState<CardState>({ kind: 'idle' });
  const [rejectOpen, setRejectOpen] = useState(false);

  const isUrgent = request.urgent === true;
  const submittedAt = formatTimestamp(request.requested_at);

  const provision = useCallback(async () => {
    setState({ kind: 'provisioning' });

    // 1. Resolve Kindoo session from localStorage (panel is mounted on
    //    web.kindoo.tech — same-origin).
    const sessionResult = readKindooSession();
    if (!sessionResult.ok) {
      setState({
        kind: 'error',
        message:
          sessionResult.error === 'no-token'
            ? 'Sign into Kindoo first, then retry.'
            : "Open a specific Kindoo site (click into one from the My Sites list) and retry. The extension can't tell which site you're working on otherwise.",
      });
      return;
    }
    const session: KindooSession = sessionResult.session;

    // 2. Run the orchestrator. Both add and remove paths need the SBA
    //    seat (read-first merged-state — remove computes the
    //    post-removal seat shape to drive scope-specific Kindoo
    //    reconciliation) + envs (for TimeZone on editUser).
    let seat: Awaited<ReturnType<typeof getSeatByEmail>>;
    try {
      seat = await getSeatByEmail(stakeId, request.member_canonical);
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }
    let envs: KindooEnvironment[];
    try {
      envs = await getEnvironments(session);
    } catch (err) {
      setState({ kind: 'error', message: describeKindooError(err) });
      return;
    }

    // Kindoo Sites Phase 3 — refuse to provision when the active
    // Kindoo session points at the wrong site for this request. Foreign
    // sites with no recorded EID get auto-populated here on a site-name
    // match; the EID write must complete BEFORE any Kindoo write so a
    // subsequent provision against this site short-circuits.
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
      setState({ kind: 'error', message: describeProvisionError(err) });
      return;
    }
    if (!siteCheck.ok) {
      setState({ kind: 'error', message: siteCheck.error.message });
      return;
    }
    if (siteCheck.populate) {
      try {
        await writeKindooSiteEid(
          stakeId,
          siteCheck.populate.kindooSiteId,
          siteCheck.populate.kindooEid,
        );
      } catch (err) {
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        return;
      }
    }

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
      setState({ kind: 'error', message: describeProvisionError(err) });
      return;
    }

    // 3. Kindoo done — now mark the SBA request complete. If this
    //    fails, surface a partial-success dialog with a retry button.
    await sendMarkComplete(stakeId, request.request_id, result, (dialog) =>
      setState({ kind: 'result', dialog }),
    );
  }, [stakeId, request, bundle]);

  const dismiss = useCallback(() => {
    onDismissed(request.request_id);
  }, [onDismissed, request.request_id]);

  const buttonLabel = labelForType(request.type);
  const isBusy = state.kind === 'provisioning';
  const isEdit =
    request.type === 'edit_auto' || request.type === 'edit_manual' || request.type === 'edit_temp';
  const buttonTestId =
    request.type === 'remove'
      ? `sba-remove-${request.request_id}`
      : isEdit
        ? `sba-edit-${request.request_id}`
        : `sba-add-${request.request_id}`;
  const buttonClass =
    request.type === 'remove'
      ? 'sba-btn sba-btn-danger'
      : isEdit
        ? 'sba-btn sba-btn-primary'
        : 'sba-btn sba-btn-success';

  // Adds for someone who already has a seat are Reject-only by policy —
  // hide the provision button and offer only Reject (mirrors the web
  // app's PR #191). Edit / remove types operate on an existing seat by
  // design and are unaffected.
  //
  // Carve-out: a stake-scope `add_manual` for a member who has a seat but
  // NO stake grant IS applyable — `markRequestComplete` → `planAddMerge`
  // appends a cross-scope `duplicate_grant` and succeeds (this is the
  // "Give Access To Stake Buildings" flow for a foreign-site-only member,
  // who always already holds their ward seat). `!memberHasStakeGrant` is
  // the backstop: if a stake grant already exists the add can't apply
  // cleanly, so keep blocking. Every other add-on-existing case stays
  // blocked exactly as before.
  const isAdd = request.type === 'add_manual' || request.type === 'add_temp';
  const applyableStakeAdd =
    request.type === 'add_manual' && request.scope === 'stake' && !memberHasStakeGrant;
  const blockedByExistingSeat = isAdd && memberHasSeat && !applyableStakeAdd;

  // Edit-side analog: an edit_* request edits an EXISTING seat. If the
  // member has no seat doc at all, `markRequestComplete` throws
  // `failed-precondition` ("no seat found for member … — cannot {type}")
  // before any slot planning runs. Hide the provision button and offer
  // only Reject when the seat is positively absent. (The distinct
  // seat-exists-but-no-matching-slot case — `planEditSeat`'s "no editable
  // slot" throw — is an out-of-scope follow-up.) Fail-safe: only block on
  // a definitive null lookup — an unknown / failed lookup leaves
  // `memberSeatAbsent` false, so the button stays visible and the server
  // precondition is the backstop.
  const blockedByMissingSeat = isEdit && memberSeatAbsent;

  // Either gate hides the provision button and leaves Reject only.
  const provisionBlocked = blockedByExistingSeat || blockedByMissingSeat;

  return (
    <div
      className="sba-request-card"
      data-urgent={isUrgent ? 'true' : 'false'}
      data-testid={`sba-request-${request.request_id}`}
    >
      <div className="sba-request-card-head">
        <span className={badgeClass(request.type)}>{typeBadgeLabel(request.type)}</span>
        <span className="sba-badge">{scopeLabel(request.scope, bundle.wards)}</span>
        {isUrgent ? <span className="sba-badge sba-badge-urgent">Urgent</span> : null}
        <span>
          {request.member_name ? (
            <>
              <strong>{request.member_name}</strong>{' '}
              <span className="sba-muted">({request.member_email})</span>
            </>
          ) : (
            <strong>{request.member_email}</strong>
          )}
        </span>
      </div>
      <div className="sba-request-meta">
        <span>
          <strong>Requester:</strong> {request.requester_email}
        </span>
        {submittedAt ? (
          <span>
            <strong>Submitted:</strong> {submittedAt}
          </span>
        ) : null}
      </div>
      {request.reason ? (
        <div className="sba-request-meta">
          <span>
            <strong>Reason:</strong> {request.reason}
          </span>
        </div>
      ) : null}
      {(request.type === 'add_temp' || request.type === 'edit_temp') &&
      (request.start_date || request.end_date) ? (
        <div className="sba-request-meta">
          <span>
            <strong>Dates:</strong> {request.start_date ?? '?'} → {request.end_date ?? '?'}
          </span>
        </div>
      ) : null}
      {request.building_names.length > 0 ? (
        <div className="sba-request-meta">
          <span>
            <strong>{isEdit ? '→ Buildings:' : 'Buildings:'}</strong>{' '}
            {request.building_names.join(', ')}
          </span>
        </div>
      ) : null}
      {request.comment ? (
        <div className="sba-request-meta">
          <span>
            <strong>Comment:</strong> {request.comment}
          </span>
        </div>
      ) : null}
      {blockedByExistingSeat ? (
        <p
          role="alert"
          className="sba-error"
          data-testid={`sba-existing-seat-${request.request_id}`}
        >
          Member already has a seat — reject this request.
        </p>
      ) : null}
      {blockedByMissingSeat ? (
        <p
          role="alert"
          className="sba-error"
          data-testid={`sba-missing-seat-${request.request_id}`}
        >
          This request edits a seat that no longer exists — reject it.
        </p>
      ) : null}
      <div className="sba-request-actions">
        {provisionBlocked ? null : (
          <button
            type="button"
            className={buttonClass}
            onClick={() => void provision()}
            disabled={isBusy}
            data-testid={buttonTestId}
          >
            {isBusy ? `${buttonLabel}…` : buttonLabel}
          </button>
        )}
        <button
          type="button"
          className="sba-btn sba-btn-danger"
          onClick={() => setRejectOpen(true)}
          disabled={isBusy}
          data-testid={`sba-reject-${request.request_id}`}
        >
          Reject
        </button>
      </div>
      {state.kind === 'error' ? (
        <p
          role="alert"
          className="sba-error"
          data-testid={`sba-provision-error-${request.request_id}`}
        >
          {state.message}
        </p>
      ) : null}

      {state.kind === 'result' ? <ResultDialog state={state.dialog} onDismiss={dismiss} /> : null}
      {rejectOpen ? (
        <RejectDialog
          stakeId={stakeId}
          request={request}
          wards={bundle.wards}
          onCancel={() => setRejectOpen(false)}
          onRejected={() => {
            setRejectOpen(false);
            onDismissed(request.request_id);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Run markRequestComplete with the captured Kindoo metadata. On
 * success, surface an `ok` dialog. On failure, surface a `partial`
 * dialog that re-tries only the SBA side on user request.
 */
async function sendMarkComplete(
  stakeId: string,
  requestId: string,
  provision: ProvisionResult,
  setDialog: (dialog: ResultDialogState) => void,
): Promise<void> {
  const note = provision.note;
  const payload: Parameters<typeof markRequestComplete>[0] = {
    stakeId,
    requestId,
    completionNote: note,
    provisioningNote: note,
  };
  if (provision.kindoo_uid) {
    payload.kindooUid = provision.kindoo_uid;
  }

  try {
    const result = await markRequestComplete(payload);
    setDialog({ kind: 'ok', note, over_caps: result.over_caps });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setDialog({
      kind: 'partial',
      note,
      errorMessage: message,
      onRetrySba: async () => {
        const result = await markRequestComplete(payload);
        setDialog({ kind: 'ok', note, over_caps: result.over_caps });
      },
    });
  }
}

function describeKindooError(err: unknown): string {
  if (err instanceof KindooApiError) {
    return `Kindoo API error (${err.code}): ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function describeProvisionError(err: unknown): string {
  if (err instanceof ProvisionBuildingsMissingRuleError) {
    return err.message;
  }
  if (err instanceof ProvisionEnvironmentNotFoundError) {
    return err.message;
  }
  if (err instanceof ProvisionEditUserMissingError) {
    return err.message;
  }
  if (err instanceof ProvisionStakeAutoEditError) {
    return err.message;
  }
  if (err instanceof ProvisionSiteMismatchError) {
    return err.message;
  }
  if (err instanceof ProvisionHomeSiteNotConfiguredError) {
    return err.message;
  }
  if (err instanceof ProvisionForeignSiteMissingError) {
    return err.message;
  }
  return describeKindooError(err);
}

function labelForType(t: AccessRequest['type']): string {
  switch (t) {
    case 'remove':
      return 'Remove Kindoo Access';
    case 'edit_auto':
    case 'edit_manual':
    case 'edit_temp':
      return 'Update Kindoo Access';
    case 'add_manual':
    case 'add_temp':
      return 'Add Kindoo Access';
  }
}

function typeBadgeLabel(t: AccessRequest['type']): string {
  switch (t) {
    case 'add_manual':
      return 'Add (manual)';
    case 'add_temp':
      return 'Add (temp)';
    case 'remove':
      return 'Remove';
    case 'edit_auto':
      return 'Edit (auto)';
    case 'edit_manual':
      return 'Edit (manual)';
    case 'edit_temp':
      return 'Edit (temp)';
  }
}

function badgeClass(t: AccessRequest['type']): string {
  switch (t) {
    case 'add_manual':
      return 'sba-badge sba-badge-manual';
    case 'add_temp':
      return 'sba-badge sba-badge-temp';
    case 'remove':
      return 'sba-badge sba-badge-remove';
    case 'edit_auto':
    case 'edit_manual':
    case 'edit_temp':
      return 'sba-badge sba-badge-edit';
  }
}

/**
 * `requested_at` is a Firestore `TimestampLike` that may be a real
 * `Timestamp` (has `toDate()`), a plain `Date`, or the serialised
 * `{ seconds, nanoseconds }` shape callable responses return. Render
 * defensively; an unparseable value renders as empty.
 */
function formatTimestamp(ts: AccessRequest['requested_at']): string {
  if (!ts) return '';
  if (ts instanceof Date) return ts.toISOString().slice(0, 16).replace('T', ' ');
  const t = ts as unknown as { toDate?: () => Date; seconds?: number; _seconds?: number };
  if (typeof t.toDate === 'function') {
    return t.toDate().toISOString().slice(0, 16).replace('T', ' ');
  }
  const seconds = typeof t.seconds === 'number' ? t.seconds : t._seconds;
  if (typeof seconds === 'number') {
    return new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
  }
  return '';
}
