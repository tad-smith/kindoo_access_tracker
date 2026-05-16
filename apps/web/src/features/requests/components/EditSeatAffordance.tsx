// Per-row "Edit" affordance for roster pages (bishopric Roster, stake
// Roster, stake Ward Rosters, manager All Seats). Two layers of gating:
//
//   1. **Policy 1 — stake-scope auto seats are non-editable.** The
//      affordance renders nothing for those rows (Church-granted access
//      to every stake building; no editable surface).
//
//   2. **Role-for-scope.** Mirrors `RemovalAffordance`: same
//      `canEditSeat` predicate (which composes the Policy 1 check with
//      `isScopeAllowed`). A bishopric of CO sees the button on CO rows;
//      a stake user sees it on stake rows; a manager-only user without
//      a stake / ward claim sees nothing (B-3 / T-36).
//
// Caller-side note: pages already filter the row list to scopes the
// viewer can see, but the affordance ALSO checks `canEditSeat` so a
// stale doc that slipped past the page-level filter can't surface a
// button the rules would reject.
//
// Clicking Edit opens the shared `EditSeatDialog`, which handles all
// three edit sub-types via the seat being edited.

import { useState } from 'react';
import type { Seat } from '@kindoo/shared';
import { Button } from '../../../components/ui/Button';
import { usePrincipal } from '../../../lib/principal';
import { STAKE_ID } from '../../../lib/constants';
import { canEditSeat } from '../scopeOptions';
import { EditSeatDialog } from './EditSeatDialog';

export interface EditSeatAffordanceProps {
  seat: Seat;
}

export function EditSeatAffordance({ seat }: EditSeatAffordanceProps) {
  const principal = usePrincipal();
  const [open, setOpen] = useState(false);

  if (!canEditSeat(principal, STAKE_ID, seat)) return null;

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => setOpen(true)}
        aria-label={`Edit access for ${seat.member_email}`}
        data-testid={`edit-btn-${seat.member_canonical}`}
      >
        Edit
      </Button>
      {open ? (
        <EditSeatDialog
          seat={seat}
          onOpenChange={(next) => {
            if (!next) setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
