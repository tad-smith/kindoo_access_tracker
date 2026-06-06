// "Give Access To Stake Buildings" modal — opened by the manager-only
// per-row affordance on All Seats for a foreign-site-only member. Grants
// the member a stake-scope seat (home-site buildings) so they can badge
// into this stake's home buildings. The submission is an ordinary
// `add_manual` / `scope: 'stake'` request through the existing
// `useSubmitRequest` path; the backend's `markRequestComplete` callable
// resolves the seat slot — no client-side seat write here.
//
// Constraints vs the New Request form:
//   - A red banner at the top warns that the grant consumes a license.
//   - Scope is read-only "Stake" (not user-selectable).
//   - The building checklist is limited to home-site buildings (the
//     `filterBuildingsBySite(buildings, null)` set — stake scope is
//     locked to home per spec §15).
//   - Reason is a required free-text Input (NOT the CallingCombobox);
//     comment is optional.

import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Building, Seat } from '@kindoo/shared';
import { Dialog } from '../../../components/ui/Dialog';
import { Input } from '../../../components/ui/Input';
import { useSubmitRequest, useStakeBuildings } from '../hooks';
import { grantStakeAccessSchema, type GrantStakeAccessForm } from '../schemas';
import { filterBuildingsBySite } from '../../../lib/kindooSites';
import { toast } from '../../../lib/store/toast';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const BANNER_TEXT =
  'Giving this user access to these buildings will consume an additional Kindoo license.';

export interface GrantStakeAccessDialogProps {
  /** Member being granted access. `null` closes the dialog. */
  seat: Seat | null;
  /** Open / close handle from the parent affordance. */
  onOpenChange: (next: boolean) => void;
}

export function GrantStakeAccessDialog({ seat, onOpenChange }: GrantStakeAccessDialogProps) {
  const submit = useSubmitRequest();
  const buildingsResult = useStakeBuildings();
  const buildings = buildingsResult.data ?? [];

  // Stake scope is locked to the home site (`null`) per spec §15, so the
  // checklist shows only home-site buildings. Legacy buildings without
  // `kindoo_site_id` are treated as home.
  const homeBuildings = useMemo(() => filterBuildingsBySite(buildings, null), [buildings]);

  const form = useForm<GrantStakeAccessForm>({
    resolver: zodResolver(grantStakeAccessSchema),
    defaultValues: { reason: '', comment: '', building_names: [] },
  });
  const { register, handleSubmit, watch, setValue, formState, reset } = form;
  const watchedBuildings = watch('building_names') ?? [];

  if (!seat) return null;

  const onSubmit = handleSubmit(async (input) => {
    try {
      await submit.mutateAsync({
        type: 'add_manual',
        scope: 'stake',
        member_email: seat.member_email,
        member_name: seat.member_name,
        reason: input.reason,
        comment: input.comment,
        building_names: input.building_names,
      });
      toast('Stake access request submitted.', 'success');
      reset({ reason: '', comment: '', building_names: [] });
      onOpenChange(false);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  return (
    <Dialog
      open={seat !== null}
      onOpenChange={onOpenChange}
      title={`Give access to stake buildings — ${seat.member_name || seat.member_email}`}
      description={`Submits a stake-scope access request for ${seat.member_email}. A Kindoo Manager reviews and completes it.`}
    >
      <form
        onSubmit={onSubmit}
        className="kd-wizard-form"
        data-testid="grant-stake-access-dialog-form"
      >
        <p role="alert" className="kd-danger-banner" data-testid="grant-stake-access-banner">
          {BANNER_TEXT}
        </p>

        <label>
          Scope
          <Input
            type="text"
            value="Stake"
            readOnly
            disabled
            data-testid="grant-stake-access-scope"
          />
        </label>

        <label>
          Reason
          <span className="kd-required-marker"> (required)</span>
          <Input type="text" {...register('reason')} data-testid="grant-stake-access-reason" />
        </label>
        {formState.errors.reason ? (
          <p role="alert" className="kd-form-error" data-testid="grant-stake-access-reason-error">
            {formState.errors.reason.message}
          </p>
        ) : null}

        <fieldset className="kd-buildings-fieldset">
          <legend>
            Buildings <small>(home-site only — at least one required)</small>
          </legend>
          {homeBuildings.length === 0 ? (
            <p className="kd-empty-state" data-testid="grant-stake-access-buildings-empty">
              No home-site buildings configured.
            </p>
          ) : (
            <ul className="kd-checkbox-list">
              {homeBuildings.map((b: Building) => {
                const checked = watchedBuildings.includes(b.building_name);
                return (
                  <li key={b.building_id}>
                    <label>
                      <input
                        type="checkbox"
                        value={b.building_name}
                        checked={checked}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...watchedBuildings, b.building_name]
                            : watchedBuildings.filter((n) => n !== b.building_name);
                          setValue('building_names', next, {
                            shouldValidate: true,
                            shouldDirty: true,
                          });
                        }}
                        data-testid={`grant-stake-access-building-${b.building_id}`}
                      />{' '}
                      {b.building_name}
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
          Comment <small>(optional)</small>
          <Input type="text" {...register('comment')} data-testid="grant-stake-access-comment" />
        </label>

        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Dialog.ConfirmButton
            type="submit"
            disabled={submit.isPending || watchedBuildings.length === 0}
            data-testid="grant-stake-access-confirm"
          >
            {submit.isPending ? 'Submitting…' : 'Submit request'}
          </Dialog.ConfirmButton>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}
