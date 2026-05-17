// Stake Presidency Ward Rosters page (live). Cross-ward browse over
// any ward in the stake. Picking a ward switches the live
// subscription to that ward's seats; URL `?ward=` deep-links
// pre-select.
//
// Phase B (T-43): broadened inclusion — `useWardSeats` returns any
// seat whose primary scope OR a duplicate scope matches the picked
// ward. Each row's columns reflect the matching grant.
//
// Manual + temp rows carry a per-row Remove button via
// `<RemovalAffordance>`, gated by `isScopeAllowed(principal, ...)` so
// the button only appears on rows the viewer has authority for. The
// rule is symmetric with `allowedScopesFor` — if a user can ADD for a
// scope, they can also REMOVE for it.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { Seat } from '@kindoo/shared';
import { usePrincipal } from '../../lib/principal';
import { STAKE_ID } from '../../lib/constants';
import { useKindooSites, useStakeWards, useWardSeats } from './hooks';
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

export interface WardRostersPageProps {
  /** Pre-selected ward code from `?ward=...`. */
  initialWard?: string;
}

export function WardRostersPage({ initialWard }: WardRostersPageProps) {
  const principal = usePrincipal();
  const wards = useStakeWards();
  const kindooSites = useKindooSites();
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

  // Pair every seat with the grant that matched the picked ward.
  const seatsWithGrant = useMemo(() => {
    const rows: Array<{ seat: Seat; grant: GrantView }> = [];
    if (!selected) return rows;
    for (const s of seats.data ?? []) {
      const grant = pickGrantForScope(s, selected);
      if (grant) rows.push({ seat: s, grant });
    }
    return rows;
  }, [seats.data, selected]);

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

  // Pending requests for the selected ward.
  const pendingRequests = usePendingRequestsForScope(selected);
  const { pendingAdds, pendingRemovesByKey } = useMemo(
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
    }).catch(() => {});
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
              pendingRemoves={pendingRemovesByKey.size}
              committedOverCap={wardDoc !== undefined && seatCount > wardDoc.seat_cap}
            />
          </div>
          {seats.isLoading || seats.data === undefined ? (
            <LoadingSpinner />
          ) : (
            <>
              {sortedRows.length === 0 ? (
                <EmptyState message={`No seats in ${wardDoc?.ward_name ?? selected} yet.`} />
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
                        wards={wardsList}
                        sites={kindooSites.data ?? []}
                      />
                    );
                  })}
                </div>
              )}
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
