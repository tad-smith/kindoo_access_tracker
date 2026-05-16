// Edit-seat request modal — opened by the per-row Edit affordance on
// roster pages (bishopric Roster, stake Roster, stake Ward Rosters,
// manager All Seats). Three sub-modes keyed off the seat being edited:
//
//   - `edit_auto` (ward-scope auto): buildings checklist only. The
//     "template-allowed" buildings (currently == the ward's
//     `building_name`, the importer's seed for auto seats) render
//     pre-checked AND disabled per Policy B (spec §6.1). Operator can
//     only ADD extras; cannot remove template buildings. Stake-auto
//     seats never reach this dialog (Policy 1 — the affordance is
//     hidden upstream).
//
//   - `edit_manual`: `reason` (the manual seat's calling name; uses
//     the same `CallingCombobox` typeahead the New Request form uses)
//     + buildings checklist. All checkboxes editable.
//
//   - `edit_temp`: `reason` (free-text, no typeahead — temp seats
//     don't bind to the calling catalogue) + buildings + start_date +
//     end_date. All four fields operator-editable; dates use the same
//     `<input type="date">` primitive as the New Request temp form.
//
// Submit composes the appropriate `edit_*` request via the existing
// `useSubmitRequest` mutation. The backend's `markRequestComplete`
// callable resolves the seat slot and applies the field replacement;
// no client-side seat write here. Closes on success + toasts.

import { useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Building, Seat, Ward } from '@kindoo/shared';
import { CallingCombobox } from './CallingCombobox';
import { Dialog } from '../../../components/ui/Dialog';
import { Input } from '../../../components/ui/Input';
import { useSubmitRequest, useStakeBuildings, useStakeWards } from '../hooks';
import { editSeatSchema, type EditSeatForm } from '../schemas';
import { filterBuildingsBySite, siteIdForScope } from '../../../lib/kindooSites';
import { toast } from '../../../lib/store/toast';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve which buildings are "template / Church-managed" for an auto
 * seat — these render pre-checked AND disabled per Policy B. The
 * importer seeds an auto seat's `building_names` from the ward's
 * `building_name` (a single building); anything beyond that on the
 * seat today is an operator-added extra from a prior edit. The
 * returned list is therefore the ward's default building, or empty
 * when the ward has no building bound or the ward isn't in the
 * catalogue. Stake-scope auto seats never reach the dialog (Policy 1).
 */
function templateBuildingsFor(seat: Seat, wards: readonly Ward[]): string[] {
  if (seat.type !== 'auto' || seat.scope === 'stake') return [];
  const ward = wards.find((w) => w.ward_code === seat.scope);
  if (!ward || !ward.building_name) return [];
  return [ward.building_name];
}

export interface EditSeatDialogProps {
  /** Seat being edited. `null` closes the dialog. */
  seat: Seat | null;
  /** Open / close handle from the parent affordance. */
  onOpenChange: (next: boolean) => void;
}

export function EditSeatDialog({ seat, onOpenChange }: EditSeatDialogProps) {
  const submit = useSubmitRequest();
  const wardsResult = useStakeWards();
  const buildingsResult = useStakeBuildings();
  const wards = wardsResult.data ?? [];
  const buildings = buildingsResult.data ?? [];

  // Visible buildings — site-filtered by the seat's scope per spec §15
  // Phase 2. Ward-scope seats see only their site's buildings; stake-
  // scope (which only auto seats reach via this dialog's templateBuildings
  // path, see Policy 1) sees home buildings only. Legacy buildings
  // without `kindoo_site_id` are treated as home.
  const visibleBuildings = useMemo(
    () => filterBuildingsBySite(buildings, siteIdForScope(seat?.scope ?? '', wards)),
    [buildings, wards, seat?.scope],
  );

  // Forced-checked buildings — applied to the rendered checkbox list as
  // both `checked` AND `disabled`. Empty for manual/temp seats. Clamped
  // to the visible set so a template building hidden by the site filter
  // (a legacy auto seat whose ward.building_name disagrees with
  // ward.kindoo_site_id) is silently dropped from the locked set rather
  // than rendered as an invisible-and-uncheckable pre-check.
  const lockedBuildings = useMemo(() => {
    const raw = seat ? templateBuildingsFor(seat, wards) : [];
    const visibleNames = new Set(visibleBuildings.map((b) => b.building_name));
    return raw.filter((n) => visibleNames.has(n));
  }, [seat, wards, visibleBuildings]);

  // Initial form values are derived from the seat. `values` (not
  // `defaultValues`) re-syncs when the prop changes, so opening for a
  // different seat starts pre-populated correctly. Comment always
  // starts empty — the dialog opens to compose a fresh edit request,
  // not to resume an existing draft.
  //
  // Pre-checked buildings are clamped to the visible (site-filtered)
  // set: anything outside the visible set is dropped silently so the
  // user can only check / uncheck what they can see. Without this clamp
  // a legacy seat whose `building_names` overlaps a hidden home building
  // would ship that building back on submit with no way for the user to
  // notice.
  const initial: EditSeatForm = useMemo(() => {
    if (!seat) {
      return {
        type: 'edit_manual',
        reason: '',
        comment: '',
        building_names: [],
        start_date: '',
        end_date: '',
      };
    }
    const type: EditSeatForm['type'] =
      seat.type === 'auto' ? 'edit_auto' : seat.type === 'temp' ? 'edit_temp' : 'edit_manual';
    const visibleNames = new Set(visibleBuildings.map((b) => b.building_name));
    return {
      type,
      reason: seat.reason ?? '',
      comment: '',
      building_names: seat.building_names.filter((n) => visibleNames.has(n)),
      start_date: seat.start_date ?? '',
      end_date: seat.end_date ?? '',
    };
  }, [seat, visibleBuildings]);

  const form = useForm<EditSeatForm>({
    resolver: zodResolver(editSeatSchema),
    defaultValues: initial,
    values: initial,
  });
  const { register, handleSubmit, watch, setValue, formState, control, reset } = form;
  const watchedBuildings = watch('building_names') ?? [];

  if (!seat) return null;
  const editType = initial.type;

  const onSubmit = handleSubmit(async (input) => {
    if (!seat) return;
    // Defense-in-depth: re-apply the locked-template-buildings union so
    // a hand-tampered DOM cannot drop a Church-managed building from an
    // `edit_auto` submission. The disabled checkbox already enforces
    // this; this is the second layer.
    const finalBuildings =
      editType === 'edit_auto'
        ? Array.from(new Set([...lockedBuildings, ...input.building_names]))
        : input.building_names;
    try {
      await submit.mutateAsync({
        type: editType,
        scope: seat.scope,
        member_email: seat.member_email,
        member_name: seat.member_name,
        // Auto seats keep their calling-derived `reason` (== absent); we
        // pass empty string and the hook trims it out. Manual/temp edits
        // forward the operator's typed value.
        reason: editType === 'edit_auto' ? '' : input.reason,
        comment: input.comment,
        building_names: finalBuildings,
        ...(editType === 'edit_temp'
          ? { start_date: input.start_date, end_date: input.end_date }
          : {}),
      });
      toast('Edit request submitted.', 'success');
      reset(initial);
      onOpenChange(false);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  const title =
    editType === 'edit_auto'
      ? `Edit auto seat — ${seat.member_name || seat.member_email}`
      : editType === 'edit_temp'
        ? `Edit temp seat — ${seat.member_name || seat.member_email}`
        : `Edit manual seat — ${seat.member_name || seat.member_email}`;

  return (
    <Dialog
      open={seat !== null}
      onOpenChange={onOpenChange}
      title={title}
      description={`Submits an edit request for ${seat.member_email}. A Kindoo Manager reviews and completes it.`}
    >
      <form onSubmit={onSubmit} className="kd-wizard-form" data-testid="edit-seat-dialog-form">
        {editType !== 'edit_auto' ? (
          <>
            <label>
              {editType === 'edit_temp' ? 'Reason' : 'Calling'}
              <Controller
                control={control}
                name="reason"
                render={({ field }) =>
                  editType === 'edit_temp' ? (
                    <Input
                      type="text"
                      autoComplete="off"
                      value={field.value ?? ''}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                      data-testid="edit-seat-reason"
                    />
                  ) : (
                    <CallingCombobox
                      value={field.value ?? ''}
                      onChange={field.onChange}
                      scope={seat.scope}
                      name={field.name}
                      data-testid="edit-seat-reason"
                    />
                  )
                }
              />
            </label>
            {formState.errors.reason ? (
              <p role="alert" className="kd-form-error">
                {formState.errors.reason.message}
              </p>
            ) : null}
          </>
        ) : null}

        {editType === 'edit_temp' ? (
          <div className="kd-temp-fields">
            <label>
              Start date
              <Input type="date" {...register('start_date')} data-testid="edit-seat-start-date" />
            </label>
            {formState.errors.start_date ? (
              <p role="alert" className="kd-form-error">
                {formState.errors.start_date.message}
              </p>
            ) : null}
            <label>
              End date
              <Input type="date" {...register('end_date')} data-testid="edit-seat-end-date" />
            </label>
            {formState.errors.end_date ? (
              <p role="alert" className="kd-form-error">
                {formState.errors.end_date.message}
              </p>
            ) : null}
          </div>
        ) : null}

        <fieldset className="kd-buildings-fieldset">
          <legend>
            Buildings <small>(at least one required)</small>
          </legend>
          {buildings.length === 0 ? (
            <p className="kd-empty-state">No buildings configured.</p>
          ) : visibleBuildings.length === 0 ? (
            // Site-filter narrowed the catalogue to zero (foreign-site
            // seat with no foreign building yet, etc). Block the dialog
            // with an explicit message rather than an empty list.
            <p className="kd-empty-state" data-testid="edit-seat-buildings-empty-for-scope">
              No buildings are available for this scope. Ask a Kindoo Manager to assign a building
              to this Kindoo site via Configuration.
            </p>
          ) : (
            <ul className="kd-checkbox-list">
              {visibleBuildings.map((b: Building) => {
                const isLocked = lockedBuildings.includes(b.building_name);
                const checked = isLocked || watchedBuildings.includes(b.building_name);
                return (
                  <li key={b.building_id}>
                    <label>
                      <input
                        type="checkbox"
                        value={b.building_name}
                        checked={checked}
                        disabled={isLocked}
                        onChange={(e) => {
                          if (isLocked) return;
                          const next = e.target.checked
                            ? [...watchedBuildings, b.building_name]
                            : watchedBuildings.filter((n) => n !== b.building_name);
                          setValue('building_names', next, {
                            shouldValidate: true,
                            shouldDirty: true,
                          });
                        }}
                        data-testid={`edit-seat-building-${b.building_id}`}
                      />{' '}
                      {b.building_name}
                      {isLocked ? (
                        <small
                          className="kd-buildings-locked-note"
                          data-testid={`edit-seat-building-locked-${b.building_id}`}
                        >
                          {' '}
                          (from calling template — Church-managed)
                        </small>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {formState.errors.building_names ? (
            <p role="alert" className="kd-form-error">
              {formState.errors.building_names.message}
            </p>
          ) : null}
        </fieldset>

        <label>
          Comment
          <span className="kd-required-marker" data-testid="edit-seat-comment-marker">
            {' '}
            (required)
          </span>
          <Input type="text" {...register('comment')} data-testid="edit-seat-comment" />
        </label>
        {formState.errors.comment ? (
          <p role="alert" className="kd-form-error" data-testid="edit-seat-comment-error">
            {formState.errors.comment.message}
          </p>
        ) : null}

        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Dialog.ConfirmButton
            type="submit"
            disabled={submit.isPending}
            data-testid="edit-seat-confirm"
          >
            {submit.isPending ? 'Submitting…' : 'Submit edit'}
          </Dialog.ConfirmButton>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}
