// Stake Presidency Roster page (live). Scope is hard-locked to
// `'stake'`; rules keep bishoprics out via the per-doc rule:
//   `(resource.data.scope == 'stake' && isStakeMember(stakeId))`.

import { useMemo } from 'react';
import { useFirestoreDoc } from '../../lib/data';
import { stakeRef } from '../../lib/docs';
import { db } from '../../lib/firebase';
import { STAKE_ID } from '../../lib/constants';
import { usePrincipal } from '../../lib/principal';
import { useStakeRoster, useStakeWards } from './hooks';
import { RosterCardList } from '../../components/roster/RosterCardList';
import { sortSeatsWithinScope } from '../../lib/sort/seats';
import { RosterUtilization } from '../../lib/render/RosterUtilization';
import { stakeAvailablePoolSize } from '../../lib/render/stakePool';
import { LoadingSpinner } from '../../lib/render/LoadingSpinner';
import { RemovalAffordance } from '../requests/components/RemovalAffordance';
import { EditSeatAffordance } from '../requests/components/EditSeatAffordance';
import { PendingAddRequestsSection } from '../requests/components/PendingAddRequestsSection';
import { usePendingRequestsForScope } from '../requests/hooks';
import { partitionPendingForRoster } from '../requests/rosterPending';
import { canEditSeat, isScopeAllowed } from '../requests/scopeOptions';
import { Badge } from '../../components/ui/Badge';

export function StakeRosterPage() {
  const principal = usePrincipal();
  const seats = useStakeRoster();
  const wards = useStakeWards();
  // Live subscription — `useFirestoreOnce` was reliably empty in
  // production for this page (TanStack cache miss + no listener to
  // populate it), so the cap fell through to the "(cap unset)" path.
  const stakeDocResult = useFirestoreDoc(stakeRef(db, STAKE_ID));
  const stakeDoc = stakeDocResult.data;

  const sortedSeats = useMemo(() => sortSeatsWithinScope(seats.data ?? []), [seats.data]);
  const seatCount = seats.data?.length ?? 0;

  // Pending requests for the stake scope — drives the "Outstanding
  // Requests" section + the per-row "Pending Removal" badge.
  const pendingRequests = usePendingRequestsForScope('stake');
  const { pendingAdds, pendingRemovesByCanonical } = useMemo(
    () => partitionPendingForRoster(pendingRequests.data ?? [], 'stake'),
    [pendingRequests.data],
  );
  // Stake-presidency pool size: stake_seat_cap minus what wards have
  // pre-allocated. The headroom the presidency actually owns. Same
  // denominator the Dashboard + AllSeats Stake-scope bars use.
  const cap = stakeAvailablePoolSize(stakeDoc?.stake_seat_cap, wards.data ?? []);

  return (
    <section>
      <h1>Stake Roster</h1>
      <p className="kd-page-subtitle">Stake</p>

      <div className="kd-utilization-host">
        <RosterUtilization
          committedTotal={seatCount}
          cap={cap}
          pendingAdds={pendingAdds.length}
          pendingRemoves={pendingRemovesByCanonical.size}
          committedOverCap={typeof cap === 'number' && cap > 0 && seatCount > cap}
        />
      </div>

      {seats.isLoading || seats.data === undefined ? (
        <LoadingSpinner />
      ) : (
        <>
          <RosterCardList
            seats={sortedSeats}
            emptyMessage="No stake seats yet. The next import seeds auto-seats from the LCR Stake tab; manual additions land via the New Kindoo Request page."
            actions={(seat) => {
              const canEdit = canEditSeat(principal, STAKE_ID, seat);
              const canRemove =
                seat.type !== 'auto' && isScopeAllowed(principal, STAKE_ID, seat.scope);
              if (!canEdit && !canRemove) return null;
              return (
                <span style={{ display: 'inline-flex', gap: 8 }}>
                  {canEdit ? <EditSeatAffordance seat={seat} /> : null}
                  {canRemove ? <RemovalAffordance seat={seat} /> : null}
                </span>
              );
            }}
            extraBadges={(seat) =>
              pendingRemovesByCanonical.has(seat.member_canonical) ? (
                <Badge
                  variant="danger"
                  data-testid={`pending-removal-badge-${seat.member_canonical}`}
                >
                  Pending Removal
                </Badge>
              ) : null
            }
            rowClass={(seat) =>
              pendingRemovesByCanonical.has(seat.member_canonical)
                ? 'has-removal-pending'
                : undefined
            }
          />
          <PendingAddRequestsSection pendingAdds={pendingAdds} />
        </>
      )}
    </section>
  );
}
