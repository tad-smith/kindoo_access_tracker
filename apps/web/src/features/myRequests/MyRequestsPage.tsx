// MyRequests page (live). Shared across every role with at least one
// requestable scope, per `docs/spec.md` §5.1's "shared template
// `ui/MyRequests`" rule. Renders the signed-in user's submitted
// requests with a status-driven card background, a Cancel button on
// pending rows (the one Phase 5 write path), and a rejection-reason
// affordance on rejected rows.
//
// Scope filter: a multi-role principal who can submit against multiple
// scopes (bishopric + stake, or 2+ bishoprics) sees a "Scope:" dropdown
// with an "All" option. Single-scope principals see no filter.

import { useMemo, useState } from 'react';
import type { AccessRequest } from '@kindoo/shared';
import { usePrincipal } from '../../lib/principal';
import { STAKE_ID } from '../../lib/constants';
import { useMyRequests } from './hooks';
import { useCancelRequest } from './cancelRequest';
import { LoadingSpinner } from '../../lib/render/LoadingSpinner';
import { EmptyState } from '../../lib/render/EmptyState';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { Dialog } from '../../components/ui/Dialog';

interface ScopeOption {
  value: string;
  label: string;
}

function requestableScopes(principal: ReturnType<typeof usePrincipal>): ScopeOption[] {
  const scopes: ScopeOption[] = [];
  if (principal.stakeMemberStakes.includes(STAKE_ID)) {
    scopes.push({ value: 'stake', label: 'Stake' });
  }
  for (const ward of principal.bishopricWards[STAKE_ID] ?? []) {
    scopes.push({ value: ward, label: `Ward ${ward}` });
  }
  return scopes;
}

export function MyRequestsPage() {
  const principal = usePrincipal();
  const scopes = requestableScopes(principal);
  const [selectedScope, setSelectedScope] = useState<string>('');

  const requests = useMyRequests(principal.canonical || null);

  const filteredRequests = useMemo(() => {
    if (!requests.data) return [];
    if (!selectedScope) return requests.data;
    return requests.data.filter((r) => r.scope === selectedScope);
  }, [requests.data, selectedScope]);

  return (
    <section>
      <h1>My Requests</h1>
      {scopes.length > 1 ? (
        <div className="kd-ward-select-row">
          <label htmlFor="myreq-scope">Scope: </label>
          <Select
            id="myreq-scope"
            value={selectedScope}
            onChange={(e) => setSelectedScope(e.target.value)}
          >
            <option value="">All</option>
            {scopes.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </div>
      ) : scopes.length === 1 && scopes[0] ? (
        <p className="kd-page-subtitle">Scope: {scopes[0].label}</p>
      ) : null}

      {requests.isLoading || requests.data === undefined ? (
        <LoadingSpinner />
      ) : filteredRequests.length === 0 ? (
        <EmptyState message="No requests yet." />
      ) : (
        <div className="kd-myrequests-cards" data-testid="myrequests-cards">
          {filteredRequests.map((req) => (
            <MyRequestCard key={req.request_id} request={req} />
          ))}
        </div>
      )}
    </section>
  );
}

interface MyRequestCardProps {
  request: AccessRequest;
}

function MyRequestCard({ request }: MyRequestCardProps) {
  const cancel = useCancelRequest();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onConfirmCancel = async () => {
    setErrorMessage(null);
    try {
      await cancel.mutateAsync({ requestId: request.request_id });
      setConfirmOpen(false);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  // Urgent top-bar fires only on pending — once the request is closed
  // out the urgent treatment is informational noise; the status pill
  // already conveys the outcome.
  const showUrgentBar = request.urgent === true && request.status === 'pending';
  return (
    <div
      className={`kd-myrequests-card status-${request.status}${showUrgentBar ? ' kd-card-urgent' : ''}`}
      data-testid={`myrequest-${request.request_id}`}
      data-status={request.status}
      data-urgent={showUrgentBar ? 'true' : 'false'}
    >
      <div className="kd-myrequests-card-line1">
        <Badge variant={badgeVariantForType(request.type)}>{labelForType(request.type)}</Badge>
        <Badge variant={badgeVariantForStatus(request.status)}>{request.status}</Badge>
        <span className="roster-card-chip roster-card-scope">
          <code>{request.scope}</code>
        </span>
        <span className="roster-card-member">
          {request.member_name ? (
            <>
              <span className="roster-card-name">{request.member_name}</span>{' '}
              <span>
                (
                <span className="roster-email" title={request.member_email}>
                  {request.member_email}
                </span>
                )
              </span>
            </>
          ) : (
            <span className="roster-email">{request.member_email}</span>
          )}
        </span>
        {request.status === 'pending' ? (
          <span className="kd-myrequests-card-actions">
            <Button
              variant="danger"
              className="btn-pill"
              onClick={() => setConfirmOpen(true)}
              disabled={cancel.isPending}
              data-testid={`myrequest-cancel-${request.request_id}`}
            >
              Cancel
            </Button>
          </span>
        ) : null}
      </div>

      {request.type === 'add_temp' && (request.start_date || request.end_date) ? (
        <div className="kd-myrequests-card-meta">
          <span>
            <strong>Dates:</strong> {request.start_date ?? '?'} → {request.end_date ?? '?'}
          </span>
        </div>
      ) : null}
      {request.reason ? (
        <div className="kd-myrequests-card-meta">
          <span>
            <strong>Reason:</strong> {request.reason}
          </span>
        </div>
      ) : null}
      {request.comment ? (
        <div className="kd-myrequests-card-meta">
          <span>
            <strong>Comment:</strong> {request.comment}
          </span>
        </div>
      ) : null}

      {request.status === 'rejected' && request.rejection_reason ? (
        <div className="kd-myrequests-card-meta" data-testid="rejection-reason">
          <span>
            <strong>Rejection reason:</strong> {request.rejection_reason}
          </span>
        </div>
      ) : null}
      {request.status === 'complete' && request.completion_note ? (
        <div className="kd-myrequests-card-meta">
          <span>
            <strong>Note:</strong> {request.completion_note}
          </span>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="error" data-testid="cancel-error">
          {errorMessage}
        </div>
      ) : null}

      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Cancel this request?"
        description="The request will be withdrawn. You can submit a new one any time."
      >
        <Dialog.Footer>
          <Dialog.CancelButton>Keep it</Dialog.CancelButton>
          <Dialog.ConfirmButton
            className="btn-danger"
            onClick={onConfirmCancel}
            disabled={cancel.isPending}
          >
            {cancel.isPending ? 'Cancelling…' : 'Cancel request'}
          </Dialog.ConfirmButton>
        </Dialog.Footer>
      </Dialog>
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

function badgeVariantForType(t: AccessRequest['type']) {
  if (t === 'add_temp') return 'temp' as const;
  if (t === 'remove') return 'danger' as const;
  return 'manual' as const;
}

function badgeVariantForStatus(s: AccessRequest['status']) {
  switch (s) {
    case 'pending':
      return 'info' as const;
    case 'complete':
      return 'success' as const;
    case 'rejected':
      return 'danger' as const;
    case 'cancelled':
      return 'default' as const;
  }
}
