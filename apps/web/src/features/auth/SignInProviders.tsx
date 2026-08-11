// The sign-in provider block: "Continue with Google" above the email
// magic-link form, and the "Check your email" confirmation state the
// form swaps to after a successful send (spec §4.1).
//
// Shared by the signed-out homepage (`SignInPage`) and the
// extension-auth route (`routes/auth/extension.tsx`) so the two
// surfaces can never drift on provider set, copy, or error handling.
// State lives in `useSignInForm()`; this component is presentational.
//
// Buttons route through the shadcn `<Button>` primitive so they pick up
// the `.btn` chrome from `base.css` (Tailwind v4 preflight regression
// guarded by `e2e/tests/auth/sign-in-button-renders.spec.ts`).

import type { ReactNode } from 'react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import type { SignInFormState } from './useSignInForm';

interface SignInProvidersProps {
  state: SignInFormState;
  /**
   * Rendered below the block in BOTH the form and confirmation states —
   * host-specific guidance that stays true across the magic-link send.
   */
  note?: ReactNode;
  /** Overrides the confirmation state's body copy. */
  confirmationBody?: ReactNode;
}

export function SignInProviders({ state, note, confirmationBody }: SignInProvidersProps) {
  const {
    onSubmit,
    pending,
    fieldError,
    sentTo,
    onUseDifferentEmail,
    emailInputRef,
    emailInputProps,
    onGoogleSignIn,
    googlePending,
    googleError,
  } = state;

  return (
    <div className="flex flex-col gap-3 text-left">
      {sentTo ? (
        <ConfirmationState
          sentTo={sentTo}
          onUseDifferentEmail={onUseDifferentEmail}
          body={confirmationBody}
        />
      ) : (
        <>
          {/* Google CTA — primary affordance, auto-width so it doesn't
              visually merge with the magic-link submit below. With
              Firebase Auth's "one account per email address" project
              setting both providers resolve to the same UID. */}
          <div className="flex justify-center">
            <Button
              type="button"
              onClick={onGoogleSignIn}
              disabled={googlePending || pending}
              className="text-[0.95rem]"
            >
              {googlePending ? 'Signing in…' : 'Continue with Google'}
            </Button>
          </div>
          {googleError ? (
            <div role="alert" className="text-sm text-[color:var(--kd-danger-fg)]">
              Sign-in failed: {googleError}
            </div>
          ) : null}
          <div role="separator" aria-label="or" className="my-1 flex items-center gap-3">
            <div className="h-px flex-1 bg-[color:var(--kd-border-soft)]"></div>
            <span className="text-xs uppercase tracking-wide text-[color:var(--kd-fg-3)]">or</span>
            <div className="h-px flex-1 bg-[color:var(--kd-border-soft)]"></div>
          </div>
          <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
            <label
              htmlFor="signin-email"
              className="text-sm font-medium text-[color:var(--kd-fg-1)]"
            >
              Email address
            </label>
            <Input
              id="signin-email"
              ref={emailInputRef}
              type="email"
              autoComplete="email"
              inputMode="email"
              spellCheck={false}
              disabled={pending || googlePending}
              placeholder="you@example.com"
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? 'signin-email-error' : undefined}
              {...emailInputProps}
            />
            <Button
              type="submit"
              disabled={pending || googlePending}
              className="w-full text-[0.95rem]"
            >
              {pending ? 'Sending…' : 'Send me a sign-in link'}
            </Button>
            {fieldError ? (
              <div
                role="alert"
                id="signin-email-error"
                className="text-sm text-[color:var(--kd-danger-fg)]"
              >
                {fieldError}
              </div>
            ) : null}
          </form>
        </>
      )}
      {note}
    </div>
  );
}

interface ConfirmationStateProps {
  sentTo: string;
  onUseDifferentEmail: () => void;
  body?: ReactNode;
}

function ConfirmationState({ sentTo, onUseDifferentEmail, body }: ConfirmationStateProps) {
  return (
    <div
      className="flex flex-col gap-3 rounded border border-[color:var(--kd-border-soft)] bg-white p-5 text-left"
      data-testid="signin-confirmation"
    >
      <h2 className="m-0 text-[1.05rem] font-semibold text-[color:var(--kd-fg-1)]">
        Check your email
      </h2>
      <p className="m-0 text-sm leading-relaxed text-[color:var(--kd-fg-2)]">
        We sent a sign-in link to <strong className="text-[color:var(--kd-fg-1)]">{sentTo}</strong>.{' '}
        {body ?? 'Open it on this device to finish signing in.'}
      </p>
      <button
        type="button"
        onClick={onUseDifferentEmail}
        className="self-start text-sm text-[color:var(--kd-primary)] underline-offset-2 hover:underline"
      >
        Use a different email
      </button>
    </div>
  );
}
