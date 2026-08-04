// One pending-request card.
//
// v1 surfaced a "Mark Complete" button that just round-tripped the SBA
// callable — the manager did all the Kindoo work manually. v2.2 closes
// the loop: the same button runs the full Kindoo provision flow first
// (add / change / remove) and only then marks the SBA request complete.
//
// The orchestration itself lives in `content/kindoo/applyRequest` —
// shared with the phone-initiated remote runner so the two surfaces
// can't drift apart on what happened or how it is worded.
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

import { useCallback, useEffect, useState } from 'react';
import {
  deriveRequesterDisplay,
  formatRequesterLabel,
  scopeLabel,
  type Access,
  type AccessRequest,
  type KindooManager,
} from '@kindoo/shared';
import {
  getAccessByEmail,
  getKindooManagerByEmail,
  markRequestComplete,
  type StakeConfigBundle,
} from '../lib/extensionApi';
import { applyRequest } from '../content/kindoo/applyRequest';
import { ResultDialog, type ResultDialogState } from './ResultDialog';
import { RejectDialog } from './RejectDialog';

/**
 * Who has a phone-initiated job for this request: this tab, which is
 * executing it now (`'this-tab'`), or anything else — the mailbox, with
 * the job still waiting to be claimed, or another of the manager's
 * Kindoo tabs already running it (`'elsewhere'`).
 *
 * The split is by which surface can report on it, not by job status:
 * only this tab knows it is mid-`applyRequest`, and it is the only one
 * that can say so.
 */
export type RemoteApplyPhase = 'elsewhere' | 'this-tab';

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
  /**
   * How far a phone-initiated remote-apply job has got with THIS
   * request, or undefined when there is none.
   *
   * Either phase disables the button. It is the desktop's entry into the
   * same `applyRequest` flow the remote runner is in (or is about to
   * be), so letting both run means two concurrent seat reads, two
   * `provisionAddOrChange` calls and — for a member who isn't in Kindoo
   * yet — two `inviteUser` writes, the second of which consumes a
   * licence. `markRequestComplete` settling on one winner is no help:
   * the Kindoo writes already happened.
   *
   * `'elsewhere'` gets its own copy because "this tab is applying it
   * now" is not a claim this tab can make about a job that is still
   * waiting in the mailbox, or one a sibling tab on another Kindoo site
   * has already claimed. Both read as "your desktop is handling it".
   *
   * Parent (`QueuePanel`) derives this; absent (standalone renders, no
   * loop) ⇒ not busy.
   */
  remoteApplyBusy?: RemoteApplyPhase | undefined;
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
  remoteApplyBusy,
  onDismissed,
}: RequestCardProps) {
  const [state, setState] = useState<CardState>({ kind: 'idle' });
  const [rejectOpen, setRejectOpen] = useState(false);

  // Live-derive the requester's name + calling from their `access` doc
  // for this request's scope (Option A — nothing is captured on the
  // request; mirrors the web Queue). Kindoo Managers may submit in ANY
  // scope without holding an `access` row, so their `kindooManagers`
  // doc backstops both fields — `{Name} (Kindoo Manager)`. The access
  // doc wins on each field independently.
  //
  // Both are one-shot SW-side reads resolved TOGETHER: committing them
  // in a single `setState` keeps the label from painting once with the
  // access-only value and again once the manager doc lands. While the
  // reads are in flight, absent, or failed, the value stays null, so
  // `formatRequesterLabel` degrades to the raw email — no branching and
  // no empty flash. Each read degrades independently (per-promise
  // `catch`), so a miss on one never discards the other's contribution.
  const [requester, setRequester] = useState<{
    access: Access | null;
    manager: KindooManager | null;
  }>({ access: null, manager: null });
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getAccessByEmail(stakeId, request.requester_canonical).catch(() => null),
      getKindooManagerByEmail(stakeId, request.requester_canonical).catch(() => null),
    ]).then(([access, manager]) => {
      if (!cancelled) setRequester({ access, manager });
    });
    return () => {
      cancelled = true;
    };
  }, [stakeId, request.requester_canonical]);
  const requesterLabel = formatRequesterLabel(
    deriveRequesterDisplay(requester.access, request.scope, requester.manager),
    request.requester_email,
  );

  const isUrgent = request.urgent === true;
  const submittedAt = formatTimestamp(request.requested_at);

  // The orchestration itself lives in `content/kindoo/applyRequest` so
  // the phone-initiated remote runner executes byte-identical steps and
  // reports byte-identical wording. This callback only renders the
  // outcome.
  const provision = useCallback(async () => {
    setState({ kind: 'provisioning' });
    const outcome = await applyRequest({ stakeId, request, bundle });
    if (outcome.status === 'failed') {
      setState({ kind: 'error', message: outcome.message });
      return;
    }
    if (outcome.status === 'applied') {
      setState({
        kind: 'result',
        dialog: { kind: 'ok', note: outcome.note, over_caps: outcome.overCaps },
      });
      return;
    }
    // Kindoo landed, SBA didn't. Retry re-runs ONLY the SBA half using
    // the captured payload — no second Kindoo write.
    setState({
      kind: 'result',
      dialog: {
        kind: 'partial',
        note: outcome.note,
        errorMessage: outcome.message,
        onRetrySba: async () => {
          const completed = await markRequestComplete(outcome.markCompleteInput);
          setState({
            kind: 'result',
            dialog: { kind: 'ok', note: outcome.note, over_caps: completed.over_caps },
          });
        },
      },
    });
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
  // Carve-out: ANY `add_manual` + `scope:'stake'` request for a member who
  // has a seat but NO stake-scope grant IS applyable —
  // `markRequestComplete` → `planAddMerge` appends a cross-scope stake
  // grant onto the existing seat rather than colliding with it, so it
  // succeeds whether the member is foreign-site-only or a home-ward member
  // (the home-ward case simply gains the stake buildings on their existing
  // home Kindoo user). The web "Give Access To Stake Buildings" button is
  // the primary entry point, but other request-creation paths can produce
  // the same shape and are equally safe to apply. `!memberHasStakeGrant`
  // is the backstop: if a stake grant already exists the add would be a
  // true stake duplicate, so keep blocking. Every other add-on-existing
  // case stays blocked exactly as before.
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
        {isUrgent ? <span className="sba-badge sba-badge-urgent">Emergency</span> : null}
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
          <strong>Requester:</strong> {requesterLabel}
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
      {remoteApplyBusy ? (
        <p
          role="status"
          className="sba-muted"
          data-testid={`sba-remote-busy-${request.request_id}`}
        >
          {remoteApplyBusy === 'this-tab'
            ? 'You sent this one from your phone — this tab is applying it now. Wait for it to ' +
              'finish rather than applying it twice.'
            : 'You sent this one from your phone — your desktop is handling it. Wait for it to ' +
              'finish rather than applying it twice.'}
        </p>
      ) : null}
      <div className="sba-request-actions">
        {provisionBlocked ? null : (
          <button
            type="button"
            className={buttonClass}
            onClick={() => void provision()}
            disabled={isBusy || remoteApplyBusy !== undefined}
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
