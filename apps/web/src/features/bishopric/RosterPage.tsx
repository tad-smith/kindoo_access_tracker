// Bishopric Roster page (live). Mirrors the Apps Script
// `src/ui/bishopric/Roster.html` behaviour:
//
//   - Single-ward bishopric: roster scoped to that ward, no picker.
//   - Multi-ward bishopric: a "Ward:" select appears above the
//     utilization bar; the picker controls which ward's seats render.
//   - Manual / temp rows carry a per-row Remove button via
//     `<RemovalAffordance>`; auto rows are LCR-managed and have none.
//
// Live updates via `useFirestoreCollection(scope == ward)` — the
// roster patches in place when a manager completes a request that
// adds a seat in this ward, or when the importer lands a new auto
// seat.
//
// Search params (typed via the route's zod schema):
//   ?ward=<wardCode>   — pre-select a ward when the principal is in
//                        multiple bishoprics. Ignored when the
//                        principal isn't in that ward.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { usePrincipal } from '../../lib/principal';
import { STAKE_ID } from '../../lib/constants';
import { useFirestoreOnce } from '../../lib/data';
import { wardRef } from '../../lib/docs';
import { db } from '../../lib/firebase';
import { useBishopricRoster } from './hooks';
import { RosterCardList } from '../../components/roster/RosterCardList';
import { sortSeatsWithinScope } from '../../lib/sort/seats';
import { UtilizationBar } from '../../lib/render/UtilizationBar';
import { LoadingSpinner } from '../../lib/render/LoadingSpinner';
import { Select } from '../../components/ui/Select';
import { RemovalAffordance } from '../requests/components/RemovalAffordance';
import { PendingAddRequestsSection } from '../requests/components/PendingAddRequestsSection';
import { usePendingRequestsForScope } from '../requests/hooks';
import { partitionPendingForRoster } from '../requests/rosterPending';
import { Badge } from '../../components/ui/Badge';

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
  const sortedSeats = useMemo(() => sortSeatsWithinScope(seats.data ?? []), [seats.data]);

  // Pending requests for the active ward — drives the "Outstanding
  // Requests" section + the per-row "Pending Removal" badge.
  const pendingRequests = usePendingRequestsForScope(activeWard);
  const { pendingAdds, pendingRemovesByCanonical } = useMemo(
    () => partitionPendingForRoster(pendingRequests.data ?? [], activeWard ?? ''),
    [pendingRequests.data, activeWard],
  );

  const handleWardChange = (next: string) => {
    setActiveWard(next);
    navigate({
      to: '/bishopric/roster',
      search: { ward: next },
      replace: true,
    }).catch(() => {
      // Navigation can fail mid-route-tree-build during HMR; the URL
      // sync is a nice-to-have, not load-bearing.
    });
  };

  if (wards.length === 0) {
    return (
      <section>
        <h1>Roster</h1>
        <p>You have no bishopric wards assigned in this stake.</p>
      </section>
    );
  }

  const seatCount = seats.data?.length ?? 0;

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
        <UtilizationBar
          total={seatCount}
          cap={wardDoc?.seat_cap ?? null}
          overCap={wardDoc?.seat_cap !== undefined && seatCount > wardDoc.seat_cap}
        />
      </div>

      {seats.isLoading || seats.data === undefined ? (
        <LoadingSpinner />
      ) : (
        <>
          <RosterCardList
            seats={sortedSeats}
            emptyMessage="No seats assigned to this ward yet. A Kindoo Manager imports from LCR weekly; manual additions land via the New Kindoo Request page."
            actions={(seat) => (seat.type === 'auto' ? null : <RemovalAffordance seat={seat} />)}
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
