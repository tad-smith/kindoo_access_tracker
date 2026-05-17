// Stake Presidency Roster page (live). Scope is `'stake'` — broadened
// in Phase B (spec §15) to include any seat whose primary scope OR any
// `duplicate_grants[]` entry's scope matches `'stake'`. Single row per
// person; columns reflect the matched grant.
//
// Rules: `seats.read` allows stake-presidency reads unrestricted via
// `isStakeMember(stakeId)` (no scope predicate), so no rule change
// is needed for this surface — the broadened reads were already
// allowed by today's rules. The bishopric clause widening (Phase B
// AC #10) handles the bishopric surface.

import { useMemo } from 'react';
import type { Seat } from '@kindoo/shared';
import { useFirestoreDoc } from '../../lib/data';
import { stakeRef } from '../../lib/docs';
import { db } from '../../lib/firebase';
import { STAKE_ID } from '../../lib/constants';
import { usePrincipal } from '../../lib/principal';
import { useKindooSites, useStakeRoster, useStakeWards } from './hooks';
import { sortSeatsWithinScope } from '../../lib/sort/seats';
import { RosterUtilization } from '../../lib/render/RosterUtilization';
import { stakeAvailablePoolSize } from '../../lib/render/stakePool';
import { LoadingSpinner } from '../../lib/render/LoadingSpinner';
import { EmptyState } from '../../lib/render/EmptyState';
import { PerGrantRosterCard } from '../../components/roster/PerGrantRosterCard';
import { PendingAddRequestsSection } from '../requests/components/PendingAddRequestsSection';
import { usePendingRequestsForScope } from '../requests/hooks';
import { partitionPendingForRoster, pendingRemoveKey } from '../requests/rosterPending';
import { canEditSeat, isScopeAllowed } from '../requests/scopeOptions';
import { pickGrantForScope, type GrantView } from '../../lib/grants';

export function StakeRosterPage() {
  const principal = usePrincipal();
  const seats = useStakeRoster();
  const wards = useStakeWards();
  // Live subscription for the stake doc — `useFirestoreOnce` was
  // empty in production for this page; live keeps the cap fresh.
  const stakeDocResult = useFirestoreDoc(stakeRef(db, STAKE_ID));
  const stakeDoc = stakeDocResult.data;
  const kindooSites = useKindooSites();

  // Pair every seat with the grant that matched the stake scope.
  const seatsWithGrant = useMemo(() => {
    const rows: Array<{ seat: Seat; grant: GrantView }> = [];
    for (const s of seats.data ?? []) {
      const grant = pickGrantForScope(s, 'stake');
      if (grant) rows.push({ seat: s, grant });
    }
    return rows;
  }, [seats.data]);

  // Sort by the matched grant's fields. Auto-band intra-sort still
  // keys on the seat's top-level `sort_order` — `DuplicateGrant` has
  // no `sort_order` field, so a duplicate-matched auto row sorts at
  // the primary's calling rank. See spec §15 Phase B (roster-pages
  // subsection) for the operator-accepted limitation.
  const sortedRows = useMemo(() => {
    const shims = seatsWithGrant.map(({ seat, grant }) => ({
      ...seat,
      type: grant.type,
      ...(grant.start_date !== undefined ? { start_date: grant.start_date } : {}),
      ...(grant.end_date !== undefined ? { end_date: grant.end_date } : {}),
    }));
    const sorted = sortSeatsWithinScope(shims);
    const byCanonical = new Map(seatsWithGrant.map((r) => [r.seat.member_canonical, r]));
    return sorted
      .map((s) => byCanonical.get(s.member_canonical))
      .filter((r): r is { seat: Seat; grant: GrantView } => r !== undefined);
  }, [seatsWithGrant]);

  const seatCount = sortedRows.length;

  // Pending requests for the stake scope.
  const pendingRequests = usePendingRequestsForScope('stake');
  const { pendingAdds, pendingRemovesByKey } = useMemo(
    () => partitionPendingForRoster(pendingRequests.data ?? [], 'stake'),
    [pendingRequests.data],
  );
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
          pendingRemoves={pendingRemovesByKey.size}
          committedOverCap={typeof cap === 'number' && cap > 0 && seatCount > cap}
        />
      </div>

      {seats.isLoading || seats.data === undefined ? (
        <LoadingSpinner />
      ) : (
        <>
          {sortedRows.length === 0 ? (
            <EmptyState message="No stake seats yet. The next import seeds auto-seats from the LCR Stake tab; manual additions land via the New Kindoo Request page." />
          ) : (
            <div className="roster-cards">
              {sortedRows.map(({ seat, grant }) => {
                const canEdit = grant.isPrimary && canEditSeat(principal, STAKE_ID, seat);
                const canRemove =
                  grant.type !== 'auto' && isScopeAllowed(principal, STAKE_ID, grant.scope);
                const isPendingRemoval = pendingRemovesByKey.has(
                  pendingRemoveKey(seat.member_canonical, grant.scope, grant.kindoo_site_id),
                );
                return (
                  <PerGrantRosterCard
                    key={seat.member_canonical}
                    seat={seat}
                    grant={grant}
                    canEdit={canEdit}
                    canRemove={canRemove}
                    isPendingRemoval={isPendingRemoval}
                    wards={wards.data ?? []}
                    sites={kindooSites.data ?? []}
                  />
                );
              })}
            </div>
          )}
          <PendingAddRequestsSection pendingAdds={pendingAdds} />
        </>
      )}
    </section>
  );
}
