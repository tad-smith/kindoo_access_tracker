// Manager All Seats page (live). Mirrors `src/ui/manager/AllSeats.html`.
// Full roster across every scope; ward / building / type filters via
// URL search params; per-scope summary cards with utilization bars; a
// total-utilization bar when the scope filter is "All".
//
// Phase 5 ships the read view + filters; Phase 7 will wire the inline
// edit modal. The shared `<RosterCardList showScope />` primitive
// renders the seat list — same row-feel density as bishopric / stake
// rosters with a scope chip on each card.

import { useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { Seat } from '@kindoo/shared';
import { useAllSeats, useBuildings, useWards } from './hooks';
import { useStakeDoc } from '../dashboard/hooks';
import { RosterCardList } from '../../../components/roster/RosterCardList';
import { UtilizationBar } from '../../../lib/render/UtilizationBar';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import { Select } from '../../../components/ui/Select';

export interface AllSeatsPageProps {
  initialWard?: string;
  initialBuilding?: string;
  initialType?: 'auto' | 'manual' | 'temp';
}

export function AllSeatsPage({ initialWard, initialBuilding, initialType }: AllSeatsPageProps) {
  const seats = useAllSeats();
  const wards = useWards();
  const buildings = useBuildings();
  const stake = useStakeDoc();
  const navigate = useNavigate();

  const ward = initialWard ?? '';
  const building = initialBuilding ?? '';
  const type = initialType ?? '';

  const filtered = useMemo<readonly Seat[]>(() => {
    const all = seats.data ?? [];
    return all.filter((s) => {
      if (ward && s.scope !== ward) return false;
      if (building && !s.building_names.includes(building)) return false;
      if (type && s.type !== type) return false;
      return true;
    });
  }, [seats.data, ward, building, type]);

  const wardsList = useMemo(
    () => [...(wards.data ?? [])].sort((a, b) => a.ward_code.localeCompare(b.ward_code)),
    [wards.data],
  );
  const buildingsList = useMemo(
    () =>
      [...(buildings.data ?? [])].sort((a, b) => a.building_name.localeCompare(b.building_name)),
    [buildings.data],
  );

  const updateSearch = (next: { ward?: string; building?: string; type?: string }) => {
    const merged: Record<string, string> = {};
    const newWard = next.ward !== undefined ? next.ward : ward;
    const newBuilding = next.building !== undefined ? next.building : building;
    const newType = next.type !== undefined ? next.type : type;
    if (newWard) merged.ward = newWard;
    if (newBuilding) merged.building = newBuilding;
    if (newType) merged.type = newType;
    navigate({ to: '/manager/seats', search: merged, replace: true }).catch(() => {});
  };

  const allSeats = seats.data ?? [];
  // Per-scope summary blocks (one per ward + stake). When the user has
  // filtered by ward we only render the matching summary.
  const summaries = useMemo(() => {
    type SummaryRow = { scope: string; label: string; count: number; cap: number | null };
    const rows: SummaryRow[] = [];
    const stakeCount = allSeats.filter((s) => s.scope === 'stake').length;
    if (!ward || ward === 'stake') {
      rows.push({
        scope: 'stake',
        label: 'Stake',
        count: stakeCount,
        cap: null, // stake-portion math is dashboard territory
      });
    }
    for (const w of wardsList) {
      if (ward && ward !== w.ward_code) continue;
      const count = allSeats.filter((s) => s.scope === w.ward_code).length;
      rows.push({
        scope: w.ward_code,
        label: `${w.ward_name} (${w.ward_code})`,
        count,
        cap: w.seat_cap,
      });
    }
    return rows;
  }, [allSeats, wardsList, ward]);

  const totalCount = allSeats.length;
  const stakeSeatCap = stake.data?.stake_seat_cap;
  const showOverallBar = !ward && stakeSeatCap !== undefined && stakeSeatCap > 0;

  return (
    <section>
      <h1>All Seats</h1>
      <p className="kd-page-subtitle">Full roster across every scope.</p>

      <div className="kd-filter-row">
        <label>
          Scope:
          <Select value={ward} onChange={(e) => updateSearch({ ward: e.target.value })}>
            <option value="">All</option>
            <option value="stake">Stake</option>
            {wardsList.map((w) => (
              <option key={w.ward_code} value={w.ward_code}>
                {w.ward_name} ({w.ward_code})
              </option>
            ))}
          </Select>
        </label>
        <label>
          Building:
          <Select value={building} onChange={(e) => updateSearch({ building: e.target.value })}>
            <option value="">All</option>
            {buildingsList.map((b) => (
              <option key={b.building_name} value={b.building_name}>
                {b.building_name}
              </option>
            ))}
          </Select>
        </label>
        <label>
          Type:
          <Select value={type} onChange={(e) => updateSearch({ type: e.target.value })}>
            <option value="">All</option>
            <option value="auto">auto</option>
            <option value="manual">manual</option>
            <option value="temp">temp</option>
          </Select>
        </label>
        <span style={{ alignSelf: 'center' }}>
          {filtered.length} row{filtered.length === 1 ? '' : 's'}
        </span>
      </div>

      {showOverallBar ? (
        <div className="kd-utilization-host">
          <UtilizationBar
            total={totalCount}
            cap={stakeSeatCap}
            overCap={totalCount > stakeSeatCap}
          />
        </div>
      ) : null}

      {summaries.length > 0 ? (
        <div className="kd-scope-summaries" data-testid="scope-summaries">
          {summaries.map((s) => (
            <div key={s.scope} className="kd-scope-summary-card">
              <span className="kd-scope-label">{s.label}</span>
              <UtilizationBar
                total={s.count}
                cap={s.cap}
                overCap={s.cap !== null && s.count > s.cap}
              />
            </div>
          ))}
        </div>
      ) : null}

      {seats.isLoading || seats.data === undefined ? (
        <LoadingSpinner />
      ) : (
        <RosterCardList
          seats={filtered}
          showScope
          emptyMessage="No seats match the current filters."
        />
      )}
    </section>
  );
}
