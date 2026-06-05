// Reject-request modal. Mirrors the web SPA's RejectDialog UX inside
// the Shadow-DOM panel: title "Reject request?", a brief description
// (member + type + scope), one required "Rejection reason" text input,
// and Cancel + Reject(danger) buttons.
//
// Confirm is disabled while the reason is empty (the web app uses a zod
// min-length check; the same intent here is an inline-disabled button
// plus an SW-side trim+non-empty guard that backstops it). On success
// the dialog calls `onRejected` so the parent card drops + refetches.
// Failures surface inline (role="alert", `sba-error`) like the
// provision path.
//
// Vanilla DOM modal in the same backdrop style as ResultDialog.

import { useState } from 'react';
import type { AccessRequest } from '@kindoo/shared';
import { ExtensionApiError, rejectRequest } from '../lib/extensionApi';

interface RejectDialogProps {
  stakeId: string;
  request: AccessRequest;
  /** Close without rejecting. */
  onCancel: () => void;
  /** Reject succeeded — parent drops the card + refetches. */
  onRejected: () => void;
}

export function RejectDialog({ stakeId, request, onCancel, onRejected }: RejectDialogProps) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = reason.trim();
  const canSubmit = trimmed.length > 0 && !submitting;

  async function handleReject() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await rejectRequest(stakeId, request.request_id, trimmed);
      onRejected();
    } catch (err) {
      const message =
        err instanceof ExtensionApiError || err instanceof Error ? err.message : String(err);
      setError(message);
      setSubmitting(false);
    }
  }

  const subject = request.member_name
    ? `${request.member_name} (${request.member_email})`
    : request.member_email;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sba-reject-dialog-title"
      className="sba-dialog-backdrop"
      data-testid={`sba-reject-dialog-${request.request_id}`}
    >
      <div className="sba-dialog">
        <h2 id="sba-reject-dialog-title">Reject request?</h2>
        <p data-testid="sba-reject-summary">
          Reject {subject}&apos;s {labelForType(request.type)} in {request.scope}.
        </p>
        <label>
          Rejection reason
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Required — what should the requester know?"
            className="sba-input"
            data-testid={`sba-reject-reason-${request.request_id}`}
          />
        </label>
        {error ? (
          <p
            role="alert"
            className="sba-error"
            data-testid={`sba-reject-error-${request.request_id}`}
          >
            {error}
          </p>
        ) : null}
        <div className="sba-dialog-actions">
          <button
            type="button"
            className="sba-btn"
            onClick={onCancel}
            disabled={submitting}
            data-testid={`sba-reject-cancel-${request.request_id}`}
          >
            Cancel
          </button>
          <button
            type="button"
            className="sba-btn sba-btn-danger"
            onClick={() => void handleReject()}
            disabled={!canSubmit}
            data-testid={`sba-reject-confirm-${request.request_id}`}
          >
            {submitting ? 'Rejecting…' : 'Reject'}
          </button>
        </div>
      </div>
    </div>
  );
}

function labelForType(t: AccessRequest['type']): string {
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
