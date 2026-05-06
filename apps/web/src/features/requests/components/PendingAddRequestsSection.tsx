// Roster-page "Outstanding Requests" section. Renders one card per
// pending `add_manual` / `add_temp` request matching the displayed
// scope. Sits below the committed roster so users see in-flight adds
// without leaving the page.
//
// Section styling matches the manager Queue page (`kd-queue-section`
// + `kd-queue-section-header` from `styles/pages.css`) so the visual
// language is consistent across the two surfaces that surface
// pending requests.
//
// Card styling matches the roster's `RosterCardList` — we synthesize
// a Seat-shaped projection from each request (mapping `add_manual`
// → `manual`, `add_temp` → `temp`) and feed it through the same
// component so any roster-card change propagates here automatically.
// The card carries a "Pending" badge via the `extraBadges` slot.
//
// Section is silent (returns `null`) when there are no pending adds
// for the scope.

import type { AccessRequest, Seat, ActorRef, TimestampLike } from '@kindoo/shared';
import { Badge } from '../../../components/ui/Badge';
import { RosterCardList } from '../../../components/roster/RosterCardList';

export interface PendingAddRequestsSectionProps {
  pendingAdds: readonly AccessRequest[];
  /** When true, render the scope chip on line 1 (cross-scope pages). */
  showScope?: boolean;
}

export function PendingAddRequestsSection({
  pendingAdds,
  showScope = false,
}: PendingAddRequestsSectionProps) {
  if (pendingAdds.length === 0) return null;

  const seats = pendingAdds.map(requestToSeatProjection);

  // Constrain to the same 820px the `<RosterCardList>` itself uses
  // (`.roster-cards { max-width: 820px }` in `RosterCardList.css`) so
  // the divider-flanked section header lines up with the cards below
  // it instead of bleeding to the page width.
  //
  // `mt-12` (48px) puts roughly one section-header-height of breathing
  // room between the committed roster and this section so the
  // divider-flanked header reads as a clean break rather than a
  // continuation of the list above.
  return (
    <div className="kd-queue-section max-w-[820px] mt-12" data-testid="roster-pending-adds-section">
      <h2 className="kd-queue-section-header">Outstanding Requests</h2>
      <RosterCardList
        seats={seats}
        showScope={showScope}
        extraBadges={() => (
          <Badge variant="warning" data-testid="pending-add-badge">
            Pending
          </Badge>
        )}
      />
    </div>
  );
}

// Project a pending add request onto the Seat shape RosterCardList
// expects. Only the fields the card renderer reads are populated;
// everything else is filled with empty / sentinel values that render
// as the empty path (line 2 chips collapse silently when their
// underlying field is empty).
function requestToSeatProjection(req: AccessRequest): Seat {
  const seatType: Seat['type'] = req.type === 'add_temp' ? 'temp' : 'manual';
  const lastActor: ActorRef = req.lastActor;
  // The card renderer reads `created_at` / `last_modified_at` only via
  // type-narrowing; supplying the request's `requested_at` keeps the
  // shape valid without inventing new timestamps.
  const ts: TimestampLike = req.requested_at;
  const projection: Seat = {
    member_canonical: req.member_canonical,
    member_email: req.member_email,
    member_name: req.member_name,
    scope: req.scope,
    type: seatType,
    callings: [],
    building_names: req.building_names,
    duplicate_grants: [],
    granted_by_request: req.request_id,
    created_at: ts,
    last_modified_at: ts,
    last_modified_by: lastActor,
    lastActor,
  };
  if (req.reason) projection.reason = req.reason;
  if (seatType === 'temp') {
    if (req.start_date) projection.start_date = req.start_date;
    if (req.end_date) projection.end_date = req.end_date;
  }
  return projection;
}
