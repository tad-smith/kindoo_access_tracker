// Bishopric Roster page (live).
//
//   - Single-ward bishopric: roster scoped to that ward, no picker.
//   - Multi-ward bishopric: a "Ward:" select appears above the
//     utilization bar; the picker controls which ward's seats render.
//   - Manual / temp rows carry a per-row Remove button via
//     `<RemovalAffordance>`; auto rows are LCR-managed and have none.
//
// Phase B (T-43): broadened inclusion — a seat appears on a ward's
// roster if its primary scope matches OR any `duplicate_grants[]`
// entry's scope matches (spec §15). Single row per person; the
// row's columns reflect the matching grant via `pickGrantForScope`.
// The `useBishopricRoster` hook implements the two-query union (KS-10
// Option b) over the denormalised `duplicate_scopes` mirror.
//
// Search params (typed via the route's zod schema):
//   ?ward=<wardCode>   — pre-select a ward when the principal is in
//                        multiple bishoprics. Ignored when the
//                        principal isn't in that ward.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { Seat } from '@kindoo/shared';
import { usePrincipal } from '../../lib/principal';
import { STAKE_ID } from '../../lib/constants';
import { useFirestoreOnce } from '../../lib/data';
import { wardRef } from '../../lib/docs';
import { db } from '../../lib/firebase';
import { useBishopricRoster, useKindooSites, useStakeWards } from './hooks';
import { sortSeatsWithinScope } from '../../lib/sort/seats';
import { RosterUtilization } from '../../lib/render/RosterUtilization';
import { LoadingSpinner } from '../../lib/render/LoadingSpinner';
import { EmptyState } from '../../lib/render/EmptyState';
import { Select } from '../../components/ui/Select';
import { PerGrantRosterCard } from '../../components/roster/PerGrantRosterCard';
import { PendingAddRequestsSection } from '../requests/components/PendingAddRequestsSection';
import { usePendingRequestsForScope } from '../requests/hooks';
import { partitionPendingForRoster, pendingRemoveKey } from '../requests/rosterPending';
import { canEditSeat, isScopeAllowed } from '../requests/scopeOptions';
import { pickGrantForScope, type GrantView } from '../../lib/grants';

export interface BishopricRosterPageProps {
  /** Pre-selected ward code from `?ward=...`. */
  initialWard?: string;
}

export function BishopricRosterPage({ initialWard }: BishopricRosterPageProps) {
  const principal = usePrincipal();
  const wards = principal.bishopricWards[STAKE_ID] ?? [];
  const navigate = useNavigate();

  const seedWard = initialWard && wards.includes(initialWard) ? initialWard : (wards[0] ?? null);
  const [activeWard, setActiveWard] = useState<string | null>(seedWard);

  // Re-sync if the principal's ward list changes (e.g. claim refresh).
  useEffect(() => {
    if (!activeWard && wards.length > 0) setActiveWard(wards[0] ?? null);
    if (activeWard && !wards.includes(activeWard)) setActiveWard(wards[0] ?? null);
  }, [wards, activeWard]);

  const seats = useBishopricRoster(activeWard);
  const wardDocResult = useFirestoreOnce(activeWard ? wardRef(db, STAKE_ID, activeWard) : null);
  const wardDoc = wardDocResult.data;

  // Wards + Kindoo Sites — feed the foreign-site badge on ward seats
  // (spec §15). Both subscriptions are stake-wide live reads.
  const wardsCatalogue = useStakeWards();
  const kindooSites = useKindooSites();

  // Phase B broadened inclusion: pair every seat with its matched
  // grant. The row's columns reflect the matching grant (auto /
  // manual / temp band, calling list, building names, foreign-site
  // badge).
  const seatsWithGrant = useMemo(() => {
    const rows: Array<{ seat: Seat; grant: GrantView }> = [];
    if (!activeWard) return rows;
    for (const s of seats.data ?? []) {
      const grant = pickGrantForScope(s, activeWard);
      if (grant) rows.push({ seat: s, grant });
    }
    return rows;
  }, [seats.data, activeWard]);

  // Sort by the matched grant's fields. Synthesise a `Seat` shim by
  // overlaying the grant's columns so `sortSeatsWithinScope` keys off
  // the matched-grant band rather than the primary's.
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

  // Pending requests for the active ward — drives the "Outstanding
  // Requests" section + the per-row "Pending Removal" badge.
  const pendingRequests = usePendingRequestsForScope(activeWard);
  const { pendingAdds, pendingRemovesByKey } = useMemo(
    () => partitionPendingForRoster(pendingRequests.data ?? [], activeWard ?? ''),
    [pendingRequests.data, activeWard],
  );

  const handleWardChange = (next: string) => {
    setActiveWard(next);
    navigate({
      to: '/bishopric/roster',
      search: { ward: next },
      replace: true,
    }).catch(() => {});
  };

  if (wards.length === 0) {
    return (
      <section>
        <h1>Roster</h1>
        <p>You have no bishopric wards assigned in this stake.</p>
      </section>
    );
  }

  const seatCount = sortedRows.length;

  return (
    <section>
      <h1>Roster</h1>
      <p className="kd-page-subtitle">
        {wardDoc
          ? `${wardDoc.ward_name} (${activeWard ?? ''})`
          : activeWard
            ? activeWard
            : 'Select a ward'}
      </p>

      {wards.length > 1 ? (
        <div className="kd-ward-select-row">
          <label htmlFor="bishopric-ward-select">Ward: </label>
          <Select
            id="bishopric-ward-select"
            value={activeWard ?? ''}
            onChange={(e) => handleWardChange(e.target.value)}
          >
            {wards.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      <div className="kd-utilization-host">
        <RosterUtilization
          committedTotal={seatCount}
          cap={wardDoc?.seat_cap ?? null}
          pendingAdds={pendingAdds.length}
          pendingRemoves={pendingRemovesByKey.size}
          committedOverCap={wardDoc?.seat_cap !== undefined && seatCount > wardDoc.seat_cap}
        />
      </div>

      {seats.isLoading || seats.data === undefined ? (
        <LoadingSpinner />
      ) : (
        <>
          {sortedRows.length === 0 ? (
            <EmptyState message="No seats assigned to this ward yet. A Kindoo Manager imports from LCR weekly; manual additions land via the New Kindoo Request page." />
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
                    wards={wardsCatalogue.data ?? []}
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
