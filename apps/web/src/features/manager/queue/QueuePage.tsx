// Manager Requests Queue page (live, read-only). Pending-only; rendered
// as three ordered sections (Urgent / Outstanding / Future) using the
// `comparison_date` rule in `@kindoo/shared`'s `partitionPendingRequests`.
//
// The queue is a visibility-only surface: completion and rejection
// happen in the Chrome extension, not here. A muted top-of-queue note
// links to the extension. The cards are display-only — no action
// affordances.
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
import { type AccessRequest, partitionPendingRequests } from '@kindoo/shared';
import { usePendingRequests } from './hooks';
import { useSeatForMember } from '../../requests/hooks';
import { Badge } from '../../../components/ui/Badge';
import { CHROME_WEB_STORE_URL } from '../../../lib/links';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import { EmptyState } from '../../../lib/render/EmptyState';

const FOCUS_HIGHLIGHT_MS = 2000;

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

  const total = pending.data.length;

  return (
    <section className="kd-page-medium">
      <h1>Request Queue</h1>
      <p className="kd-page-subtitle">Pending requests, sectioned by urgency.</p>
      <ReadOnlyNote />

      {total === 0 ? (
        <EmptyState message="No pending requests. Nice." />
      ) : (
        <div data-testid="queue-cards">
          <QueueSection
            title="Urgent Requests"
            testid="queue-section-urgent"
            requests={sections.urgent}
            focusedId={focusedId}
          />
          <QueueSection
            title="Outstanding Requests"
            testid="queue-section-outstanding"
            requests={sections.outstanding}
            focusedId={focusedId}
          />
          <QueueSection
            title="Future Requests"
            testid="queue-section-future"
            requests={sections.future}
            focusedId={focusedId}
          />
        </div>
      )}
    </section>
  );
}

// Muted note pointing managers to the Chrome extension for the
// actionable (complete / reject) workflow, which no longer lives here.
function ReadOnlyNote() {
  return (
    <p className="kd-queue-readonly-note" data-testid="queue-readonly-note" role="note">
      Requests can only be completed or rejected from the Chrome extension.{' '}
      <a
        href={CHROME_WEB_STORE_URL}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="queue-readonly-note-link"
      >
        Open the extension
      </a>
    </p>
  );
}

interface QueueSectionProps {
  title: string;
  testid: string;
  requests: readonly AccessRequest[];
  focusedId: string | undefined;
}

function QueueSection({ title, testid, requests, focusedId }: QueueSectionProps) {
  // Hide the entire section (header + body) when empty — the operator
  // brief is unambiguous on this.
  if (requests.length === 0) return null;
  return (
    <div className="kd-queue-section" data-testid={testid}>
      <h2 className="kd-queue-section-header">
        {title} ({requests.length})
      </h2>
      <div className="kd-queue-cards">
        {requests.map((request) => (
          <QueueCard
            key={request.request_id}
            request={request}
            isFocused={focusedId === request.request_id}
          />
        ))}
      </div>
    </div>
  );
}

interface QueueCardProps {
  request: AccessRequest;
  isFocused: boolean;
}

function QueueCard({ request, isFocused }: QueueCardProps) {
  // Live duplicate check: surface inside the queue card so the manager
  // sees, at a glance, that an add request collides with an existing
  // seat. The completion path now lives in the extension; the chip is
  // kept exactly as-is as an informational signal (operator decision:
  // "same message, same error display, no changes").
  //
  // For an add request, completion creates a brand-new one-per-member
  // seat doc keyed by canonical email, so ANY existing seat (regardless
  // of scope) guarantees the create throws. Edit / remove completions
  // expect an existing seat, so the chip renders ONLY for add types.
  const dup = useSeatForMember(request.member_canonical);
  const blockedByDuplicate =
    (request.type === 'add_manual' || request.type === 'add_temp') && !!dup.data;

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
      <div className="kd-queue-card-line1 kd-queue-card-meta-row">
        <span className="kd-queue-card-badges">
          <Badge variant={badgeVariantForType(request.type)}>{labelForType(request.type)}</Badge>
          <span className="roster-card-chip roster-card-scope">
            <code>{request.scope}</code>
          </span>
        </span>
        {reqDate ? (
          <span className="kd-queue-card-meta kd-queue-card-submitted">
            <strong>Submitted:</strong> {reqDate}
          </span>
        ) : null}
      </div>
      <div className="kd-queue-card-meta">
        <span>
          <strong>{request.type === 'remove' ? 'Remove Access For:' : 'Give Access To:'}</strong>{' '}
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
            <span className="roster-email" title={request.member_email}>
              {request.member_email}
            </span>
          )}
        </span>
      </div>
      {request.reason ? (
        <div className="kd-queue-card-meta">
          <span>
            <strong>{request.type === 'remove' ? 'Removal reason:' : 'Calling:'}</strong>{' '}
            {request.reason}
          </span>
        </div>
      ) : null}
      {(request.type === 'add_temp' || request.type === 'edit_temp') &&
      (request.start_date || request.end_date) ? (
        <div className="kd-queue-card-meta">
          <span>
            <strong>Dates:</strong> {request.start_date ?? '?'} → {request.end_date ?? '?'}
          </span>
        </div>
      ) : null}
      {request.building_names.length > 0 ? (
        <div className="kd-queue-card-meta" data-testid={`queue-buildings-${request.request_id}`}>
          <span>
            <strong>
              {request.type === 'edit_auto' ||
              request.type === 'edit_manual' ||
              request.type === 'edit_temp'
                ? '→ Buildings:'
                : 'Buildings:'}
            </strong>{' '}
            {request.building_names.join(', ')}
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
      <div className="kd-queue-card-meta">
        <span>
          {/* TODO: requester_name is not stored on the request; show
              "Name (email)" once it's captured at submit time (would
              need a userIndex display_name lookup or a denormed field
              on AccessRequest). For now we fall back to email-only. */}
          <strong>Requester:</strong> {request.requester_email}
        </span>
      </div>
      {blockedByDuplicate && dup.data ? (
        <div
          className="kd-queue-card-error"
          role="alert"
          data-testid={`queue-duplicate-error-${request.request_id}`}
        >
          <Badge variant="danger">Error</Badge> Member already has a {dup.data.type} seat in{' '}
          {dup.data.scope}. This request can&apos;t be completed — reject it, or reconcile via All
          Seats.
        </div>
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
    case 'edit_auto':
      return 'Edit (auto)';
    case 'edit_manual':
      return 'Edit (manual)';
    case 'edit_temp':
      return 'Edit (temp)';
  }
}

// Badge palette per request type. Edit types share the `info` variant
// so they read as a distinct "Edit" family at a glance against the
// add/remove badges; the type label (Edit (auto) / (manual) / (temp))
// still disambiguates within that family.
function badgeVariantForType(t: AccessRequest['type']) {
  switch (t) {
    case 'add_manual':
      return 'manual' as const;
    case 'add_temp':
      return 'temp' as const;
    case 'remove':
      return 'danger' as const;
    case 'edit_auto':
    case 'edit_manual':
    case 'edit_temp':
      return 'info' as const;
  }
}
