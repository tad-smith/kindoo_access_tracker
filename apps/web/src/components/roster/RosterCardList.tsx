// Shared roster-card list primitive. Every read-only roster page
// (bishopric, stake, ward-rosters, manager all-seats) consumes this so
// row-feel visual density stays consistent across pages.
//
// Card shape:
//   Line 1:  badges · scope-chip (optional) · member · actions
//   Line 2:  Calling / Reason · Buildings  (when populated)
//   Line 3:  Dates: <start> → <end>          (temp seats only)
//   Lines collapse silently when the underlying data is empty.
//
// Per-row `actions`, `extraBadges`, and `rowClass` slots let callers
// compose page-specific affordances (e.g. an Edit button on All Seats;
// a "Pending Removal" badge + light-pink background on the bishopric
// roster when a remove request is in flight against the member).
//
// Contract:
//   - `seats`: readonly array of `Seat` from `@kindoo/shared`. Caller
//     filters / sorts before passing.
//   - `emptyMessage`: rendered via `<EmptyState>` when `seats.length === 0`.
//   - `showScope`: when true, render the scope chip on line 1 (used by
//     manager All Seats which spans every scope).
//   - `actions(seat)`: optional. Right-aligned action strip. Return
//     `null` to omit per-row.
//   - `extraBadges(seat)`: optional. Extra badges injected after the
//     type badge on line 1 (e.g. a "Pending Removal" badge when a
//     remove request is in flight against this member).
//   - `rowClass(seat)`: optional. Extra className appended to the
//     card's outer div (e.g. `has-removal-pending` for the inline
//     removal-pending styling).
//
// The component is presentation-only — no Firestore / network calls.
// Live updates happen at the page-component layer where
// `useFirestoreCollection` re-renders the parent.

import type { ReactNode } from 'react';
import type { Seat } from '@kindoo/shared';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../../lib/render/EmptyState';
import './RosterCardList.css';

export interface RosterCardListProps {
  seats: readonly Seat[];
  /** Empty-state message; defaults to a generic "no seats" string. */
  emptyMessage?: string;
  /** When true, render the scope chip on line 1 (manager All Seats). */
  showScope?: boolean;
  /** Right-aligned per-row action strip. Return `null` to omit. */
  actions?: (seat: Seat) => ReactNode;
  /** Extra badges after the type badge on line 1. */
  extraBadges?: (seat: Seat) => ReactNode;
  /** Extra className appended to each card's outer div (per row). */
  rowClass?: (seat: Seat) => string | undefined;
}

export function RosterCardList({
  seats,
  emptyMessage = 'No seats in this roster.',
  showScope = false,
  actions,
  extraBadges,
  rowClass,
}: RosterCardListProps) {
  if (seats.length === 0) {
    return <EmptyState message={emptyMessage} />;
  }
  return (
    <div className="roster-cards">
      {seats.map((seat) => (
        <RosterCard
          key={seat.member_canonical}
          seat={seat}
          showScope={showScope}
          {...(actions ? { actions } : {})}
          {...(extraBadges ? { extraBadges } : {})}
          {...(rowClass ? { rowClass } : {})}
        />
      ))}
    </div>
  );
}

interface RosterCardProps {
  seat: Seat;
  showScope: boolean;
  actions?: (seat: Seat) => ReactNode;
  extraBadges?: (seat: Seat) => ReactNode;
  rowClass?: (seat: Seat) => string | undefined;
}

function RosterCard({ seat, showScope, actions, extraBadges, rowClass }: RosterCardProps) {
  const typeVariant = seat.type;
  const typeLabel = seat.type;

  // Line 1 member block — name + (email) when name present, bare
  // email otherwise.
  const memberInner = seat.member_name ? (
    <>
      <span className="roster-card-name">{seat.member_name}</span>{' '}
      <span>
        (
        <span className="roster-email" title={seat.member_email}>
          {seat.member_email}
        </span>
        )
      </span>
    </>
  ) : (
    <span className="roster-email" title={seat.member_email}>
      {seat.member_email}
    </span>
  );

  // Line 2: calling (auto) / reason (manual/temp) chip + buildings chip.
  // Each chip renders only when the underlying field has data.
  const callingChip =
    seat.type === 'auto' && seat.callings.length > 0 ? (
      <span className="roster-card-chip">
        <span className="label">Calling:</span>
        <span className="roster-card-calling">{seat.callings.join(', ')}</span>
      </span>
    ) : (seat.type === 'manual' || seat.type === 'temp') && seat.reason ? (
      <span className="roster-card-chip">
        <span className="label">Reason:</span>
        <span className="roster-card-reason">{seat.reason}</span>
      </span>
    ) : null;

  const buildingsChip =
    seat.building_names.length > 0 ? (
      <span className="roster-card-chip">
        <span className="label">Buildings:</span>
        {seat.building_names.join(', ')}
      </span>
    ) : null;

  const datesLine =
    seat.type === 'temp' && (seat.start_date || seat.end_date) ? (
      <div className="roster-card-line2">
        <span className="roster-card-chip">
          <span className="label">Dates:</span>
          {seat.start_date ?? '?'} → {seat.end_date ?? '?'}
        </span>
      </div>
    ) : null;

  const detailLine =
    callingChip || buildingsChip ? (
      <div className="roster-card-line2">
        {callingChip}
        {buildingsChip}
      </div>
    ) : null;

  const actionNode = actions?.(seat) ?? null;
  const extraBadgeNodes = extraBadges?.(seat) ?? null;

  const extraRowClass = rowClass?.(seat);
  const className = `roster-card type-${seat.type}${extraRowClass ? ` ${extraRowClass}` : ''}`;

  return (
    <div className={className} data-seat-id={seat.member_canonical}>
      <div className="roster-card-line1">
        <span className="roster-card-badges">
          <Badge variant={typeVariant}>{typeLabel}</Badge>
          {extraBadgeNodes}
          {showScope ? (
            <span className="roster-card-chip roster-card-scope">
              <code>{seat.scope}</code>
            </span>
          ) : null}
        </span>
        <span className="roster-card-member">{memberInner}</span>
        {actionNode ? <span className="roster-card-actions">{actionNode}</span> : null}
      </div>
      {datesLine}
      {detailLine}
    </div>
  );
}
