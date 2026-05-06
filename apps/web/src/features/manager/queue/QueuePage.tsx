// Manager Requests Queue page (live). Mirrors `src/ui/manager/RequestsQueue.html`.
// Pending-only; rendered as three ordered sections (Urgent / Outstanding
// / Future) using the `comparison_date` rule in `./sections.ts`. Per-row
// Mark Complete + Reject actions.
//
// `focus` prop carries a request_id from a tapped push notification's
// deep-link (typed search param at the route level). On first render
// where it matches a request in the rendered list, the page scrolls
// the card into view, applies the `is-focused` class for ~2s, and
// strips the param from the URL so reload + back-forward stay clean.
// A `focus` value with no matching request (request was completed/
// cancelled before the user tapped) is silently dropped.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { AccessRequest, Building } from '@kindoo/shared';
import {
  useCompleteAddRequest,
  useCompleteRemoveRequest,
  usePendingRequests,
  useRejectRequest,
} from './hooks';
import { partitionPendingRequests } from './sections';
import { useBuildings } from '../allSeats/hooks';
import { useSeatForMember } from '../../requests/hooks';
import {
  completeAddRequestSchema,
  rejectRequestSchema,
  type CompleteAddRequestForm,
  type RejectRequestForm,
} from '../../requests/schemas';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { Input } from '../../../components/ui/Input';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import { EmptyState } from '../../../lib/render/EmptyState';
import { toast } from '../../../lib/store/toast';

const FOCUS_HIGHLIGHT_MS = 2000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ManagerQueuePageProps {
  /**
   * Request id that arrived via the `?focus=<rid>` deep-link. When set
   * AND a matching request is in the rendered list, the card scrolls
   * into view + flashes the `is-focused` highlight, then the param is
   * stripped from the URL.
   */
  focus?: string;
}

export function ManagerQueuePage({ focus }: ManagerQueuePageProps = {}) {
  const pending = usePendingRequests();
  const buildings = useBuildings();
  const navigate = useNavigate();

  // Compute "now" once per render. Time advancement during a session
  // shifts the Outstanding/Future boundary by at most a tick — well
  // below the day-level resolution the section cutoff cares about.
  const sections = useMemo(
    () => partitionPendingRequests(pending.data ?? [], new Date()),
    [pending.data],
  );

  // Currently-highlighted card id. Driven by the `focus` effect below;
  // applied as the `is-focused` class to the matching card so the CSS
  // animation runs. Cleared after FOCUS_HIGHLIGHT_MS.
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);

  // First-render-with-this-focus effect. Re-fires when `focus` changes
  // (consecutive notifications targeting different request ids). When
  // the matching card is in the rendered list:
  //   1. Scroll into view (smooth, centred). The DOM lookup happens in
  //      a microtask via `queueMicrotask` so React has committed the
  //      cards before we read.
  //   2. Set focusedId so the matching card picks up `is-focused`.
  //   3. Schedule a timeout to clear focusedId so the highlight fades.
  //   4. Strip `?focus=` from the URL via `replace` navigation so
  //      reload + back-forward do not re-trigger.
  // A focus value with no matching request silently does nothing —
  // the request was likely completed/cancelled before the user tapped.
  useEffect(() => {
    if (!focus) return;
    if (!pending.data) return;
    const exists = pending.data.some((r) => r.request_id === focus);
    if (!exists) {
      // Still strip the param so a stale deep-link does not linger.
      navigate({
        to: '/manager/queue',
        search: (prev: Record<string, unknown>) => ({ ...prev, focus: undefined }),
        replace: true,
      }).catch(() => {});
      return;
    }
    setFocusedId(focus);
    queueMicrotask(() => {
      const el = document.querySelector(`[data-testid="queue-card-${focus}"]`);
      if (el && 'scrollIntoView' in el) {
        (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
    const timer = window.setTimeout(() => {
      setFocusedId((current) => (current === focus ? undefined : current));
    }, FOCUS_HIGHLIGHT_MS);
    navigate({
      to: '/manager/queue',
      search: (prev: Record<string, unknown>) => ({ ...prev, focus: undefined }),
      replace: true,
    }).catch(() => {});
    return () => {
      window.clearTimeout(timer);
    };
  }, [focus, pending.data, navigate]);

  if (pending.isLoading || pending.data === undefined) {
    return (
      <section className="kd-page-medium">
        <h1>Request Queue</h1>
        <LoadingSpinner />
      </section>
    );
  }

  const buildingsList = buildings.data ?? [];
  const total = pending.data.length;

  return (
    <section className="kd-page-medium">
      <h1>Request Queue</h1>
      <p className="kd-page-subtitle">Pending requests, sectioned by urgency.</p>

      {total === 0 ? (
        <EmptyState message="No pending requests. Nice." />
      ) : (
        <div data-testid="queue-cards">
          <QueueSection
            title="Urgent Requests"
            testid="queue-section-urgent"
            requests={sections.urgent}
            buildings={buildingsList}
            focusedId={focusedId}
          />
          <QueueSection
            title="Outstanding Requests"
            testid="queue-section-outstanding"
            requests={sections.outstanding}
            buildings={buildingsList}
            focusedId={focusedId}
          />
          <QueueSection
            title="Future Requests"
            testid="queue-section-future"
            requests={sections.future}
            buildings={buildingsList}
            focusedId={focusedId}
          />
        </div>
      )}
    </section>
  );
}

interface QueueSectionProps {
  title: string;
  testid: string;
  requests: readonly AccessRequest[];
  buildings: readonly Building[];
  focusedId: string | undefined;
}

function QueueSection({ title, testid, requests, buildings, focusedId }: QueueSectionProps) {
  // Hide the entire section (header + body) when empty — the operator
  // brief is unambiguous on this.
  if (requests.length === 0) return null;
  return (
    <div className="kd-queue-section" data-testid={testid}>
      <h2 className="kd-queue-section-header">{title}</h2>
      <div className="kd-queue-cards">
        {requests.map((request) => (
          <QueueCard
            key={request.request_id}
            request={request}
            buildings={buildings}
            isFocused={focusedId === request.request_id}
          />
        ))}
      </div>
    </div>
  );
}

interface QueueCardProps {
  request: AccessRequest;
  buildings: readonly Building[];
  isFocused: boolean;
}

function QueueCard({ request, buildings, isFocused }: QueueCardProps) {
  const [completeOpen, setCompleteOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);

  // Live duplicate-warning: surface inside the queue card too, not just
  // the requester's New Request page. Helps the manager see at a glance
  // whether a complete will collide.
  const dup = useSeatForMember(request.member_canonical);

  const reqDate = (() => {
    const ts = request.requested_at as unknown as { toDate?: () => Date };
    if (ts && ts.toDate) return ts.toDate().toISOString().slice(0, 16).replace('T', ' ');
    return '';
  })();

  const isUrgent = request.urgent === true;
  const className = [
    'kd-queue-card',
    isUrgent ? 'kd-card-urgent' : '',
    isFocused ? 'is-focused' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={className}
      data-testid={`queue-card-${request.request_id}`}
      data-request-type={request.type}
      data-urgent={isUrgent ? 'true' : 'false'}
    >
      <div className="kd-queue-card-line1">
        <Badge
          variant={
            request.type === 'add_temp' ? 'temp' : request.type === 'remove' ? 'danger' : 'manual'
          }
        >
          {labelForType(request.type)}
        </Badge>
        <span className="roster-card-chip roster-card-scope">
          <code>{request.scope}</code>
        </span>
        <span className="roster-card-member">
          {request.member_name ? (
            <>
              <strong>{request.member_name}</strong>{' '}
              <span className="roster-email">({request.member_email})</span>
            </>
          ) : (
            <span className="roster-email">{request.member_email}</span>
          )}
        </span>
      </div>
      <div className="kd-queue-card-meta kd-queue-card-meta-row">
        <span>
          <strong>Requester:</strong> {request.requester_email}
        </span>
        {reqDate ? (
          <span className="kd-queue-card-submitted">
            <strong>Submitted:</strong> {reqDate}
          </span>
        ) : null}
      </div>
      {request.reason ? (
        <div className="kd-queue-card-meta">
          <span>
            <strong>Reason:</strong> {request.reason}
          </span>
        </div>
      ) : null}
      {request.type === 'add_temp' && (request.start_date || request.end_date) ? (
        <div className="kd-queue-card-meta">
          <span>
            <strong>Dates:</strong> {request.start_date ?? '?'} → {request.end_date ?? '?'}
          </span>
        </div>
      ) : null}
      {request.building_names.length > 0 ? (
        <div className="kd-queue-card-meta" data-testid={`queue-buildings-${request.request_id}`}>
          <span>
            <strong>Buildings:</strong> {request.building_names.join(', ')}
          </span>
        </div>
      ) : null}
      {request.comment ? (
        <div className="kd-queue-card-meta">
          <span>
            <strong>Comment:</strong> {request.comment}
          </span>
        </div>
      ) : null}
      {request.type !== 'remove' && dup.data ? (
        <div
          className="kd-queue-card-warning"
          data-testid={`queue-duplicate-${request.request_id}`}
        >
          <Badge variant="warning">Duplicate</Badge> Member already has a {dup.data.type} seat in{' '}
          {dup.data.scope}.
        </div>
      ) : null}

      <div className="form-actions">
        <Button
          variant="success"
          onClick={() => setCompleteOpen(true)}
          data-testid={`queue-complete-${request.request_id}`}
        >
          Mark Complete
        </Button>
        <Button
          variant="danger"
          onClick={() => setRejectOpen(true)}
          data-testid={`queue-reject-${request.request_id}`}
        >
          Reject
        </Button>
      </div>

      {completeOpen ? (
        request.type === 'remove' ? (
          <CompleteRemoveDialog
            request={request}
            open={completeOpen}
            onOpenChange={setCompleteOpen}
          />
        ) : (
          <CompleteAddDialog
            request={request}
            buildings={buildings}
            open={completeOpen}
            onOpenChange={setCompleteOpen}
          />
        )
      ) : null}
      {rejectOpen ? (
        <RejectDialog request={request} open={rejectOpen} onOpenChange={setRejectOpen} />
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

// ---- Complete (add_manual / add_temp) dialog -----------------------

interface CompleteAddDialogProps {
  request: AccessRequest;
  buildings: readonly Building[];
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

function CompleteAddDialog({ request, buildings, open, onOpenChange }: CompleteAddDialogProps) {
  const mutation = useCompleteAddRequest();
  // Pre-tick: the requester's selection wins when present; otherwise
  // empty (manager picks). Phase 7's roster-driven ward-default
  // pre-tick is out of scope here — Phase 6's confirmation dialog
  // simply respects what the requester sent.
  const initial = request.building_names ?? [];
  const form = useForm<CompleteAddRequestForm>({
    resolver: zodResolver(completeAddRequestSchema),
    defaultValues: { building_names: initial },
  });
  const { handleSubmit, watch, setValue, formState } = form;
  const selected = watch('building_names');

  const onSubmit = handleSubmit(async (input) => {
    try {
      await mutation.mutateAsync({ request, building_names: input.building_names });
      toast('Request completed.', 'success');
      onOpenChange(false);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Mark complete?"
      description={`Approve and create a ${request.type === 'add_temp' ? 'temporary' : 'manual'} seat for ${request.member_email}.`}
    >
      <form onSubmit={onSubmit} className="kd-wizard-form" data-testid="complete-add-dialog-form">
        <fieldset className="kd-buildings-fieldset">
          <legend>
            Buildings <small>(at least one required)</small>
          </legend>
          {buildings.length === 0 ? (
            <p className="kd-empty-state">No buildings configured. Add one via Configuration.</p>
          ) : (
            <ul className="kd-checkbox-list">
              {buildings.map((b) => {
                const checked = selected.includes(b.building_name);
                return (
                  <li key={b.building_id}>
                    <label>
                      <input
                        type="checkbox"
                        value={b.building_name}
                        checked={checked}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...selected, b.building_name]
                            : selected.filter((n) => n !== b.building_name);
                          setValue('building_names', next, { shouldValidate: true });
                        }}
                        data-testid={`complete-building-${b.building_id}`}
                      />{' '}
                      {b.building_name}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {formState.errors.building_names ? (
            <p role="alert" className="kd-form-error">
              {formState.errors.building_names.message}
            </p>
          ) : null}
        </fieldset>

        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Dialog.ConfirmButton
            type="submit"
            className="btn-success"
            disabled={mutation.isPending || selected.length === 0}
            data-testid="complete-add-confirm"
          >
            {mutation.isPending ? 'Completing…' : 'Confirm'}
          </Dialog.ConfirmButton>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}

// ---- Complete (remove) dialog --------------------------------------

interface CompleteRemoveDialogProps {
  request: AccessRequest;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

function CompleteRemoveDialog({ request, open, onOpenChange }: CompleteRemoveDialogProps) {
  const mutation = useCompleteRemoveRequest();
  const onConfirm = async () => {
    try {
      await mutation.mutateAsync({ request });
      toast('Request completed.', 'success');
      onOpenChange(false);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Mark removal complete?"
      description={`Removes ${request.member_email}'s seat in ${request.scope}. If the seat has already been removed, the request will still be marked complete.`}
    >
      <Dialog.Footer>
        <Dialog.CancelButton>Cancel</Dialog.CancelButton>
        <Dialog.ConfirmButton
          className="btn-success"
          onClick={onConfirm}
          disabled={mutation.isPending}
          data-testid="complete-remove-confirm"
        >
          {mutation.isPending ? 'Completing…' : 'Confirm'}
        </Dialog.ConfirmButton>
      </Dialog.Footer>
    </Dialog>
  );
}

// ---- Reject dialog --------------------------------------------------

interface RejectDialogProps {
  request: AccessRequest;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

function RejectDialog({ request, open, onOpenChange }: RejectDialogProps) {
  const mutation = useRejectRequest();
  const form = useForm<RejectRequestForm>({
    resolver: zodResolver(rejectRequestSchema),
    defaultValues: { rejection_reason: '' },
  });
  const { register, handleSubmit, formState } = form;

  const onSubmit = handleSubmit(async (input) => {
    try {
      await mutation.mutateAsync({ request, rejection_reason: input.rejection_reason });
      toast('Request rejected.', 'success');
      onOpenChange(false);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Reject request?"
      description={`Reject ${request.member_email}'s ${labelForType(request.type)} in ${request.scope}.`}
    >
      <form onSubmit={onSubmit} className="kd-wizard-form" data-testid="reject-dialog-form">
        <label>
          Rejection reason
          <Input
            {...register('rejection_reason')}
            data-testid="reject-reason"
            placeholder="Required — what should the requester know?"
          />
        </label>
        {formState.errors.rejection_reason ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.rejection_reason.message}
          </p>
        ) : null}
        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Dialog.ConfirmButton
            type="submit"
            className="btn-danger"
            disabled={mutation.isPending}
            data-testid="reject-confirm"
          >
            {mutation.isPending ? 'Rejecting…' : 'Reject'}
          </Dialog.ConfirmButton>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}
