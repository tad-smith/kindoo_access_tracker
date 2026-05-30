// Edit-seat request modal — opened by the per-row Edit affordance on
// roster pages (bishopric Roster, stake Roster, stake Ward Rosters,
// manager All Seats). Three sub-modes keyed off the seat being edited:
//
//   - `edit_auto` (ward-scope auto): buildings checklist only. Every
//     building currently granted to this person at this scope renders
//     pre-checked AND disabled (auto-primary `building_names` plus any
//     same-scope manual DuplicateGrant building_names). Operator can
//     only ADD extras from the ward's site catalogue; cannot remove
//     existing grants. Stake-scope auto seats never reach this dialog
//     (the affordance is hidden upstream — Church-granted access to
//     every stake building, nothing editable). Submit replaces the
//     auto-primary's `building_names` with the locked-auto set plus
//     additions; same-scope manual dups remain untouched.
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
import type { Building, Seat } from '@kindoo/shared';
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
 * Resolve which buildings render pre-checked AND disabled in the
 * `edit_auto` sub-mode. The locked set is the union of:
 *
 *   - the auto-primary seat's `building_names` (the importer seeded
 *     these from `ward.building_name`; prior edit_auto edits may have
 *     added to them), AND
 *   - any same-scope manual DuplicateGrant's `building_names` (a
 *     manager-added manual grant on the same scope appears as a
 *     collapsed contribution to the displayed buildings on AllSeats /
 *     roster pages; the edit dialog mirrors that union so the user
 *     sees the same set they see on the row).
 *
 * Locking the full union keeps this dialog honest about its narrow
 * remit: the auto-primary `edit_auto` request CAN add buildings to the
 * primary's `building_names`, but it cannot remove anything from the
 * primary AND it cannot touch the manual dup at all. Allowing the
 * user to uncheck a manual-dup building here would no-op silently —
 * confusing. Future work could decompose the submit into multi-request
 * coordination (edit_auto + edit_manual / remove) to actually let the
 * user prune manual-dup buildings from this dialog; until then the
 * conservative lock is the honest UX.
 *
 * Stake-scope auto seats never reach the dialog (`canEditSeat` hides
 * the affordance — Church-granted access to every stake building,
 * nothing to edit). Returns empty for any non-ward-auto seat as a
 * defense in depth.
 */
function lockedAutoBuildingsFor(seat: Seat): string[] {
  if (seat.type !== 'auto' || seat.scope === 'stake') return [];
  const fromPrimary = seat.building_names;
  const fromSameScopeManualDups = (seat.duplicate_grants ?? [])
    .filter((d) => d.scope === seat.scope && d.type === 'manual')
    .flatMap((d) => d.building_names ?? []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...fromPrimary, ...fromSameScopeManualDups]) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
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
  // scope manual / temp seats see home buildings only (stake-scope auto
  // seats never reach this dialog — the affordance is hidden upstream).
  // Legacy buildings without `kindoo_site_id` are treated as home.
  const visibleBuildings = useMemo(
    () => filterBuildingsBySite(buildings, siteIdForScope(seat?.scope ?? '', wards)),
    [buildings, wards, seat?.scope],
  );

  // Forced-checked buildings — applied to the rendered checkbox list as
  // both `checked` AND `disabled`. Empty for manual/temp seats. Clamped
  // to the visible set so a locked building hidden by the site filter
  // (a legacy auto seat whose ward.building_name disagrees with
  // ward.kindoo_site_id) is silently dropped from the locked set rather
  // than rendered as an invisible-and-uncheckable pre-check.
  const lockedBuildings = useMemo(() => {
    const raw = seat ? lockedAutoBuildingsFor(seat) : [];
    const visibleNames = new Set(visibleBuildings.map((b) => b.building_name));
    return raw.filter((n) => visibleNames.has(n));
  }, [seat, visibleBuildings]);

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
    // Defense-in-depth: re-apply the locked-buildings union so a
    // hand-tampered DOM cannot drop a currently-granted building from
    // an `edit_auto` submission. The disabled checkbox already enforces
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
                // Tooltip on the disabled checkbox + a visible note next
                // to the label. Auto seats lock both the calling-template
                // buildings AND any same-scope manual DuplicateGrant
                // buildings (collapsed into the displayed set on
                // AllSeats / rosters); the note copy matches.
                const lockedTooltip = isLocked
                  ? 'Already granted to this user at this scope. Add new buildings here; ' +
                    'remove existing access via a separate request.'
                  : undefined;
                return (
                  <li key={b.building_id}>
                    <label {...(lockedTooltip ? { title: lockedTooltip } : {})}>
                      <input
                        type="checkbox"
                        value={b.building_name}
                        checked={checked}
                        disabled={isLocked}
                        {...(lockedTooltip ? { title: lockedTooltip } : {})}
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
                          (already granted — locked)
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
            disabled={submit.isPending || watchedBuildings.length === 0}
            data-testid="edit-seat-confirm"
          >
            {submit.isPending ? 'Submitting…' : 'Submit edit'}
          </Dialog.ConfirmButton>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}
