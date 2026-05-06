// Stake Presidency Ward Rosters page (live). Mirrors
// `src/ui/stake/WardRosters.html`. Read-only browse over any ward in
// the stake. Picking a ward switches the live subscription to that
// ward's seats; URL `?ward=` deep-links pre-select.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useStakeWards, useWardSeats } from './hooks';
import { RosterCardList } from '../../components/roster/RosterCardList';
import { sortSeatsWithinScope } from '../../lib/sort/seats';
import { RosterUtilization } from '../../lib/render/RosterUtilization';
import { LoadingSpinner } from '../../lib/render/LoadingSpinner';
import { Select } from '../../components/ui/Select';
import { PendingAddRequestsSection } from '../requests/components/PendingAddRequestsSection';
import { usePendingRequestsForScope } from '../requests/hooks';
import { partitionPendingForRoster } from '../requests/rosterPending';
import { Badge } from '../../components/ui/Badge';

export interface WardRostersPageProps {
  /** Pre-selected ward code from `?ward=...`. */
  initialWard?: string;
}

export function WardRostersPage({ initialWard }: WardRostersPageProps) {
  const wards = useStakeWards();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string | null>(initialWard ?? null);

  const wardsList = useMemo(() => {
    const data = wards.data ?? [];
    return [...data].sort((a, b) => a.ward_code.localeCompare(b.ward_code));
  }, [wards.data]);

  // Once the wards collection loads, validate the selected ward exists;
  // fall back to "no selection" if the deep-linked code is unknown.
  useEffect(() => {
    if (!selected) return;
    if (wardsList.length === 0) return;
    if (!wardsList.find((w) => w.ward_code === selected)) {
      setSelected(null);
    }
  }, [selected, wardsList]);

  const seats = useWardSeats(selected);
  const wardDoc = useMemo(
    () => (selected ? wardsList.find((w) => w.ward_code === selected) : undefined),
    [selected, wardsList],
  );
  const sortedSeats = useMemo(() => sortSeatsWithinScope(seats.data ?? []), [seats.data]);
  const seatCount = seats.data?.length ?? 0;

  // Pending requests for the selected ward — drives the "Outstanding
  // Requests" section + the per-row "Pending Removal" badge.
  const pendingRequests = usePendingRequestsForScope(selected);
  const { pendingAdds, pendingRemovesByCanonical } = useMemo(
    () => partitionPendingForRoster(pendingRequests.data ?? [], selected ?? ''),
    [pendingRequests.data, selected],
  );

  const handleChange = (next: string) => {
    const value = next || null;
    setSelected(value);
    navigate({
      to: '/stake/wards',
      search: value ? { ward: value } : {},
      replace: true,
    }).catch(() => {
      // best-effort URL sync
    });
  };

  return (
    <section>
      <h1>Ward Rosters</h1>
      <p className="kd-page-subtitle">Read-only view of any ward in the stake.</p>

      <div className="kd-ward-select-row">
        <label htmlFor="stake-ward-select">Ward: </label>
        <Select
          id="stake-ward-select"
          value={selected ?? ''}
          onChange={(e) => handleChange(e.target.value)}
        >
          <option value="">{wards.isLoading ? 'Loading wards…' : 'Choose a ward…'}</option>
          {wardsList.map((w) => (
            <option key={w.ward_code} value={w.ward_code}>
              {w.ward_name} ({w.ward_code})
            </option>
          ))}
        </Select>
      </div>

      {selected ? (
        <>
          <div className="kd-utilization-host">
            <RosterUtilization
              committedTotal={seatCount}
              cap={wardDoc?.seat_cap ?? null}
              pendingAdds={pendingAdds.length}
              pendingRemoves={pendingRemovesByCanonical.size}
              committedOverCap={wardDoc !== undefined && seatCount > wardDoc.seat_cap}
            />
          </div>
          {seats.isLoading || seats.data === undefined ? (
            <LoadingSpinner />
          ) : (
            <>
              <RosterCardList
                seats={sortedSeats}
                emptyMessage={`No seats in ${wardDoc?.ward_name ?? selected} yet.`}
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
        </>
      ) : (
        <div className="roster-empty" role="status">
          <p>Pick a ward above to see its roster.</p>
        </div>
      )}
    </section>
  );
}
