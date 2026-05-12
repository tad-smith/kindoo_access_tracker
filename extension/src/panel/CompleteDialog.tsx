// Confirmation dialog for Mark Complete. Optional textarea for a
// completion note that gets passed back through to the callable.
// Vanilla DOM (no Radix) to keep the extension's dep surface minimal.

import { useState } from 'react';
import type { AccessRequest } from '@kindoo/shared';

interface CompleteDialogProps {
  request: AccessRequest;
  onClose: () => void;
  onConfirm: (completionNote: string | undefined) => Promise<void> | void;
}

export function CompleteDialog({ request, onClose, onConfirm }: CompleteDialogProps) {
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setPending(true);
    setError(null);
    try {
      const trimmed = note.trim();
      await onConfirm(trimmed.length > 0 ? trimmed : undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setPending(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sba-complete-dialog-title"
      className="sba-dialog-backdrop"
      data-testid="sba-complete-dialog"
    >
      <div className="sba-dialog">
        <h2 id="sba-complete-dialog-title">Mark complete?</h2>
        <p className="sba-muted">{summarize(request)}</p>
        <label>
          Completion note (optional)
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What did you do? (Optional context for the requester.)"
            rows={3}
            data-testid="sba-complete-note"
          />
        </label>
        {error ? (
          <p role="alert" className="sba-error">
            {error}
          </p>
        ) : null}
        <div className="sba-dialog-actions">
          <button
            type="button"
            className="sba-btn"
            onClick={onClose}
            disabled={pending}
            data-testid="sba-complete-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="sba-btn sba-btn-success"
            onClick={handleConfirm}
            disabled={pending}
            data-testid="sba-complete-confirm"
          >
            {pending ? 'Completing…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

function summarize(r: AccessRequest): string {
  switch (r.type) {
    case 'add_manual':
      return `Approve a manual seat for ${r.member_email} in ${r.scope}.`;
    case 'add_temp':
      return `Approve a temporary seat for ${r.member_email} in ${r.scope}.`;
    case 'remove':
      return `Confirm removal of ${r.member_email}'s seat in ${r.scope}.`;
  }
}
