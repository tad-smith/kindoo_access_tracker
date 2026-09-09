// Edit-seat request modal — opened by the per-row Edit affordance on
// roster pages (bishopric Roster, stake Roster, stake Ward Rosters).
// Three sub-modes keyed off the seat being edited:
//
//   - `edit_auto` (ward-scope auto): buildings checklist only. Every
//     building currently granted to this person at this scope renders
//     pre-checked; the ones the operator cannot uncheck are disabled —
//     the auto-primary's Church-granted buildings (per
//     `seat.church_granted_buildings`; unknown provenance, i.e. absent /
//     `null`, locks the whole primary — today's behaviour) plus any
//     same-scope non-auto DuplicateGrant's `building_names` (manual or
//     temp). A manager-added building on the primary — one the Church
//     did NOT grant — is checked but NOT disabled, so it can be
//     unchecked and actually removed. Stake-scope auto seats never
//     reach this dialog (the affordance is hidden upstream —
//     Church-granted access to every stake building, nothing editable).
//     Submit replaces the auto-primary's `building_names` with
//     `churchLockedBuildings ∪ operator's checked set`; same-scope
//     non-auto dups remain untouched. The dup buildings render visually
//     locked but are NOT included in the wire body — see
//     `churchLockedBuildingsFor` for the data-corruption rationale.
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
//
// Limited app access (D25). `canEditSeat` already hides the Edit
// affordance on auto and manual seats for a principal carrying
// `stakes[sid].limited`, so `edit_temp` is the only sub-mode a limited
// user can reach here — there is no auto / manual handling to add. What
// this dialog adds for that user, mirroring `NewRequestForm`:
//   - the ≤90-day temp-window cap, stated as helper text and enforced
//     by `makeEditSeatSchema({ limited })` on `end_date`.
//     `useLiveTempWindowCheck` revalidates `end_date` whenever either
//     date changes, so an over-long window reports itself before Submit
//     (and on open, since an existing seat arrives with both dates
//     already filled). Every other field keeps submit-time validation —
//     the form's global mode is untouched;
//   - at ward scope, the buildings checklist collapses to a read-only
//     row naming the ward's own building, with `building_names` forced
//     to exactly that name (the rules' `limitedWardBuildingOk` equality
//     check). A ward with no building renders a blocked message and
//     leaves Submit disabled.
// Stake scope keeps the normal checklist, and a full user's dialog is
// unchanged.

import { useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Building, Seat } from '@kindoo/shared';
import { CallingCombobox } from './CallingCombobox';
import { Dialog } from '../../../components/ui/Dialog';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { useSubmitRequest, useStakeBuildings, useStakeWards } from '../hooks';
import {
  useOrganizations,
  sortOrganizations,
  NO_ORGANIZATION_LABEL,
} from '../../organizations/hooks';
import {
  LIMITED_TEMP_WINDOW_MESSAGE,
  defaultBuildingsForScope,
  makeEditSeatSchema,
  type EditSeatForm,
} from '../schemas';
import { isLimitedInStake } from '../scopeOptions';
import { useLiveTempWindowCheck } from '../liveTempWindow';
import { filterBuildingsBySite, siteIdForScope } from '../../../lib/kindooSites';
import { usePrincipal } from '../../../lib/principal';
import { useActiveStake } from '../../../lib/useActiveStake';
import { toast } from '../../../lib/store/toast';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Buildings on the auto-primary slot that submit must NEVER drop — the
 * Church-granted subset, per `seat.church_granted_buildings` (tri-state:
 * absent/`null` means "never observed", so it reads as "assume all of
 * `building_names` is Church-granted" and the whole primary stays
 * locked, matching today's behaviour until a seat has been stamped).
 * The `markRequestComplete` callable applies `building_names` from the
 * request as a REPLACEMENT for the auto-primary's `seat.building_names`;
 * therefore the submit MUST union this Church-granted set with the
 * operator's checked set, and nothing else. A manager-added (non-Church)
 * building is deliberately NOT in this set — that's what makes it
 * droppable when the operator unchecks it. Conflating dup (manual or
 * temp) buildings into this set would cause data corruption: the
 * `edit_auto` write would absorb the dup buildings onto the
 * auto-primary slot AND the same-scope DuplicateGrant would remain in
 * place, leaving the user double-credited on display + double-
 * provisioned on Kindoo.
 *
 * Stake-scope auto seats never reach the dialog (`canEditSeat` hides
 * the affordance — Church-granted access to every stake building,
 * nothing to edit). Returns empty for any non-ward-auto seat as a
 * defense in depth.
 */
/**
 * The auto-primary's OWN buildings, Church-granted or manager-added.
 *
 * Distinct from `churchLockedBuildingsFor`, and the two are not
 * interchangeable. This set answers "which buildings does the primary
 * grant hold?" and is used ONLY to decide which visually-locked names
 * are dup-ONLY (and must therefore stay out of an `edit_auto` wire
 * body). Subtracting the Church subset instead would classify a
 * manager-added primary building that ALSO sits on a same-scope dup as
 * dup-only, dropping it from the primary on submit while its checkbox
 * rendered checked and disabled — a silent destructive edit, and one
 * Sync cannot see afterwards because the roster row's building set is
 * the union of both grants and still matches Kindoo.
 */
function primaryOwnedBuildingsFor(seat: Seat): string[] {
  if (seat.type !== 'auto' || seat.scope === 'stake') return [];
  return [...seat.building_names];
}

function churchLockedBuildingsFor(seat: Seat): string[] {
  if (seat.type !== 'auto' || seat.scope === 'stake') return [];
  return seat.church_granted_buildings != null
    ? seat.building_names.filter((n) => seat.church_granted_buildings?.includes(n))
    : [...seat.building_names];
}

/**
 * Buildings that render pre-checked AND disabled in the `edit_auto`
 * sub-mode. The visual lock spans:
 *
 *   - the auto-primary seat's Church-granted buildings — per
 *     `seat.church_granted_buildings` when non-null (TRI-STATE: absent
 *     / `null` means "never observed", so it locks the WHOLE of
 *     `building_names`, matching today's behaviour, not "none locked"),
 *     AND
 *   - any same-scope non-auto DuplicateGrant's `building_names` —
 *     manual OR temp. Both kinds get collapsed into the displayed
 *     buildings on AllSeats / roster pages (PR #166); the edit dialog
 *     mirrors that union so the user sees the same set they see on
 *     the row. Auto DuplicateGrants are excluded because a same-scope
 *     auto dup would shadow the auto primary's slot (never legitimate;
 *     defense-in-depth filter).
 *
 * A manager-added (non-Church) building on the primary is NOT in this
 * set once `church_granted_buildings` is known — it renders checked but
 * enabled, so the operator can uncheck and remove it. The submit-side
 * still does NOT include the dup buildings — see
 * `churchLockedBuildingsFor` above for the load-bearing rationale.
 */
function lockedAutoBuildingsFor(seat: Seat): string[] {
  if (seat.type !== 'auto' || seat.scope === 'stake') return [];
  const fromPrimary =
    seat.church_granted_buildings != null
      ? seat.building_names.filter((n) => seat.church_granted_buildings?.includes(n))
      : seat.building_names;
  const fromSameScopeNonAutoDups = (seat.duplicate_grants ?? [])
    .filter((d) => d.scope === seat.scope && d.type !== 'auto')
    .flatMap((d) => d.building_names ?? []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...fromPrimary, ...fromSameScopeNonAutoDups]) {
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
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const wardsResult = useStakeWards();
  const buildingsResult = useStakeBuildings();
  const wards = wardsResult.data ?? [];
  const buildings = buildingsResult.data ?? [];

  // Limited app access (D25). Only `edit_temp` is reachable — the
  // affordance gate upstream guarantees it — so the flag drives the
  // window cap and the ward-scope building lock, nothing else.
  const limited = activeStakeId !== null && isLimitedInStake(principal, activeStakeId);
  const wardLock = limited && seat !== null && seat.scope !== 'stake' && seat.scope !== '';
  // The one building a locked ward-scope edit may carry. `null` when the
  // ward has no building configured; the dialog then blocks with a
  // message and Submit stays disabled on the empty selection.
  const lockedWardBuilding = useMemo(
    () =>
      wardLock && seat ? (defaultBuildingsForScope(seat.scope, wards, buildings)[0] ?? null) : null,
    [wardLock, seat, wards, buildings],
  );

  // Organizations catalogue — the optional org selector that appears
  // only at stake scope on edit_manual / edit_temp. Empty until
  // hydrated; `sortOrganizations` tolerates undefined.
  const organizationsResult = useOrganizations();
  const sortedOrganizations = useMemo(
    () => sortOrganizations(organizationsResult.data),
    [organizationsResult.data],
  );

  // Visible buildings — site-filtered by the seat's scope per spec §15
  // Phase 2. Ward-scope seats see only their site's buildings; stake-
  // scope manual / temp seats see home buildings only (stake-scope auto
  // seats never reach this dialog — the affordance is hidden upstream).
  // Legacy buildings without `kindoo_site_id` are treated as home.
  const visibleBuildings = useMemo(
    () => filterBuildingsBySite(buildings, siteIdForScope(seat?.scope ?? '', wards, buildings)),
    [buildings, wards, seat?.scope],
  );

  // Forced-checked buildings — applied to the rendered checkbox list as
  // both `checked` AND `disabled`. Empty for manual/temp seats. Clamped
  // to the visible set so a locked building hidden by the site filter
  // (a legacy auto seat whose building is on a different site) is
  // silently dropped from the locked set rather than rendered as an
  // invisible-and-uncheckable pre-check. The VISUAL lock spans the
  // auto-primary + same-scope non-auto dup union — see
  // `lockedAutoBuildingsFor` for why.
  const lockedBuildings = useMemo(() => {
    const raw = seat ? lockedAutoBuildingsFor(seat) : [];
    const visibleNames = new Set(visibleBuildings.map((b) => b.building_name));
    return raw.filter((n) => visibleNames.has(n));
  }, [seat, visibleBuildings]);

  // Submit-side Church-locked set — the subset of the visual lock that
  // the `edit_auto` request must never drop from the wire body (a
  // manager-added, non-Church building is deliberately excluded here so
  // it CAN be dropped). NEVER includes dup (manual or temp) buildings
  // (see `churchLockedBuildingsFor` for the data-corruption rationale).
  // Also clamped to the visible set so a hidden auto-primary building
  // doesn't ship on submit.
  const churchLockedBuildings = useMemo(() => {
    const raw = seat ? churchLockedBuildingsFor(seat) : [];
    const visibleNames = new Set(visibleBuildings.map((b) => b.building_name));
    return raw.filter((n) => visibleNames.has(n));
  }, [seat, visibleBuildings]);

  // The primary grant's own buildings, clamped to visible. Only input to
  // the dup-only classification below; never unioned into the wire body
  // (an unchecked manager-added building must actually leave).
  const primaryOwnedBuildings = useMemo(() => {
    const raw = seat ? primaryOwnedBuildingsFor(seat) : [];
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
        organization_id: null,
      };
    }
    const type: EditSeatForm['type'] =
      seat.type === 'auto' ? 'edit_auto' : seat.type === 'temp' ? 'edit_temp' : 'edit_manual';
    const visibleNames = new Set(visibleBuildings.map((b) => b.building_name));
    return {
      type,
      reason: seat.reason ?? '',
      comment: '',
      // Limited + ward scope: force exactly the ward's building rather
      // than the seat's current set, matching the rules' equality check.
      // No checkboxes render in that mode, so this is the only writer.
      building_names: wardLock
        ? lockedWardBuilding
          ? [lockedWardBuilding]
          : []
        : seat.building_names.filter((n) => visibleNames.has(n)),
      start_date: seat.start_date ?? '',
      end_date: seat.end_date ?? '',
      // Pre-fill the org selector from the seat (stake scope only; the
      // selector renders only there). `edit_auto` is forbidden at stake,
      // so an auto seat never reaches the selector.
      organization_id: seat.organization_id ?? null,
    };
  }, [seat, visibleBuildings, wardLock, lockedWardBuilding]);

  const schema = useMemo(() => makeEditSeatSchema({ limited }), [limited]);

  const form = useForm<EditSeatForm>({
    resolver: zodResolver(schema),
    defaultValues: initial,
    values: initial,
  });
  const { register, handleSubmit, watch, setValue, formState, control, reset, trigger } = form;
  const watchedBuildings = watch('building_names') ?? [];
  const watchedOrganizationId = watch('organization_id') ?? null;
  const watchedStartDate = watch('start_date');
  const watchedEndDate = watch('end_date');

  // Limited + edit_temp only: report the ≤90-day cap as soon as both
  // dates hold a date rather than waiting for Submit (D25). `initial.type`
  // is `edit_manual` while `seat` is null, so this stays inert then.
  useLiveTempWindowCheck({
    enabled: limited && initial.type === 'edit_temp',
    startDate: watchedStartDate,
    endDate: watchedEndDate,
    triggerEndDate: trigger,
  });

  if (!seat) return null;
  const editType = initial.type;
  // The org selector is meaningful only at stake scope, and only for
  // edit_manual / edit_temp (edit_auto is forbidden at stake — it never
  // reaches this dialog).
  const showOrgSelector = seat.scope === 'stake' && editType !== 'edit_auto';

  const onSubmit = handleSubmit(async (input) => {
    if (!seat) return;
    // `edit_auto` submit-body construction. The wire shape is the
    // REPLACEMENT for the auto-primary's `building_names`; the backend
    // does not touch same-scope DuplicateGrants in this path.
    // Therefore:
    //   - Union in `churchLockedBuildings` (the auto-primary's
    //     Church-granted set, clamped to visible) so the auto-primary
    //     never loses a Church grant. Disabled checkboxes enforce this
    //     in the UI; this is the second layer against a hand-tampered
    //     DOM. A manager-added building is NOT in this set, so an
    //     unchecked one is actually dropped.
    //   - Filter out anything from `input.building_names` that's in the
    //     visual lock but NOT in the Church-locked set — i.e., reject
    //     any dup (manual or temp) building. In practice
    //     `watchedBuildings` is seeded from `seat.building_names`
    //     (auto-primary only) and the user can only add non-locked
    //     buildings, so dup-only buildings never slip in via the UI;
    //     this is belt-and-braces against the rare race where a dup
    //     was added between the dialog open and submit.
    const dupOnlyBuildings = new Set(
      lockedBuildings.filter((n) => !primaryOwnedBuildings.includes(n)),
    );
    const finalBuildings =
      editType === 'edit_auto'
        ? Array.from(
            new Set([
              ...churchLockedBuildings,
              ...input.building_names.filter((n) => !dupOnlyBuildings.has(n)),
            ]),
          )
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
        // Org selector value, only when it's actually shown. The submit
        // hook drops it for non-stake scope; passing it unconditionally
        // when shown keeps the wire body correct for stake edits.
        ...(showOrgSelector ? { organization_id: input.organization_id ?? null } : {}),
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
      // Every field here arrives pre-filled from the seat, so Radix's
      // default mount focus landed on `reason` and selected its value —
      // the dialog opened with the calling highlighted and one keystroke
      // from being replaced (B-28). Focus goes to the dialog container
      // instead, which is what keeps the focus trap and the screen
      // reader announcement intact. Escape is unaffected either way —
      // Radix binds it on the document, not on the focused node.
      autoFocusFirstField={false}
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
                      wards={wards}
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
            {limited ? (
              <p className="kd-form-hint" data-testid="edit-seat-temp-cap-hint">
                {LIMITED_TEMP_WINDOW_MESSAGE}
              </p>
            ) : null}
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
          {wardLock ? (
            // Limited + ward scope (D25): the grant is locked to the
            // ward's own building, so there is nothing to tick.
            lockedWardBuilding ? (
              <div className="kd-buildings-locked-row" data-testid="edit-seat-locked-building">
                <span className="kd-buildings-header-row">
                  <span className="kd-buildings-header-values">{lockedWardBuilding}</span>
                </span>
                <small className="kd-form-hint">
                  Temporary access is limited to your ward&apos;s building.
                </small>
              </div>
            ) : (
              <p
                className="kd-form-error"
                role="alert"
                data-testid="edit-seat-locked-building-missing"
              >
                This ward has no building configured, so an edit can&apos;t be submitted yet. Ask
                your Kindoo Manager to set the ward&apos;s building under Configuration.
              </p>
            )
          ) : buildings.length === 0 ? (
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
                // Only claim a Church grant when one was actually
                // OBSERVED. With `church_granted_buildings` absent the
                // whole primary locks (the safe direction), but the
                // reason is "SBA hasn't looked yet", not "the Church
                // granted this" — and on an unstamped seat some of these
                // buildings are manager-added. Asserting Church
                // provenance there would be a claim we have no
                // observation for, shown to every user before the first
                // Sync sweep.
                const provenanceObserved = seat.church_granted_buildings != null;
                const isChurchLocked =
                  provenanceObserved && churchLockedBuildings.includes(b.building_name);
                // A locked building NOT on the primary is dup-only, and the dup
                // wording stays right for it regardless of provenance.
                const isUnobservedLock =
                  isLocked &&
                  !provenanceObserved &&
                  primaryOwnedBuildings.includes(b.building_name);
                const checked = isLocked || watchedBuildings.includes(b.building_name);
                // Tooltip on the disabled checkbox + a visible note next
                // to the label. Two reasons a building can be locked, with
                // different copy: the auto-primary's Church-granted subset
                // (SBA can't touch it, full stop) vs a same-scope manual /
                // temp DuplicateGrant (a separate grant edit_auto can't
                // reach, but removable via its own request).
                const lockedTooltip = isLocked
                  ? isChurchLocked
                    ? 'The Church Access Automation grants this one directly; SBA cannot revoke it.'
                    : isUnobservedLock
                      ? 'SBA has not yet recorded which of this seat\u2019s buildings come from ' +
                        'the Church, so none can be removed. The next Sync records it.'
                      : 'Already granted to this user at this scope. Add new buildings here; ' +
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
                          (
                          {isChurchLocked
                            ? 'granted by the Church — locked'
                            : isUnobservedLock
                              ? 'locked until the next Sync'
                              : 'already granted — locked'}
                          )
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

        {showOrgSelector ? (
          <label>
            Organization
            <Select
              value={watchedOrganizationId ?? '__none__'}
              onChange={(e) => {
                const next = e.target.value;
                setValue('organization_id', next === '__none__' ? null : next, {
                  shouldDirty: true,
                });
              }}
              data-testid="edit-seat-organization"
            >
              <option value="__none__">{NO_ORGANIZATION_LABEL}</option>
              {sortedOrganizations.map((o) => (
                <option key={o.organization_id} value={o.organization_id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </label>
        ) : null}

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
