// Manager All Seats page (live). Mirrors `src/ui/manager/AllSeats.html`.
// Full roster across every scope; ward / building / type filters via
// URL search params; total-utilization bar when the scope filter is
// "All". Per-scope utilization is surfaced on the Dashboard.
//
// Mutations:
//   - Inline-edit dialog on manual / temp rows (auto rows are
//     importer-owned and have no edit affordance).
//   - Reconcile dialog on rows where `duplicate_grants.length > 0`.
//
// The shared `<RosterCardList showScope />` primitive renders the
// seat list — same row-feel density as bishopric / stake rosters with
// a scope chip on each card.

import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { DuplicateGrant, Seat } from '@kindoo/shared';
import {
  useAllSeats,
  useBuildings,
  useInlineSeatEditMutation,
  useReconcileSeatMutation,
  useWards,
} from './hooks';
import { useStakeDoc } from '../dashboard/hooks';
import { RosterCardList } from '../../../components/roster/RosterCardList';
import { UtilizationBar } from '../../../lib/render/UtilizationBar';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import { Select } from '../../../components/ui/Select';
import { Input } from '../../../components/ui/Input';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Dialog } from '../../../components/ui/Dialog';
import { toast } from '../../../lib/store/toast';
import { RemovalAffordance } from '../../requests/components/RemovalAffordance';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
  const [editingSeat, setEditingSeat] = useState<Seat | null>(null);
  const [reconcilingSeat, setReconcilingSeat] = useState<Seat | null>(null);

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
        <span className="kd-filter-summary">
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

      {seats.isLoading || seats.data === undefined ? (
        <LoadingSpinner />
      ) : (
        <RosterCardList
          seats={filtered}
          showScope
          emptyMessage="No seats match the current filters."
          actions={(seat) => (
            <span style={{ display: 'inline-flex', gap: 8 }}>
              {seat.type !== 'auto' ? (
                <Button
                  variant="secondary"
                  onClick={() => setEditingSeat(seat)}
                  data-testid={`seat-edit-${seat.member_canonical}`}
                >
                  Edit
                </Button>
              ) : null}
              {seat.duplicate_grants.length > 0 ? (
                <Button
                  variant="secondary"
                  onClick={() => setReconcilingSeat(seat)}
                  data-testid={`seat-reconcile-${seat.member_canonical}`}
                >
                  Reconcile
                </Button>
              ) : null}
              {seat.type !== 'auto' ? <RemovalAffordance seat={seat} /> : null}
            </span>
          )}
          extraBadges={(seat) =>
            seat.duplicate_grants.length > 0 ? (
              <Badge variant="manual" data-testid={`seat-duplicate-badge-${seat.member_canonical}`}>
                {seat.duplicate_grants.length} duplicate
                {seat.duplicate_grants.length === 1 ? '' : 's'}
              </Badge>
            ) : null
          }
        />
      )}

      <SeatEditDialog
        seat={editingSeat}
        buildings={buildingsList.map((b) => b.building_name)}
        onClose={() => setEditingSeat(null)}
      />
      <ReconcileDialog seat={reconcilingSeat} onClose={() => setReconcilingSeat(null)} />
    </section>
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

// ---- Reconcile dialog ----------------------------------------------

interface ReconcileDialogProps {
  seat: Seat | null;
  onClose: () => void;
}

function ReconcileDialog({ seat, onClose }: ReconcileDialogProps) {
  const mutation = useReconcileSeatMutation();
  const [pickIdx, setPickIdx] = useState<number>(0);

  if (!seat) return null;
  if (seat.duplicate_grants.length === 0) return null;

  // Index 0 = current primary; 1.. = duplicate_grants entries.
  type Choice = {
    label: string;
    scope: string;
    type: Seat['type'];
    callings?: string[];
    reason?: string;
    start_date?: string;
    end_date?: string;
  };
  const primary: Choice = {
    label: `current primary (scope ${seat.scope}, ${seat.type})`,
    scope: seat.scope,
    type: seat.type,
    ...(seat.callings.length > 0 ? { callings: [...seat.callings] } : {}),
    ...(seat.reason ? { reason: seat.reason } : {}),
    ...(seat.start_date ? { start_date: seat.start_date } : {}),
    ...(seat.end_date ? { end_date: seat.end_date } : {}),
  };
  const choices: Choice[] = [
    primary,
    ...seat.duplicate_grants.map((d, i) => ({
      label: `duplicate #${i + 1} (scope ${d.scope}, ${d.type})`,
      scope: d.scope,
      type: d.type,
      ...(d.callings && d.callings.length > 0 ? { callings: [...d.callings] } : {}),
      ...(d.reason ? { reason: d.reason } : {}),
      ...(d.start_date ? { start_date: d.start_date } : {}),
      ...(d.end_date ? { end_date: d.end_date } : {}),
    })),
  ];

  async function confirm() {
    if (!seat) return;
    const newPrimary = choices[pickIdx];
    if (!newPrimary) return;
    if (newPrimary.scope !== seat.scope || newPrimary.type !== seat.type) {
      toast(
        'Reconcile across scope or type requires a backend rule update (see TASKS.md). For now you can only reconcile inside the same scope/type.',
        'error',
      );
      return;
    }
    // The new duplicate_grants is the original list minus the chosen
    // (when a duplicate is picked) plus the displaced primary.
    let newDuplicateGrants: DuplicateGrant[];
    if (pickIdx === 0) {
      newDuplicateGrants = [...seat.duplicate_grants];
    } else {
      const displacedPrimary: DuplicateGrant = {
        scope: seat.scope,
        type: seat.type,
        ...(seat.callings.length > 0 ? { callings: [...seat.callings] } : {}),
        ...(seat.reason ? { reason: seat.reason } : {}),
        ...(seat.start_date ? { start_date: seat.start_date } : {}),
        ...(seat.end_date ? { end_date: seat.end_date } : {}),
        detected_at: seat.last_modified_at,
      };
      newDuplicateGrants = seat.duplicate_grants.filter((_, i) => i !== pickIdx - 1);
      newDuplicateGrants.push(displacedPrimary);
    }
    try {
      await mutation.mutateAsync({
        member_canonical: seat.member_canonical,
        newPrimary,
        newDuplicateGrants:
          pickIdx === 0 ? [] : newDuplicateGrants.filter((_, i) => i !== pickIdx - 1),
      });
      toast('Seat reconciled.', 'success');
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
      title="Reconcile duplicate grants"
      description={`This seat (${seat.member_email}) has ${seat.duplicate_grants.length} duplicate grant(s). Pick which grant should be primary.`}
    >
      <div className="kd-wizard-form" data-testid="reconcile-dialog">
        <ul className="kd-config-rows">
          {choices.map((c, i) => (
            <li key={i}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="radio"
                  name="reconcile-pick"
                  value={i}
                  checked={pickIdx === i}
                  onChange={() => setPickIdx(i)}
                  data-testid={`reconcile-choice-${i}`}
                />
                <span>{c.label}</span>
              </label>
            </li>
          ))}
        </ul>
        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Button
            variant="success"
            onClick={confirm}
            disabled={mutation.isPending}
            data-testid="reconcile-confirm"
          >
            {mutation.isPending ? 'Saving…' : 'Confirm'}
          </Button>
        </Dialog.Footer>
      </div>
    </Dialog>
  );
}
