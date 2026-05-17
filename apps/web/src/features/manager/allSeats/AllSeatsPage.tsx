// Manager All Seats page (live). Full roster across every scope;
// ward / building / type filters via URL search params; contextual
// utilization bar above the table that tracks the Scope filter
// (entire stake / stake-scope / a specific ward). Per-scope
// dashboards live on the Manager Dashboard.
//
// Phase B (T-43, spec §15): multi-row rendering — one row per grant
// (primary + each `duplicate_grants[]` entry). Each row's columns
// reflect the grant being rendered, not always the seat's primary.
// Edit on a duplicate row is disabled with a tooltip; Remove on a
// duplicate row submits a `remove` request scoped to that grant's
// `(scope, kindoo_site_id)`. The legacy Reconcile button is gone —
// the multi-row layout subsumes its surface (AC #12).
//
// Mutations:
//   - Inline-edit dialog on manual / temp primary rows (auto rows
//     are importer-owned and have no edit affordance).
//   - Remove via the shared <RemovalAffordance>, grant-aware on
//     duplicate rows.

import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { KindooSite, Seat, Ward } from '@kindoo/shared';
import {
  useAllSeats,
  useBuildings,
  useInlineSeatEditMutation,
  useKindooSites,
  useWards,
} from './hooks';
import { siteLabelForGrant } from '../../../lib/kindooSites';
import { grantsForDisplay, type GrantView } from '../../../lib/grants';
import { useStakeDoc } from '../dashboard/hooks';
import { stakeAvailablePoolSize } from '../../../lib/render/stakePool';
import { UtilizationBar } from '../../../lib/render/UtilizationBar';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import { EmptyState } from '../../../lib/render/EmptyState';
import { Select } from '../../../components/ui/Select';
import { Input } from '../../../components/ui/Input';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Dialog } from '../../../components/ui/Dialog';
import { toast } from '../../../lib/store/toast';
import { RemovalAffordance } from '../../requests/components/RemovalAffordance';
import { isScopeAllowed } from '../../requests/scopeOptions';
import { usePrincipal } from '../../../lib/principal';
import { STAKE_ID } from '../../../lib/constants';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

/** Pure: expand every seat into grant-rows. */
function expandSeats(seats: readonly Seat[]): GrantRow[] {
  const rows: GrantRow[] = [];
  for (const seat of seats) {
    for (const grant of grantsForDisplay(seat)) {
      const suffix = grant.isPrimary ? 'pri' : `dup-${grant.duplicateIndex}`;
      rows.push({ seat, grant, rowKey: `${seat.member_canonical}/${suffix}` });
    }
  }
  return rows;
}

/** Match seat's type-band rank used by the legacy sort. */
const TYPE_BAND: Record<Seat['type'], number> = { auto: 0, manual: 1, temp: 2 };

function scopeRank(scope: string): number {
  return scope === 'stake' ? 0 : 1;
}

function nameKey(seat: Seat): string {
  return (seat.member_name || seat.member_email || '').toLowerCase();
}

/**
 * Sort grant-rows for AllSeats cross-scope view. Per spec §15 Phase B
 * AC #9: each row sorts independently by its own grant's fields; no
 * special grouping by seat. Order:
 *   1. Stake band first, then ward bands alpha by grant scope.
 *   2. Within each scope band: auto → manual → temp (type-banded).
 *   3. Within type band: name alpha; temp by end_date desc.
 */
function sortGrantRowsAcrossScopes(rows: readonly GrantRow[]): GrantRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    const ra = scopeRank(a.grant.scope);
    const rb = scopeRank(b.grant.scope);
    if (ra !== rb) return ra - rb;
    if (a.grant.scope !== b.grant.scope) return a.grant.scope.localeCompare(b.grant.scope);
    const ba = TYPE_BAND[a.grant.type];
    const bb = TYPE_BAND[b.grant.type];
    if (ba !== bb) return ba - bb;
    if (a.grant.type === 'temp' && b.grant.type === 'temp') {
      const am = !a.grant.end_date;
      const bm = !b.grant.end_date;
      if (am && !bm) return 1;
      if (!am && bm) return -1;
      if (!am && !bm) {
        const cmp = (b.grant.end_date ?? '').localeCompare(a.grant.end_date ?? '');
        if (cmp !== 0) return cmp;
      }
    }
    return nameKey(a.seat).localeCompare(nameKey(b.seat));
  });
  return sorted;
}

/** Within-scope sort (no scope key; used when the Scope filter pins to a single value). */
function sortGrantRowsWithinScope(rows: readonly GrantRow[]): GrantRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    const ba = TYPE_BAND[a.grant.type];
    const bb = TYPE_BAND[b.grant.type];
    if (ba !== bb) return ba - bb;
    if (a.grant.type === 'temp' && b.grant.type === 'temp') {
      const am = !a.grant.end_date;
      const bm = !b.grant.end_date;
      if (am && !bm) return 1;
      if (!am && bm) return -1;
      if (!am && !bm) {
        const cmp = (b.grant.end_date ?? '').localeCompare(a.grant.end_date ?? '');
        if (cmp !== 0) return cmp;
      }
    }
    return nameKey(a.seat).localeCompare(nameKey(b.seat));
  });
  return sorted;
}

export function AllSeatsPage({ initialWard, initialBuilding, initialType }: AllSeatsPageProps) {
  const principal = usePrincipal();
  const seats = useAllSeats();
  const wards = useWards();
  const buildings = useBuildings();
  // Live Kindoo Sites catalogue — feeds the per-grant foreign-site
  // badge (spec §15 Phase B). Empty when the stake only operates its
  // home site.
  const kindooSites = useKindooSites();
  const stake = useStakeDoc();
  const navigate = useNavigate();
  const [editingSeat, setEditingSeat] = useState<Seat | null>(null);

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
  // `countSeatsForScope` semantics — a seat counts when its primary
  // OR any `duplicate_scopes` entry matches. Same-scope within-site
  // dupes collapse (one count per `member_canonical`). The
  // entire-stake bar (no ward filter) stays primary-only — it's
  // home-stake utilization (license cap), a separate semantic that
  // Phase B does not redefine.
  const allSeats = seats.data ?? [];
  const stakeSeatCap = stake.data?.stake_seat_cap;
  const stakePoolCap = stakeAvailablePoolSize(stakeSeatCap, wardsList);
  const foreignWardCodes = useMemo(
    () => new Set(wardsList.filter((w) => w.kindoo_site_id != null).map((w) => w.ward_code)),
    [wardsList],
  );
  const wardDoc = ward && ward !== 'stake' ? wardsList.find((w) => w.ward_code === ward) : null;
  const utilizationLabel = !ward
    ? 'Entire-stake utilization'
    : ward === 'stake'
      ? 'Stake-scope utilization'
      : `Ward ${ward} utilization`;
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
              sites={sitesList}
              principal={principal}
              onEdit={() => setEditingSeat(row.seat)}
            />
          ))}
        </div>
      )}

      <SeatEditDialog
        seat={editingSeat}
        buildings={buildingsList.map((b) => b.building_name)}
        onClose={() => setEditingSeat(null)}
      />
    </section>
  );
}

// ---- Per-grant card -------------------------------------------------

interface GrantRowCardProps {
  row: GrantRow;
  wards: readonly Ward[];
  sites: readonly KindooSite[];
  principal: ReturnType<typeof usePrincipal>;
  onEdit: () => void;
}

function GrantRowCard({ row, wards, sites, principal, onEdit }: GrantRowCardProps) {
  const { seat, grant } = row;
  const siteLabel = siteLabelForGrant(grant, wards, sites);
  const canRemoveScope = isScopeAllowed(principal, STAKE_ID, grant.scope);
  // Edit affordance: shown only on the primary row of manual / temp
  // seats (auto seats are importer-owned). On every duplicate row
  // the button renders disabled with a tooltip — preserves the
  // action-column rhythm and tells the user the primary is the edit
  // surface (AC #7).
  const showEdit = grant.type !== 'auto';
  const editTooltip = grant.isPrimary
    ? undefined
    : grant.isParallelSite
      ? "Edit the primary grant to modify this person's seat — parallel-site changes require a new request."
      : "Edit the primary grant to modify this person's seat — this row is informational and is covered by the primary's write.";
  // Phase B (AC #2): same-scope priority losers render as their own
  // rows on AllSeats — informational. Remove on a same-scope
  // within-site row is still functional but currently keys on
  // `(scope, kindoo_site_id)` alone (KS-9 resolution: per-grant UUID
  // not needed). For the same-scope same-site case the trigger today
  // would target the primary on scope match; until that's tightened
  // we surface the button only on rows whose `(scope, kindoo_site_id)`
  // discriminator is unique against the primary.
  const isPrimaryRow = grant.isPrimary;
  const canRemove =
    grant.type !== 'auto' &&
    canRemoveScope &&
    // Always allow on the primary; on a duplicate, allow when its
    // (scope, site) differs from the primary so the trigger's
    // matching is unambiguous.
    (isPrimaryRow || grant.isParallelSite || grant.scope !== seat.scope);

  const testIdSuffix = isPrimaryRow
    ? seat.member_canonical
    : `${seat.member_canonical}-dup-${grant.duplicateIndex}`;

  // Line 2 detail: calling (auto) / reason (manual/temp) + buildings.
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

  const detailLine =
    callingChip || buildingsChip ? (
      <div className="roster-card-line2">
        {callingChip}
        {buildingsChip}
      </div>
    ) : null;

  const memberInner = seat.member_name ? (
    <>
      <span className="roster-card-name">{seat.member_name}</span>{' '}
      <span>
        (
        <span className="roster-email" title={seat.member_email}>
          {seat.member_email}
        </span>
        )
      </span>
    </>
  ) : (
    <span className="roster-email" title={seat.member_email}>
      {seat.member_email}
    </span>
  );

  return (
    <div
      className={`roster-card type-${grant.type}`}
      data-seat-id={seat.member_canonical}
      data-row-key={row.rowKey}
      data-grant-kind={grant.isPrimary ? 'primary' : 'duplicate'}
    >
      <div className="roster-card-line1">
        <span className="roster-card-badges">
          <Badge variant={grant.type}>{grant.type}</Badge>
          {grant.isPrimary ? null : (
            <Badge
              variant="manual"
              data-testid={`grant-duplicate-badge-${testIdSuffix}`}
              title={
                grant.isParallelSite
                  ? 'Parallel-site grant — needs its own Kindoo write.'
                  : 'Within-site priority loser — covered by the primary write.'
              }
            >
              duplicate
            </Badge>
          )}
          {siteLabel ? (
            <Badge variant="info" data-testid={`kindoo-site-badge-${testIdSuffix}`}>
              {siteLabel}
            </Badge>
          ) : null}
          <span className="roster-card-chip roster-card-scope">
            <code>{grant.scope}</code>
          </span>
        </span>
        <span className="roster-card-member">{memberInner}</span>
        <span className="roster-card-actions" style={{ display: 'inline-flex', gap: 8 }}>
          {showEdit ? (
            <Button
              variant="secondary"
              onClick={onEdit}
              disabled={!grant.isPrimary}
              {...(editTooltip ? { title: editTooltip } : {})}
              data-testid={`seat-edit-${testIdSuffix}`}
            >
              Edit
            </Button>
          ) : null}
          {canRemove ? (
            <RemovalAffordance
              seat={seat}
              grant={{ scope: grant.scope, kindoo_site_id: grant.kindoo_site_id }}
              testIdSuffix={testIdSuffix}
            />
          ) : null}
        </span>
      </div>
      {datesLine}
      {detailLine}
    </div>
  );
}

// ---- Inline edit dialog --------------------------------------------

// Schema for the inline-edit form. Each text field is `z.string()` so
// the input/output types stay identical (RHF's typed `useForm<T>` rejects
// schemas where input ≠ output under `exactOptionalPropertyTypes`).
// Empty strings represent "not set"; date fields are validated by the
// regex below only when populated.
const seatEditSchema = z
  .object({
    member_name: z.string().trim().min(1, 'Member name is required.'),
    reason: z.string(),
    building_names_csv: z.string(),
    start_date: z.string(),
    end_date: z.string(),
  })
  .superRefine((val, ctx) => {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (val.start_date && !re.test(val.start_date)) {
      ctx.addIssue({
        code: 'custom',
        path: ['start_date'],
        message: 'Use YYYY-MM-DD.',
      });
    }
    if (val.end_date && !re.test(val.end_date)) {
      ctx.addIssue({
        code: 'custom',
        path: ['end_date'],
        message: 'Use YYYY-MM-DD.',
      });
    }
  });
type SeatEditForm = z.infer<typeof seatEditSchema>;

interface SeatEditDialogProps {
  seat: Seat | null;
  buildings: readonly string[];
  onClose: () => void;
}

function SeatEditDialog({ seat, buildings, onClose }: SeatEditDialogProps) {
  const mutation = useInlineSeatEditMutation();
  const form = useForm<SeatEditForm>({
    resolver: zodResolver(seatEditSchema),
    defaultValues: {
      member_name: '',
      reason: '',
      building_names_csv: '',
      start_date: '',
      end_date: '',
    },
    ...(seat
      ? {
          values: {
            member_name: seat.member_name,
            reason: seat.reason ?? '',
            building_names_csv: seat.building_names.join(', '),
            start_date: seat.start_date ?? '',
            end_date: seat.end_date ?? '',
          },
        }
      : {}),
  });
  const { register, handleSubmit, formState } = form;

  if (!seat) return null;

  async function onSubmit(input: SeatEditForm) {
    if (!seat) return;
    try {
      const buildingNames = input.building_names_csv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const payload: Parameters<typeof mutation.mutateAsync>[0] = {
        member_canonical: seat.member_canonical,
        member_name: input.member_name,
        reason: input.reason,
        building_names: buildingNames,
      };
      if (seat.type === 'temp') {
        if (input.start_date) payload.start_date = input.start_date;
        if (input.end_date) payload.end_date = input.end_date;
      }
      await mutation.mutateAsync(payload);
      toast('Seat updated.', 'success');
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  return (
    <Dialog
      open={seat !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Edit seat — ${seat.member_email}`}
      description={`Type: ${seat.type} · scope: ${seat.scope}. Scope and type are immutable.`}
    >
      <form onSubmit={handleSubmit(onSubmit)} className="kd-wizard-form">
        <label>
          Member name
          <Input {...register('member_name')} />
        </label>
        {formState.errors.member_name ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.member_name.message}
          </p>
        ) : null}
        <label>
          Reason
          <Input {...register('reason')} />
        </label>
        <label>
          Buildings (comma-separated; choose from: {buildings.join(', ')})
          <Input {...register('building_names_csv')} placeholder={buildings.join(', ')} />
        </label>
        {seat.type === 'temp' ? (
          <>
            <label>
              Start date (YYYY-MM-DD)
              <Input type="date" {...register('start_date')} />
            </label>
            {formState.errors.start_date ? (
              <p role="alert" className="kd-form-error">
                {formState.errors.start_date.message}
              </p>
            ) : null}
            <label>
              End date (YYYY-MM-DD)
              <Input type="date" {...register('end_date')} />
            </label>
            {formState.errors.end_date ? (
              <p role="alert" className="kd-form-error">
                {formState.errors.end_date.message}
              </p>
            ) : null}
          </>
        ) : null}
        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}
