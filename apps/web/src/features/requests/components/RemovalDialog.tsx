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
// T-43 Phase B: a Remove button on an AllSeats duplicate row passes
// the duplicate's `(scope, kindoo_site_id)` via the `grant` prop so
// the submitted request carries the field. Roster-page primary
// removes pass `grant` undefined / null and the request omits the
// field; the trigger preserves today's primary-only behaviour.

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
   * Kindoo site the grant lives on. `null` for home / legacy. When
   * the field is populated, the submitted remove request carries
   * `kindoo_site_id` so the `removeSeatOnRequestComplete` trigger
   * splices only the matching duplicate.
   */
  kindoo_site_id: string | null;
}

export interface RemovalDialogProps {
  /** Seat being removed. Determines member identity. */
  seat: Seat | null;
  /** Open / close handle. Closing while pending cancels nothing. */
  onOpenChange: (next: boolean) => void;
  /**
   * The grant being removed. When omitted, the dialog targets the
   * seat's primary grant by scope alone (today's behaviour). When
   * provided (Phase B duplicate-row remove), the submitted request
   * scopes to the grant's `(scope, kindoo_site_id)` so the trigger
   * splices only that entry.
   */
  grant?: RemovalDialogGrant;
}

export function RemovalDialog({ seat, onOpenChange, grant }: RemovalDialogProps) {
  const submit = useSubmitRequest();
  const form = useForm<RemoveRequestForm>({
    resolver: zodResolver(removeRequestSchema),
    defaultValues: { reason: '' },
  });
  const { register, handleSubmit, formState, reset } = form;

  if (!seat) return null;

  const targetScope = grant?.scope ?? seat.scope;
  const targetSiteId = grant?.kindoo_site_id ?? null;

  const onSubmit = handleSubmit(async (input) => {
    try {
      await submit.mutateAsync({
        type: 'remove',
        scope: targetScope,
        member_email: seat.member_email,
        member_name: seat.member_name,
        reason: input.reason,
        comment: '',
        building_names: [],
        // Phase B: stamp kindoo_site_id only when removing a
        // non-primary grant. Omitting on the primary path keeps the
        // legacy wire shape clean.
        ...(grant !== undefined ? { kindoo_site_id: targetSiteId } : {}),
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
