// One pending-request card. Compact layout: header line with type
// badge + scope + member, then meta rows (requester / reason / dates /
// buildings / comment), then the Mark Complete affordance. Opens the
// completion-note dialog on click.

import { useState } from 'react';
import type { AccessRequest } from '@kindoo/shared';
import { CompleteDialog } from './CompleteDialog';

interface RequestCardProps {
  request: AccessRequest;
  onComplete: (requestId: string, completionNote: string | undefined) => Promise<void> | void;
}

export function RequestCard({ request, onComplete }: RequestCardProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const submittedAt = formatTimestamp(request.requested_at);
  const isUrgent = request.urgent === true;

  return (
    <div
      className="sba-request-card"
      data-urgent={isUrgent ? 'true' : 'false'}
      data-testid={`sba-request-${request.request_id}`}
    >
      <div className="sba-request-card-head">
        <span className={badgeClass(request.type)}>{labelForType(request.type)}</span>
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
          className="sba-btn sba-btn-success"
          onClick={() => setDialogOpen(true)}
          data-testid={`sba-complete-${request.request_id}`}
        >
          Mark Complete
        </button>
      </div>

      {dialogOpen ? (
        <CompleteDialog
          request={request}
          onClose={() => setDialogOpen(false)}
          onConfirm={async (note) => {
            await onComplete(request.request_id, note);
            setDialogOpen(false);
          }}
        />
      ) : null}
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
