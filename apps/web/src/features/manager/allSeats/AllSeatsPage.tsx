// Manager All Seats page (live). Full roster across every scope;
// ward / building / type filters via URL search params; contextual
// utilization bar above the table that tracks the Scope filter
// (entire stake / stake-scope / a specific ward). Per-scope
// dashboards live on the Manager Dashboard.
//
// Phase B (T-43, spec §15): multi-row rendering — one row per grant
// (primary + each `duplicate_grants[]` entry). Each row's columns
// reflect the grant being rendered, not always the seat's primary.
// Remove on a duplicate row submits a `remove` request scoped to that
// grant's `(scope, kindoo_site_id)`. The legacy Reconcile button is
// gone — the multi-row layout subsumes its surface (AC #12).
//
// All Seats is VIEW-ONLY for edits: there is no edit affordance here.
// Editing a seat flows entirely through the roster pages' EditSeatDialog
// request flow (spec §6.1), which creates an audited edit request — no
// edit dialog may write SBA directly.
//
// Mutations:
//   - Remove via the shared <RemovalAffordance>, grant-aware on
//     duplicate rows. (This is the only write path on this page.)

import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { resolveWardSite } from '@kindoo/shared';
import type { Building, KindooSite, Seat, Ward } from '@kindoo/shared';
import { useAllSeats, useBuildings, useKindooSites, useWards } from './hooks';
import { siteLabelForGrant } from '../../../lib/kindooSites';
import { scopeLabel } from '../../../lib/scopeLabel';
import { collapseSameScopeGrants, grantsForDisplay, type GrantView } from '../../../lib/grants';
import { hasStakeScopeGrant, isForeignSiteOnly } from '../../../lib/foreignSiteOnly';
import { sortSeatsAcrossScopes, sortSeatsWithinScope } from '../../../lib/sort/seats';
import { useStakeDoc } from '../dashboard/hooks';
import { stakeAvailablePoolSize } from '../../../lib/render/stakePool';
import { UtilizationBar } from '../../../lib/render/UtilizationBar';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import { EmptyState } from '../../../lib/render/EmptyState';
import { Select } from '../../../components/ui/Select';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { RosterMemberLine } from '../../../components/roster/RosterMemberLine';
import { RemovalAffordance } from '../../requests/components/RemovalAffordance';
import { GrantStakeAccessDialog } from '../../requests/components/GrantStakeAccessDialog';
import { isScopeAllowed } from '../../requests/scopeOptions';
import { usePrincipal } from '../../../lib/principal';
import { useActiveStake } from '../../../lib/useActiveStake';

export interface AllSeatsPageProps {
  initialWard?: string;
  initialBuilding?: string;
  initialType?: 'auto' | 'manual' | 'temp';
}

interface GrantRow {
  seat: Seat;
  grant: GrantView;
  /** Stable React key. */
  rowKey: string;
}

/**
 * Pure: expand every seat into grant-rows, collapsing same-scope
 * DuplicateGrants into the row that owns that scope (primary if it
 * matches, else the first duplicate at that scope). The collapsed
 * row's `building_names` is the union of every same-scope grant's
 * buildings; `grant.hasSameScopeDuplicates` flags the badge state.
 * Cross-scope duplicates remain their own rows.
 */
function expandSeats(seats: readonly Seat[]): GrantRow[] {
  const rows: GrantRow[] = [];
  for (const seat of seats) {
    for (const grant of collapseSameScopeGrants(grantsForDisplay(seat))) {
      const suffix = grant.isPrimary ? 'pri' : `dup-${grant.duplicateIndex}`;
      rows.push({ seat, grant, rowKey: `${seat.member_canonical}/${suffix}` });
    }
  }
  return rows;
}

/**
 * Sort grant-rows by overlaying each grant's discriminating fields onto
 * a `Seat` shim and reusing the shared roster comparators so AllSeats
 * and the roster pages order identically (per spec §15 Phase B AC #9:
 * each row sorts by its own grant's fields). The shim carries the
 * grant's `scope` / `type` / `callings` / `reason` / dates; the seat's
 * `member_name` + `created_at` ride along for the tiebreak. Manual
 * rows order by the grant's `reason` (manual seats store the calling
 * there, with `callings: []`), auto by `callings`, temp by expiry —
 * exactly the shared comparator's contract.
 */
function grantRowShim(row: GrantRow): Seat {
  // Identity + tiebreak fields ride from the seat; the grant's own
  // fields (scope / type / callings / reason / dates) are overlaid.
  // Conditional spreads keep optional fields absent (not `undefined`)
  // to satisfy `exactOptionalPropertyTypes`. `member_canonical` is the
  // rowKey so the sort round-trips uniquely across a seat's duplicates.
  return {
    ...row.seat,
    member_canonical: row.rowKey,
    scope: row.grant.scope,
    type: row.grant.type,
    callings: [...row.grant.callings],
    ...(row.grant.reason !== undefined ? { reason: row.grant.reason } : {}),
    ...(row.grant.start_date !== undefined ? { start_date: row.grant.start_date } : {}),
    ...(row.grant.end_date !== undefined ? { end_date: row.grant.end_date } : {}),
  };
}

function sortGrantRowsBy(
  rows: readonly GrantRow[],
  sortShims: (shims: readonly Seat[]) => Seat[],
): GrantRow[] {
  const byKey = new Map(rows.map((r) => [r.rowKey, r]));
  const shims = rows.map(grantRowShim);
  return sortShims(shims)
    .map((s) => byKey.get(s.member_canonical))
    .filter((r): r is GrantRow => r !== undefined);
}

function sortGrantRowsAcrossScopes(rows: readonly GrantRow[]): GrantRow[] {
  return sortGrantRowsBy(rows, sortSeatsAcrossScopes);
}

function sortGrantRowsWithinScope(rows: readonly GrantRow[]): GrantRow[] {
  return sortGrantRowsBy(rows, sortSeatsWithinScope);
}

export function AllSeatsPage({ initialWard, initialBuilding, initialType }: AllSeatsPageProps) {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const seats = useAllSeats();
  const wards = useWards();
  const buildings = useBuildings();
  // Live Kindoo Sites catalogue — feeds the per-grant foreign-site
  // badge (spec §15 Phase B). Empty when the stake only operates its
  // home site.
  const kindooSites = useKindooSites();
  const stake = useStakeDoc();
  const navigate = useNavigate();

  const ward = initialWard ?? '';
  const building = initialBuilding ?? '';
  const type = initialType ?? '';

  const wardsList = useMemo(
    () => [...(wards.data ?? [])].sort((a, b) => a.ward_code.localeCompare(b.ward_code)),
    [wards.data],
  );
  const buildingsList = useMemo(
    () =>
      [...(buildings.data ?? [])].sort((a, b) => a.building_name.localeCompare(b.building_name)),
    [buildings.data],
  );
  const sitesList = useMemo(() => kindooSites.data ?? [], [kindooSites.data]);

  // Phase B (AC #1 + AC #2): expand every seat into one row per
  // grant (primary + each duplicate). Filters apply to the grant's
  // own fields — `ward` matches the grant's scope; `building` matches
  // the grant's `building_names`; `type` matches the grant's type.
  const grantRows = useMemo(() => {
    const all = expandSeats(seats.data ?? []);
    const matched = all.filter(({ grant }) => {
      if (ward && grant.scope !== ward) return false;
      if (building && !grant.building_names.includes(building)) return false;
      if (type && grant.type !== type) return false;
      return true;
    });
    return ward ? sortGrantRowsWithinScope(matched) : sortGrantRowsAcrossScopes(matched);
  }, [seats.data, ward, building, type]);

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

  // Contextual utilization: bar tracks the current Scope filter (see
  // detailed semantics in the original page docstring; mostly
  // unchanged from pre-Phase-B). Phase B (T-43 AC #5): the per-ward /
  // stake-scope counts widen to match the Dashboard's
  // `countSeatsForScope` semantics — both sides read the
  // `duplicate_scopes` primitive mirror (server-maintained, single-
  // field indexed). A seat counts when its primary OR any
  // `duplicate_scopes` entry matches; same-scope within-site dupes
  // collapse (one count per `member_canonical`). Keep the predicate
  // here byte-equivalent to `Dashboard.countSeatsForScope`. The
  // entire-stake bar (no ward filter) stays primary-only — it's
  // home-stake utilization (license cap), a separate semantic that
  // Phase B does not redefine.
  //
  // INTENTIONAL DIVERGENCE: this bar widens via `duplicate_scopes` for
  // visibility, but the server-side over-cap calc
  // (`functions/src/lib/overCaps.ts`) intentionally stays primary-only —
  // over-cap warnings represent actual home-stake Kindoo-license-pool
  // consumption, which the primary represents. A ward bar can render
  // "over cap" visually without firing `over_cap_warning`. If you
  // change one side, change the other or document why they should
  // continue to diverge. Spec §15 Phase B.
  const allSeats = seats.data ?? [];
  const stakeSeatCap = stake.data?.stake_seat_cap;
  const stakePoolCap = stakeAvailablePoolSize(stakeSeatCap, wardsList, buildingsList);
  const foreignWardCodes = useMemo(() => {
    // Id-first ward→building site resolution (slug FK, name fallback).
    return new Set(
      wardsList.filter((w) => resolveWardSite(w, buildingsList) != null).map((w) => w.ward_code),
    );
  }, [wardsList, buildingsList]);
  const wardDoc = ward && ward !== 'stake' ? wardsList.find((w) => w.ward_code === ward) : null;
  const utilizationLabel = !ward
    ? 'Entire-stake utilization'
    : ward === 'stake'
      ? 'Stake-scope utilization'
      : `${scopeLabel(ward, wardsList)} utilization`;
  const utilizationTotal = !ward
    ? allSeats.filter((s) => {
        if (s.scope === 'stake') return true;
        if (s.kindoo_site_id !== undefined) return s.kindoo_site_id == null;
        return !foreignWardCodes.has(s.scope);
      }).length
    : allSeats.filter((s) => {
        // Phase B AC #5: primary OR any duplicate scope matches the
        // filter. Mirrors `countSeatsForScope` on the Dashboard;
        // same-scope dupes collapse implicitly (one seat → one
        // count regardless of how many of its grants name the
        // scope).
        if (s.scope === ward) return true;
        return (s.duplicate_scopes ?? []).includes(ward);
      }).length;
  const utilizationCap: number | null | undefined = !ward
    ? stakeSeatCap
    : ward === 'stake'
      ? stakePoolCap
      : (wardDoc?.seat_cap ?? null);
  const utilizationOverCap =
    typeof utilizationCap === 'number' && utilizationCap > 0 && utilizationTotal > utilizationCap;

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
                {w.ward_name}
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
        <span className="kd-filter-summary">
          {grantRows.length} row{grantRows.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="kd-utilization-host" data-testid="allseats-utilization">
        <div className="kd-utilization-label">{utilizationLabel}</div>
        <UtilizationBar
          total={utilizationTotal}
          cap={utilizationCap}
          overCap={utilizationOverCap}
        />
      </div>

      {seats.isLoading || seats.data === undefined ? (
        <LoadingSpinner />
      ) : grantRows.length === 0 ? (
        <EmptyState message="No seats match the current filters." />
      ) : (
        <div className="roster-cards">
          {grantRows.map((row) => (
            <GrantRowCard
              key={row.rowKey}
              row={row}
              wards={wardsList}
              buildings={buildingsList}
              sites={sitesList}
              principal={principal}
              activeStakeId={activeStakeId}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ---- Per-grant card -------------------------------------------------

interface GrantRowCardProps {
  row: GrantRow;
  wards: readonly Ward[];
  buildings: readonly Building[];
  sites: readonly KindooSite[];
  principal: ReturnType<typeof usePrincipal>;
  activeStakeId: string | null;
}

function GrantRowCard({
  row,
  wards,
  buildings,
  sites,
  principal,
  activeStakeId,
}: GrantRowCardProps) {
  const { seat, grant } = row;
  const siteLabel = siteLabelForGrant(grant, wards, buildings, sites);
  const canRemoveScope =
    activeStakeId !== null && isScopeAllowed(principal, activeStakeId, grant.scope);
  // All Seats has NO edit affordance — editing a seat flows through the
  // roster pages' EditSeatDialog request flow (no direct SBA write).
  // Remove (request) stays available per the gate below.
  // Phase B (AC #2 + spec §15 §412 / §425): same-scope priority
  // losers render as their own rows on AllSeats — INFORMATIONAL only.
  // Remove on a same-`(scope, kindoo_site_id)` non-auto duplicate is
  // intentionally hidden because the request would carry the same
  // tuple as the primary; the trigger's `planRemove` keys on
  // `(scope, kindoo_site_id)` and would target the primary
  // (delete/promote), silently demoting/removing the wrong grant.
  // Remove stays functional on:
  //   - the primary row (manual / temp);
  //   - parallel-site duplicates (different `kindoo_site_id`);
  //   - cross-scope duplicates (different scope).
  //
  // The auto-primary + non-auto duplicate case at the same
  // `(scope, site)` IS reachable (rare, but possible via
  // planAddMerge), and the trigger's KS-9 auto-primary
  // disambiguation in `planRemove`
  // (`functions/src/triggers/removeSeatOnRequestComplete.ts`) routes
  // such requests to the non-auto duplicate — but the SPA still has
  // to surface the affordance for it to be reachable. We gate that
  // case here on `seat.type === 'auto'`.
  const isPrimaryRow = grant.isPrimary;
  const sameScopeAndSiteAsPrimary =
    !isPrimaryRow && grant.scope === seat.scope && !grant.isParallelSite;
  const canRemove =
    grant.type !== 'auto' &&
    canRemoveScope &&
    (isPrimaryRow ||
      grant.isParallelSite ||
      grant.scope !== seat.scope ||
      // KS-9 escape: same-(scope, site) duplicate is only reachable
      // when the primary is auto, where the trigger routes the splice
      // to the non-auto duplicate.
      (sameScopeAndSiteAsPrimary && seat.type === 'auto'));

  // "Give Access To Stake Buildings" — manager-only affordance that
  // grants a foreign-site-only member a stake-scope seat (home-site
  // buildings). Rendered once per seat (primary row only, so a member's
  // multiple grant rows don't each carry the button) when the manager
  // holds a manager claim in the active stake AND the seat is
  // foreign-site-only AND the member doesn't already have a stake-scope
  // grant. The detection is per-seat (over every grant), so it reads
  // the same on whichever row hosts the button.
  const [grantOpen, setGrantOpen] = useState(false);
  const isManager = activeStakeId !== null && principal.managerStakes.includes(activeStakeId);
  const canGrantStakeAccess =
    isPrimaryRow &&
    isManager &&
    !hasStakeScopeGrant(seat) &&
    isForeignSiteOnly(seat, wards, buildings);

  const testIdSuffix = isPrimaryRow
    ? seat.member_canonical
    : `${seat.member_canonical}-dup-${grant.duplicateIndex}`;

  // Line 2: calling (auto) / reason (manual/temp). Line 3: buildings on
  // its own row below.
  const callingChip =
    grant.type === 'auto' && grant.callings.length > 0 ? (
      <span className="roster-card-chip">
        <span className="label">Calling:</span>
        <span className="roster-card-calling">{grant.callings.join(', ')}</span>
      </span>
    ) : (grant.type === 'manual' || grant.type === 'temp') && grant.reason ? (
      <span className="roster-card-chip">
        <span className="label">Reason:</span>
        <span className="roster-card-reason">{grant.reason}</span>
      </span>
    ) : null;

  const buildingsChip =
    grant.building_names.length > 0 ? (
      <span className="roster-card-chip">
        <span className="label">Buildings:</span>
        {grant.building_names.join(', ')}
      </span>
    ) : null;

  const datesLine =
    grant.type === 'temp' && (grant.start_date || grant.end_date) ? (
      <div className="roster-card-line2">
        <span className="roster-card-chip">
          <span className="label">Dates:</span>
          {grant.start_date ?? '?'} → {grant.end_date ?? '?'}
        </span>
      </div>
    ) : null;

  const callingLine = callingChip ? <div className="roster-card-line2">{callingChip}</div> : null;

  const buildingsLine = buildingsChip ? (
    <div className="roster-card-line2">{buildingsChip}</div>
  ) : null;

  return (
    <div
      className={`roster-card roster-card--two-line type-${grant.type}`}
      data-seat-id={seat.member_canonical}
      data-row-key={row.rowKey}
      data-grant-kind={grant.isPrimary ? 'primary' : 'duplicate'}
    >
      <div className="roster-card-line1">
        <span className="roster-card-badges">
          <Badge variant={grant.type}>{grant.type}</Badge>
          {grant.isPrimary && !grant.hasSameScopeDuplicates ? null : (
            <Badge
              variant="manual"
              data-testid={`grant-duplicate-badge-${testIdSuffix}`}
              title={
                grant.hasSameScopeDuplicates
                  ? 'This user was manually granted access to additional buildings.'
                  : grant.isParallelSite
                    ? 'Parallel-site grant — needs its own Kindoo write.'
                    : 'Within-site priority loser — covered by the primary write.'
              }
            >
              {grant.hasSameScopeDuplicates && grant.type === 'auto' ? 'edited' : 'duplicate'}
            </Badge>
          )}
          {siteLabel ? (
            <Badge variant="info" data-testid={`kindoo-site-badge-${testIdSuffix}`}>
              {siteLabel}
            </Badge>
          ) : null}
          <span className="roster-card-chip roster-card-scope">
            {scopeLabel(grant.scope, wards)}
          </span>
        </span>
        <span className="roster-card-actions" style={{ display: 'inline-flex', gap: 8 }}>
          {canGrantStakeAccess ? (
            <Button
              variant="secondary"
              onClick={() => setGrantOpen(true)}
              data-testid={`grant-stake-access-btn-${seat.member_canonical}`}
            >
              Give Access To Stake Buildings
            </Button>
          ) : null}
          {canRemove ? (
            <RemovalAffordance
              seat={seat}
              grant={{
                scope: grant.scope,
                type: grant.type,
                kindoo_site_id: grant.kindoo_site_id,
              }}
              testIdSuffix={testIdSuffix}
            />
          ) : null}
        </span>
      </div>
      {canGrantStakeAccess && grantOpen ? (
        <GrantStakeAccessDialog
          seat={seat}
          onOpenChange={(next) => {
            if (!next) setGrantOpen(false);
          }}
        />
      ) : null}
      <div className="roster-card-member-line">
        <span className="roster-card-member">
          <RosterMemberLine name={seat.member_name} email={seat.member_email} />
        </span>
      </div>
      {callingLine}
      {buildingsLine}
      {datesLine}
    </div>
  );
}
