// Removal modal — opened by the X / trashcan affordance on
// manual+temp roster rows (bishopric Roster, stake Roster, manager
// All Seats). Submits a `remove` request via the shared submit
// mutation. The roster page wraps this with a `pending-removal` badge
// once the request lands; the badge is computed by querying for any
// pending remove request against the seat's `member_canonical`.
//
// Auto seats render NO trashcan (they're LCR-managed); the rule that
// blocks remove submits against an auto-only seat is a UX guard, not
// a server-side gate (the request-completion Cloud Function plus the
// importer's "next run replaces it" semantics make the guard
// belt-and-braces).
//
// T-43 Phase B: the `grant` prop is required. Every caller knows the
// grant being removed (primary or duplicate) — AllSeats per-grant
// rows pass the matched grant; per-scope roster pages pass the
// grant they picked via `pickGrantForScope`. The submitted request
// carries `(scope, kindoo_site_id)` so `removeSeatOnRequestComplete`
// splices the exact entry; primary-row removes set
// `kindoo_site_id` to the seat's primary site (or `null` for home),
// which the trigger reads as "match the primary".

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Seat } from '@kindoo/shared';
import { removeRequestSchema, type RemoveRequestForm } from '../schemas';
import { useSubmitRequest } from '../hooks';
import { Dialog } from '../../../components/ui/Dialog';
import { Input } from '../../../components/ui/Input';
import { toast } from '../../../lib/store/toast';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface RemovalDialogGrant {
  /** Scope of the grant being removed. */
  scope: string;
  /**
   * Type of the specific grant (not the seat's primary type). Used by
   * `RemovalAffordance` to gate the Remove button on a per-grant
   * basis — a manual / temp duplicate under an auto primary stays
   * removable.
   */
  type: 'auto' | 'manual' | 'temp';
  /**
   * Kindoo site the grant lives on. `null` for home / legacy. When
   * populated, the submitted remove request carries `kindoo_site_id`
   * so the `removeSeatOnRequestComplete` trigger splices only the
   * matching duplicate.
   */
  kindoo_site_id: string | null;
}

export interface RemovalDialogProps {
  /** Seat being removed. Determines member identity. */
  seat: Seat | null;
  /** Open / close handle. Closing while pending cancels nothing. */
  onOpenChange: (next: boolean) => void;
  /** The grant being removed (scope + kindoo_site_id). */
  grant: RemovalDialogGrant;
}

export function RemovalDialog({ seat, onOpenChange, grant }: RemovalDialogProps) {
  const submit = useSubmitRequest();
  const form = useForm<RemoveRequestForm>({
    resolver: zodResolver(removeRequestSchema),
    defaultValues: { reason: '' },
  });
  const { register, handleSubmit, formState, reset } = form;

  if (!seat) return null;

  const onSubmit = handleSubmit(async (input) => {
    try {
      await submit.mutateAsync({
        type: 'remove',
        scope: grant.scope,
        member_email: seat.member_email,
        member_name: seat.member_name,
        reason: input.reason,
        comment: '',
        building_names: [],
        kindoo_site_id: grant.kindoo_site_id,
      });
      toast('Removal request submitted.', 'success');
      reset({ reason: '' });
      onOpenChange(false);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  return (
    <Dialog
      open={seat !== null}
      onOpenChange={onOpenChange}
      title={`Remove access for ${seat.member_email}?`}
      description="Submits a removal request. A Kindoo Manager reviews and completes it."
    >
      <form onSubmit={onSubmit} className="kd-wizard-form" data-testid="removal-dialog-form">
        <label>
          Reason
          <Input
            {...register('reason')}
            data-testid="removal-reason"
            placeholder="Why is access no longer needed?"
          />
        </label>
        {formState.errors.reason ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.reason.message}
          </p>
        ) : null}
        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Dialog.ConfirmButton
            type="submit"
            className="btn-danger"
            disabled={submit.isPending}
            data-testid="removal-confirm"
          >
            {submit.isPending ? 'Submitting…' : 'Submit removal'}
          </Dialog.ConfirmButton>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}
