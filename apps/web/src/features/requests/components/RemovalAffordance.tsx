// Per-row "remove" affordance + "removal pending" badge for roster
// pages. Three independent pieces of state collapse into one render:
//
//   1. Auto seats get NO X (auto seats are LCR-managed; removed via
//      the importer flow). The roster page already filters this on the
//      `seat.type !== 'auto'` predicate, but we double-check here so
//      the affordance can't accidentally render for auto rows.
//
//   2. If a pending remove request exists for this seat (any pending
//      request with `type='remove' AND member_canonical == seat.id`),
//      render a "Removal pending" badge in place of the X.
//
//   3. Otherwise render an X button that opens the shared RemovalDialog.
//
// Live by design: the pending-remove query is a Firestore subscription,
// so the badge appears immediately after a successful remove submit
// (no manual refresh).

import { useState } from 'react';
import type { Seat } from '@kindoo/shared';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { usePendingRemoveRequests } from '../hooks';
import { RemovalDialog } from './RemovalDialog';

export interface RemovalAffordanceProps {
  seat: Seat;
}

export function RemovalAffordance({ seat }: RemovalAffordanceProps) {
  const [open, setOpen] = useState(false);
  // Subscribe per row. At target scale (~12 wards, ~250 seats) the
  // subscription overhead is negligible; the Firestore SDK shares the
  // websocket and dedupes per query. If we ever need to hoist to a
  // single roster-level subscription, the lift is trivial.
  const pending = usePendingRemoveRequests(seat.member_canonical);
  const isPending = (pending.data ?? []).some((r) => r.scope === seat.scope);

  if (seat.type === 'auto') return null;

  if (isPending) {
    return (
      <Badge variant="warning" data-testid={`removal-pending-${seat.member_canonical}`}>
        Removal pending
      </Badge>
    );
  }

  return (
    <>
      <Button
        variant="danger"
        onClick={() => setOpen(true)}
        aria-label={`Remove access for ${seat.member_email}`}
        data-testid={`remove-btn-${seat.member_canonical}`}
      >
        Remove
      </Button>
      {open ? (
        <RemovalDialog
          seat={seat}
          onOpenChange={(next) => {
            if (!next) setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
