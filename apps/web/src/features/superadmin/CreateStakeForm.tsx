// Create Stake form. Inline section on `/superadmin/stakes` (spec §5.4)
// that lets a platform superadmin provision a new stake.
//
// Submit dispatches the `createStake` callable (via `useCreateStake`).
// Soft-failure envelopes from the callable (`{success:false, error}`)
// are surfaced as inline field errors against the field that owns the
// problem; hard `HttpsError`s (caught from the SDK) become a toast.
// `{success:true}` clears the form, fires a success toast, and the
// hook's `onSuccess` invalidates the stakes query so the list re-
// renders with the new row.
//
// Slug preview: the doc ID slug is derived from the typed stake name
// using the same `buildingSlug` helper the callable applies. We show
// it under the name field so the operator can sanity-check the
// resulting URL before submitting.

import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { buildingSlug, type CreateStakeError } from '@kindoo/shared';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { toast } from '../../lib/store/toast';
import { useCreateStake } from './hooks';
import { createStakeSchema, DEFAULT_TIMEZONE, type CreateStakeForm } from './schemas';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Map a soft-failure error code to a human-friendly message and the
 * field it should attach to. `invalid_slug` and `slug_collision` both
 * surface against `stake_name` since that's the input the operator
 * controls; `name_required` and `email_required` mirror their inputs.
 */
function softFailToFieldError(error: CreateStakeError): {
  field: keyof CreateStakeForm;
  message: string;
} {
  switch (error) {
    case 'name_required':
      return { field: 'stake_name', message: 'Stake name is required.' };
    case 'email_required':
      return {
        field: 'bootstrap_admin_email',
        message: 'Bootstrap admin email is required.',
      };
    case 'invalid_slug':
      return {
        field: 'stake_name',
        message:
          'Stake name contains no letters or digits — pick a name that produces a valid slug.',
      };
    case 'slug_collision':
      return {
        field: 'stake_name',
        message: 'A stake with that slug already exists. Pick a different name.',
      };
  }
}

export function CreateStakeForm() {
  const mutation = useCreateStake();

  const form = useForm<CreateStakeForm>({
    resolver: zodResolver(createStakeSchema),
    defaultValues: {
      stake_name: '',
      bootstrap_admin_email: '',
      timezone: DEFAULT_TIMEZONE,
    },
  });
  const { register, handleSubmit, watch, reset, setError, formState } = form;

  const watchedName = watch('stake_name') ?? '';
  // Mirror the callable's slug rule. Reused at render so the preview
  // stays in lockstep with what the server will compute on submit.
  const slugPreview = useMemo(() => buildingSlug(watchedName), [watchedName]);

  const onSubmit = handleSubmit(async (input) => {
    try {
      const result = await mutation.mutateAsync({
        stake_name: input.stake_name,
        bootstrap_admin_email: input.bootstrap_admin_email,
        ...(input.timezone.trim().length > 0 ? { timezone: input.timezone } : {}),
      });
      if (result.success) {
        toast(`Stake \`${result.stakeId}\` created.`, 'success');
        reset({
          stake_name: '',
          bootstrap_admin_email: '',
          timezone: DEFAULT_TIMEZONE,
        });
        return;
      }
      const { field, message } = softFailToFieldError(result.error);
      setError(field, { type: 'server', message });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  return (
    <form
      className="flex flex-col gap-3 rounded border border-gray-200 bg-white p-4"
      onSubmit={onSubmit}
      data-testid="create-stake-form"
      noValidate
    >
      <h2 className="text-base font-semibold">Create stake</h2>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Stake name</span>
        <Input
          type="text"
          autoComplete="off"
          {...register('stake_name')}
          data-testid="create-stake-name"
        />
        <span className="text-xs text-gray-500" data-testid="create-stake-slug-preview">
          Slug:{' '}
          {slugPreview.length > 0 ? (
            <code>{slugPreview}</code>
          ) : (
            <em className="not-italic text-gray-400">(empty)</em>
          )}
        </span>
      </label>
      {formState.errors.stake_name ? (
        <p className="kd-form-error" role="alert" data-testid="create-stake-name-error">
          {formState.errors.stake_name.message}
        </p>
      ) : null}

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Bootstrap admin email</span>
        <Input
          type="email"
          autoComplete="off"
          {...register('bootstrap_admin_email')}
          data-testid="create-stake-email"
        />
      </label>
      {formState.errors.bootstrap_admin_email ? (
        <p className="kd-form-error" role="alert" data-testid="create-stake-email-error">
          {formState.errors.bootstrap_admin_email.message}
        </p>
      ) : null}

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Timezone</span>
        <Input
          type="text"
          autoComplete="off"
          {...register('timezone')}
          data-testid="create-stake-timezone"
        />
        <span className="text-xs text-gray-500">IANA tz identifier (e.g. America/Denver).</span>
      </label>
      {formState.errors.timezone ? (
        <p className="kd-form-error" role="alert" data-testid="create-stake-timezone-error">
          {formState.errors.timezone.message}
        </p>
      ) : null}

      <div className="form-actions">
        <Button
          type="submit"
          disabled={mutation.isPending || formState.isSubmitting}
          data-testid="create-stake-submit"
        >
          {mutation.isPending ? 'Creating…' : 'Create stake'}
        </Button>
      </div>
    </form>
  );
}
