// Create Stake form. Rendered inside a modal dialog opened from the
// Create Stake button on `/superadmin/stakes` (spec §5.4).
//
// Submit dispatches the `createStake` callable (via `useCreateStake`).
// Soft-failure envelopes from the callable (`{success:false, error}`)
// are surfaced as inline field errors against the field that owns the
// problem; hard `HttpsError`s (caught from the SDK) become a toast.
// `{success:true}` fires a success toast and closes the dialog; the new
// stake row arrives via the live `useStakes()` snapshot listener — no
// forced token refresh needed, since `createStake` is superadmin-gated
// and the creator already holds that claim. The StakeSwitcher entry
// (which does need the new stake's `bootstrap` claim) appears on the
// next natural token refresh.
//
// Form-state lifecycle: the form `reset()`s to empty defaults on every
// open transition so re-opening after a successful create (or after a
// Cancel mid-edit) starts fresh. This matches the pattern used by
// `CallingTemplateFormDialog`.
//
// Stake ID: the field shows the doc ID slug directly — no separate
// preview line, because the input can only ever hold a canonical slug.
// It follows the stake name (slugified, live) until the operator edits
// it, at which point it detaches and the name stops driving it. Cleared
// back to empty it re-attaches: empty means "give me the default back",
// so name edits drive it again and blurring an empty field refills it.
// The refill waits for blur rather than firing the moment the field
// empties, so clearing it to type a fresh ID doesn't append what they
// type to the default they just deleted. The detach flag resets with
// the form on every open transition.
//
// Two slug rules, and the difference is load-bearing. Auto-fill from
// the name re-derives from the whole name each keystroke, so plain
// `buildingSlug` is right there. Direct typing goes through
// `sanitizeSlugInput`, which keeps a trailing hyphen so `cs ` doesn't
// collapse to `cs` and turn the next character into `csnorth`; the
// hyphen is trimmed on blur and on submit.
//
// Timezone: rendered via the shared `TimezoneCombobox` (curated US
// IANA list). The default is `America/Denver`; the operator picks
// from the list. Server-side `invalid_timezone` validation stays on
// the callable as defense-in-depth for non-SDK callers; the form-
// error mapping for that code is preserved even though the UI can't
// practically produce it.

import { useEffect, useRef, type ChangeEvent, type FocusEvent } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { buildingSlug, sanitizeSlugInput, type CreateStakeError } from '@kindoo/shared';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Input } from '../../components/ui/Input';
import { TimezoneCombobox } from '../../components/TimezoneCombobox';
import { toast } from '../../lib/store/toast';
import { useCreateStake } from './hooks';
import { createStakeSchema, DEFAULT_TIMEZONE, type CreateStakeForm } from './schemas';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Map a soft-failure error code to a human-friendly message and the
 * field it should attach to. `invalid_slug` and `slug_collision` are
 * about whichever input produced the slug: the Stake ID when the
 * payload carried one (`typedStakeId` non-empty), the stake name when
 * it didn't. Since the ID field auto-fills, the name branch is reached
 * only when the name has nothing to slugify — an `invalid_slug` on a
 * name like `###`, which leaves the ID field empty. `name_required`,
 * `email_required`, `invalid_email`, and `invalid_timezone` mirror
 * their inputs. Pure — the caller threads in the submitted Stake ID
 * rather than the mapper reading form state.
 */
function softFailToFieldError(
  error: CreateStakeError,
  typedStakeId: string,
): {
  field: keyof CreateStakeForm;
  message: string;
} {
  const idWasTyped = typedStakeId.trim().length > 0;
  switch (error) {
    case 'name_required':
      return { field: 'stake_name', message: 'Stake name is required.' };
    case 'email_required':
      return {
        field: 'bootstrap_admin_email',
        message: 'Bootstrap admin email is required.',
      };
    case 'invalid_email':
      return {
        field: 'bootstrap_admin_email',
        message: 'Not a valid email address.',
      };
    case 'invalid_slug':
      return idWasTyped
        ? {
            field: 'stake_id',
            message: 'Stake ID contains no letters or digits — pick an ID that slugifies.',
          }
        : {
            field: 'stake_name',
            message:
              'Stake name contains no letters or digits — pick a name that produces a valid slug.',
          };
    case 'slug_collision':
      return idWasTyped
        ? {
            field: 'stake_id',
            message: 'A stake with that ID already exists. Pick a different ID.',
          }
        : {
            field: 'stake_name',
            message: 'A stake with that slug already exists. Pick a different name.',
          };
    case 'invalid_timezone':
      return {
        field: 'timezone',
        message:
          'Timezone is not a recognized IANA identifier (e.g. America/Denver, America/Phoenix).',
      };
  }
}

const EMPTY_DEFAULTS: CreateStakeForm = {
  stake_name: '',
  stake_id: '',
  bootstrap_admin_email: '',
  timezone: DEFAULT_TIMEZONE,
};

export interface CreateStakeFormProps {
  open: boolean;
  onClose: () => void;
}

export function CreateStakeForm({ open, onClose }: CreateStakeFormProps) {
  const mutation = useCreateStake();

  const form = useForm<CreateStakeForm>({
    resolver: zodResolver(createStakeSchema),
    defaultValues: EMPTY_DEFAULTS,
  });
  const {
    register,
    control,
    handleSubmit,
    watch,
    reset,
    setValue,
    getValues,
    setError,
    formState,
  } = form;

  // True once the operator has typed into the Stake ID field, which
  // stops the stake name from driving it. A ref rather than state: only
  // the handlers below read it, and flipping it never needs a re-render.
  const stakeIdDetached = useRef(false);

  // Post-submit re-validation switch for the two paths that edit
  // `stake_id` — typing in it, and the name auto-fill. RHF's
  // `reValidateMode: 'onChange'` reaches neither, so both ask for it by
  // hand. (Blur doesn't: `reValidateMode: 'onChange'` skips blur for a
  // normally registered field too.) Read during render, which is what
  // registers the `formState` proxy subscription. The ref copy is for
  // the autofill effect below, which must NOT take it as a dependency —
  // it would re-run the instant the flag flips, which is the instant
  // `onSubmit`'s `setError` lands, and validate the server error away
  // before the operator ever saw it.
  const { isSubmitted } = formState;
  const isSubmittedRef = useRef(isSubmitted);
  isSubmittedRef.current = isSubmitted;

  // Reset on every open transition so a re-opened dialog starts empty
  // (after a successful create, or after a Cancel mid-edit). Mirrors
  // the pattern used by `CallingTemplateFormDialog`. The detach flag is
  // form state too, so it resets here alongside the fields.
  useEffect(() => {
    if (!open) return;
    stakeIdDetached.current = false;
    reset(EMPTY_DEFAULTS);
  }, [open, reset]);

  const watchedName = watch('stake_name') ?? '';

  // Stake ID follows the name until the operator takes it over, so they
  // can see the doc ID they're about to get without typing it. Renaming
  // is the other natural answer to a collision, so the ID it writes has
  // to clear the last submit's error the same way typing one does.
  useEffect(() => {
    if (stakeIdDetached.current) return;
    setValue('stake_id', buildingSlug(watchedName), {
      shouldValidate: isSubmittedRef.current,
    });
  }, [watchedName, setValue]);

  const stakeIdField = register('stake_id');

  const onStakeIdChange = (event: ChangeEvent<HTMLInputElement>) => {
    const el = event.currentTarget;
    const raw = el.value;
    const caret = el.selectionStart ?? raw.length;
    const next = sanitizeSlugInput(raw);
    // Emptying the field hands it back to the name; anything else is
    // the operator taking it over. Left empty it stays empty while they
    // keep typing — refilling here would append the default to whatever
    // they type next — and `onStakeIdBlur` restores the default if they
    // walk away without entering one.
    stakeIdDetached.current = next.length > 0;
    // This handler replaces the registered `onChange`, so RHF's
    // post-submit re-validation never runs for the field. Without
    // `shouldValidate` a `setError` from the last submit — a slug
    // collision, the field's whole reason to exist — sits there telling
    // the operator a freshly typed ID is taken until they submit again.
    setValue('stake_id', next, { shouldDirty: true, shouldValidate: isSubmitted });
    // `setValue` writes `ref.value` synchronously, which drops the caret
    // to the end. Put it back where the operator left it, shifted by
    // whatever the sanitize added or removed.
    const pos = Math.min(next.length, Math.max(0, caret + next.length - raw.length));
    el.setSelectionRange(pos, pos);
  };

  const onStakeIdBlur = (event: FocusEvent<HTMLInputElement>) => {
    // Drop the word-boundary hyphen now that typing has stopped, and put
    // the name-derived default back if the field was left empty — at
    // rest it always shows the ID the stake will actually get.
    const trimmed = buildingSlug(event.currentTarget.value);
    setValue('stake_id', trimmed.length > 0 ? trimmed : buildingSlug(getValues('stake_name')), {
      shouldDirty: true,
    });
    void stakeIdField.onBlur(event);
  };

  const onSubmit = handleSubmit(async (input) => {
    // `buildingSlug` finalizes the sanitized field value, trimming a
    // trailing hyphen left by a submit that beat the blur.
    const typedStakeId = buildingSlug(input.stake_id);
    try {
      const result = await mutation.mutateAsync({
        stake_name: input.stake_name,
        bootstrap_admin_email: input.bootstrap_admin_email,
        ...(typedStakeId.length > 0 ? { stake_id: typedStakeId } : {}),
        ...(input.timezone.trim().length > 0 ? { timezone: input.timezone } : {}),
      });
      if (result.success) {
        toast(`Stake \`${result.stakeId}\` created.`, 'success');
        onClose();
        return;
      }
      const { field, message } = softFailToFieldError(result.error, typedStakeId);
      setError(field, { type: 'server', message });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Create stake"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={onSubmit}
        data-testid="create-stake-form"
        noValidate
      >
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Stake name</span>
          <Input
            type="text"
            autoComplete="off"
            {...register('stake_name')}
            data-testid="create-stake-name"
          />
        </label>
        {formState.errors.stake_name ? (
          <p className="kd-form-error" role="alert" data-testid="create-stake-name-error">
            {formState.errors.stake_name.message}
          </p>
        ) : null}

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Stake ID</span>
          <Input
            type="text"
            autoComplete="off"
            spellCheck={false}
            {...stakeIdField}
            onChange={onStakeIdChange}
            onBlur={onStakeIdBlur}
            data-testid="create-stake-id"
          />
          <span className="text-xs text-gray-500" data-testid="create-stake-id-hint">
            Lowercase letters, digits, and hyphens — defaults from the stake name.
          </span>
        </label>
        {formState.errors.stake_id ? (
          <p className="kd-form-error" role="alert" data-testid="create-stake-id-error">
            {formState.errors.stake_id.message}
          </p>
        ) : null}

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Bootstrap admin email</span>
          <Input
            type="email"
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            {...register('bootstrap_admin_email')}
            data-testid="create-stake-email"
          />
          <span className="text-xs text-gray-500" data-testid="create-stake-email-hint">
            Lowercased on save to match the user&apos;s Google sign-in address.
          </span>
        </label>
        {formState.errors.bootstrap_admin_email ? (
          <p className="kd-form-error" role="alert" data-testid="create-stake-email-error">
            {formState.errors.bootstrap_admin_email.message}
          </p>
        ) : null}

        <label className="flex flex-col gap-1" htmlFor="create-stake-timezone">
          <span className="text-sm font-medium">Timezone</span>
          <Controller
            name="timezone"
            control={control}
            render={({ field }) => (
              <TimezoneCombobox
                id="create-stake-timezone"
                value={field.value}
                onChange={field.onChange}
                data-testid="create-stake-timezone"
              />
            )}
          />
        </label>
        {formState.errors.timezone ? (
          <p className="kd-form-error" role="alert" data-testid="create-stake-timezone-error">
            {formState.errors.timezone.message}
          </p>
        ) : null}

        <Dialog.Footer>
          <Dialog.CancelButton data-testid="create-stake-cancel">Cancel</Dialog.CancelButton>
          <Button
            type="submit"
            disabled={mutation.isPending || formState.isSubmitting}
            data-testid="create-stake-submit"
          >
            {mutation.isPending ? 'Creating…' : 'Create stake'}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}
