// Per-row "remove" affordance + "removal pending" badge for roster
// pages. Three independent pieces of state collapse into one render:
//
//   1. Auto seats get NO button. Auto seats are LCR-managed; the
//      next importer run would just re-add the row, so submitting a
//      remove request against an auto seat would create drift between
//      the SPA and the LCR sheet. The roster page already filters
//      this on the `seat.type !== 'auto'` predicate, but we
//      double-check here so the affordance cannot accidentally render
//      for auto rows even if a caller forgets the outer gate.
//
//   2. If a pending remove request exists for this row's grant
//      (`type='remove' AND member_canonical == seat.id AND scope ==
//      grant.scope AND kindoo_site_id == grant.kindoo_site_id`),
//      render a "Removal pending" badge in place of the button.
//
//   3. Otherwise render a Remove button that opens the shared
//      RemovalDialog.
//
// Live by design: the pending-remove query is a Firestore subscription,
// so the badge appears immediately after a successful remove submit
// (no manual refresh).
//
// Phase B (T-43): the `grant` prop is required so every render path
// scopes to a specific grant. Pre-Phase-B callers passed only the
// seat; that path no longer exists — Bishopric / Stake / AllSeats all
// build the grant before mounting the affordance.

import { useState } from 'react';
import type { Seat } from '@kindoo/shared';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { usePendingRemoveRequests } from '../hooks';
import { RemovalDialog, type RemovalDialogGrant } from './RemovalDialog';

export interface RemovalAffordanceProps {
  seat: Seat;
  /** The grant being removed (scope + kindoo_site_id). */
  grant: RemovalDialogGrant;
  /**
   * Override for the data-testid suffix. Defaults to
   * `seat.member_canonical`. AllSeats multi-row passes a per-row
   * suffix (e.g. `${member}-dup-0`) so the per-grant Remove button
   * is addressable.
   */
  testIdSuffix?: string;
}

export function RemovalAffordance({ seat, grant, testIdSuffix }: RemovalAffordanceProps) {
  const [open, setOpen] = useState(false);
  // Subscribe per row. At target scale (~12 wards, ~250 seats) the
  // subscription overhead is negligible; the Firestore SDK shares the
  // websocket and dedupes per query.
  const pending = usePendingRemoveRequests(seat.member_canonical, grant.scope);
  // Narrow the pending-match by kindoo_site_id (AC #13) so a
  // home-site pending remove doesn't dim the foreign-site row's
  // button. Legacy pending removes carry no `kindoo_site_id`; treat
  // absent as `null` (home) so legacy home-pending shadows only the
  // home row.
  const isPending = (pending.data ?? []).some(
    (r) => (r.kindoo_site_id ?? null) === grant.kindoo_site_id,
  );

  if (seat.type === 'auto') return null;

  const suffix = testIdSuffix ?? seat.member_canonical;

  if (isPending) {
    return (
      <Badge variant="warning" data-testid={`removal-pending-${suffix}`}>
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
        data-testid={`remove-btn-${suffix}`}
      >
        Remove
      </Button>
      {open ? (
        <RemovalDialog
          seat={seat}
          grant={grant}
          onOpenChange={(next) => {
            if (!next) setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
