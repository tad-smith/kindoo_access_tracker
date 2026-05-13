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
import type { AccessRequest } from '@kindoo/shared';
import { getSeatByEmail, markRequestComplete, type StakeConfigBundle } from '../lib/extensionApi';
import { STAKE_ID } from '../lib/constants';
import { readKindooSession, type KindooSession } from '../content/kindoo/auth';
import { KindooApiError } from '../content/kindoo/client';
import { getEnvironments, type KindooEnvironment } from '../content/kindoo/endpoints';
import {
  provisionAddOrChange,
  provisionRemove,
  ProvisionBuildingsMissingRuleError,
  ProvisionEnvironmentNotFoundError,
  type ProvisionResult,
} from '../content/kindoo/provision';
import { ResultDialog, type ResultDialogState } from './ResultDialog';

interface RequestCardProps {
  request: AccessRequest;
  bundle: StakeConfigBundle;
  /** Called after the operator dismisses the result dialog; parent
   * drops the card from the queue list. */
  onDismissed: (requestId: string) => void;
}

type CardState =
  | { kind: 'idle' }
  | { kind: 'provisioning' }
  | { kind: 'error'; message: string }
  | { kind: 'result'; dialog: ResultDialogState };

export function RequestCard({ request, bundle, onDismissed }: RequestCardProps) {
  const [state, setState] = useState<CardState>({ kind: 'idle' });

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
            : 'Kindoo session not ready. Refresh web.kindoo.tech and retry.',
      });
      return;
    }
    const session: KindooSession = sessionResult.session;

    // 2. Run the orchestrator. Remove is a whole-user revoke and only
    //    needs `request` + `session` (B-10: partial remove deferred).
    //    Add types also need the SBA seat (read-first merged-state)
    //    + envs (for TimeZone).
    let result: ProvisionResult;
    try {
      if (request.type === 'remove') {
        result = await provisionRemove({
          request,
          session,
        });
      } else {
        // `seat` may be null — first-time-add has no prior seat.
        let seat: Awaited<ReturnType<typeof getSeatByEmail>>;
        try {
          seat = await getSeatByEmail(request.member_canonical);
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
    await sendMarkComplete(request.request_id, result, (dialog) =>
      setState({ kind: 'result', dialog }),
    );
  }, [request, bundle]);

  const dismiss = useCallback(() => {
    onDismissed(request.request_id);
  }, [onDismissed, request.request_id]);

  const buttonLabel = labelForType(request.type);
  const isBusy = state.kind === 'provisioning';
  const buttonTestId =
    request.type === 'remove'
      ? `sba-remove-${request.request_id}`
      : `sba-add-${request.request_id}`;

  return (
    <div
      className="sba-request-card"
      data-urgent={isUrgent ? 'true' : 'false'}
      data-testid={`sba-request-${request.request_id}`}
    >
      <div className="sba-request-card-head">
        <span className={badgeClass(request.type)}>{typeBadgeLabel(request.type)}</span>
        <span className="sba-badge">{request.scope}</span>
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
      {request.type === 'add_temp' && (request.start_date || request.end_date) ? (
        <div className="sba-request-meta">
          <span>
            <strong>Dates:</strong> {request.start_date ?? '?'} → {request.end_date ?? '?'}
          </span>
        </div>
      ) : null}
      {request.building_names.length > 0 ? (
        <div className="sba-request-meta">
          <span>
            <strong>Buildings:</strong> {request.building_names.join(', ')}
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
      <div className="sba-request-actions">
        <button
          type="button"
          className={
            request.type === 'remove' ? 'sba-btn sba-btn-danger' : 'sba-btn sba-btn-success'
          }
          onClick={() => void provision()}
          disabled={isBusy}
          data-testid={buttonTestId}
        >
          {isBusy ? `${buttonLabel}…` : buttonLabel}
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
    </div>
  );
}

/**
 * Run markRequestComplete with the captured Kindoo metadata. On
 * success, surface an `ok` dialog. On failure, surface a `partial`
 * dialog that re-tries only the SBA side on user request.
 */
async function sendMarkComplete(
  requestId: string,
  provision: ProvisionResult,
  setDialog: (dialog: ResultDialogState) => void,
): Promise<void> {
  const note = provision.note;
  const payload: Parameters<typeof markRequestComplete>[0] = {
    stakeId: STAKE_ID,
    requestId,
    completionNote: note,
    provisioningNote: note,
  };
  if (provision.kindoo_uid) {
    payload.kindooUid = provision.kindoo_uid;
  }

  try {
    await markRequestComplete(payload);
    setDialog({ kind: 'ok', note });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setDialog({
      kind: 'partial',
      note,
      errorMessage: message,
      onRetrySba: async () => {
        await markRequestComplete(payload);
        setDialog({ kind: 'ok', note });
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
  return describeKindooError(err);
}

function labelForType(t: AccessRequest['type']): string {
  return t === 'remove' ? 'Remove Kindoo Access' : 'Add Kindoo Access';
}

function typeBadgeLabel(t: AccessRequest['type']): string {
  switch (t) {
    case 'add_manual':
      return 'Add (manual)';
    case 'add_temp':
      return 'Add (temp)';
    case 'remove':
      return 'Remove';
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
