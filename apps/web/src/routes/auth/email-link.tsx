// `/auth/email-link` — action-handler route for the email magic link
// sign-in round-trip (spec §4.1). The emailed link the user clicks lands
// here. Unauthed by design: at the time the link is opened the user is
// not yet signed in, so this route lives outside the `_authed/` group.
//
// On mount:
//   1. Verify the current URL is a Firebase email-link via
//      `isSignInWithEmailLink`.
//   2. Read the email the user typed at request time from localStorage.
//      If absent (cross-device — user requested on phone, opened on
//      laptop) prompt for the email address the link was sent to.
//   3. Call `signInWithEmailLink`. On success: clear the stashed email
//      and redirect to `/`, where `gateDecision()` runs unchanged.
//   4. On error (expired link, malformed URL, email mismatch, network
//      failure): render the error message + a "Send a new link" link
//      back to the sign-in page. For the cross-device-prompt branch
//      specifically, an `auth/invalid-email` / `auth/argument-error`
//      rejection is treated as a recoverable typo on the user's typed
//      email — the prompt stays visible with an inline error so the
//      user can retry without burning the (still-valid) link.
//
// Forms use react-hook-form + zod resolver per `apps/web/CLAUDE.md`
// convention. The cross-device prompt's email value is owned by RHF
// state at the parent level, so the `prompt → signing-in-from-prompt →
// prompt` transition on a typed-email rejection does NOT wipe the
// user's typed input — the form instance survives the state change
// because it is not unmounted (we keep the same component tree
// mounted across the in-flight transition).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { FirebaseError } from 'firebase/app';
import { BrandIcon } from '../../components/layout/BrandIcon';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { signInEmailSchema, type SignInEmailForm } from '../../features/auth/schemas';
import {
  clearStashedEmail,
  completeSignInWithEmailLink,
  isSignInWithEmailLink,
  peekStashedEmail,
} from '../../features/auth/signIn';

export const Route = createFileRoute('/auth/email-link')({
  component: EmailLinkActionPage,
});

// SDK error codes that leave the link still usable — keep the prompt
// visible with an inline error so the user can retry without burning
// a fresh round-trip. Three sources:
//
//   - `auth/invalid-email`, `auth/argument-error`: typed email is
//     malformed or doesn't match the link's intended recipient.
//   - `auth/network-request-failed`: transient connectivity blip; the
//     `oobCode` was never consumed (Firebase only consumes it on a
//     *successful* redemption), so the user can re-click submit
//     against the same link.
//
// Other codes (`auth/invalid-action-code` / `auth/expired-action-code`)
// mean the link itself is unusable; those still swap to ErrorCard.
//
// `Set` membership for O(1) lookup. Codes are matched against
// `FirebaseError.code` rather than `err.message.includes(code)` —
// the SDK could reformat the message text between versions without
// changing `code`, so the code property is the stable contract.
const RECOVERABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'auth/invalid-email',
  'auth/argument-error',
  'auth/network-request-failed',
]);

function isRecoverableError(err: unknown): boolean {
  return err instanceof FirebaseError && RECOVERABLE_ERROR_CODES.has(err.code);
}

// Subset of `RECOVERABLE_ERROR_CODES` whose semantics are "the user
// has nothing to retype, just retry the same call." Currently only
// the transient network code — the email-typo codes are filtered
// out because the auto-signin path has no typed-email field to fix
// (the stash drove the call). This is what gates the auto-retry
// affordance on the auto-signin path.
function isTransientNetworkError(err: unknown): boolean {
  return err instanceof FirebaseError && err.code === 'auth/network-request-failed';
}

type State =
  | { kind: 'verifying' }
  | { kind: 'prompt'; inlineError: string | null }
  | { kind: 'signing-in-from-prompt' }
  | { kind: 'signing-in' }
  // Auto-signin path hit a transient network error. The link is
  // still valid (Firebase only consumes the oobCode on a successful
  // redemption) and the stash is intact, so render a "Retry sign-in"
  // affordance against the same link instead of forcing a fresh
  // send. `email` is the stashed email so the retry handler doesn't
  // need to read localStorage again.
  | { kind: 'auto-retry'; email: string; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'not-a-link' };

function EmailLinkActionPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: 'verifying' });
  // StrictMode dev double-mounts the effect. Firebase consumes the
  // `oobCode` on the FIRST `signInWithEmailLink` call, so the second
  // dispatch under StrictMode rejects with `auth/invalid-action-code`
  // and would flip state to ErrorCard even though sign-in succeeded.
  // The `useRef` "started-this-render" guard ensures only the first
  // effect run dispatches sign-in.
  const startedRef = useRef(false);

  // Cross-device prompt form. Lives at the parent level (not inside
  // `CrossDevicePrompt`) so the `prompt → signing-in-from-prompt →
  // prompt` transition on a typed-email rejection does NOT wipe the
  // user's typed input. No `defaultValues` prefill — the prompt only
  // renders when the effect's `peekStashedEmail()` returned `null`
  // (else we'd be on the auto-signin path), so any prefill would
  // always resolve to `''`.
  const promptForm = useForm<SignInEmailForm>({
    resolver: zodResolver(signInEmailSchema),
    defaultValues: { email: '' },
  });

  // Auto-signin dispatch: shared between the initial effect and the
  // "Retry sign-in" affordance the auto-retry state renders. Reading
  // `window.location.href` inside the callback (not capturing it in a
  // closure) is intentional — between mount and the user's retry
  // click, the URL must not have changed, but we re-read it for
  // safety.
  const runAutoSignIn = useCallback(
    async (email: string) => {
      setState({ kind: 'signing-in' });
      const href = window.location.href;
      try {
        await completeSignInWithEmailLink(email, href);
        // Success path — clear the stash now that the link has been
        // redeemed. Idempotent.
        clearStashedEmail();
        navigate({ to: '/', replace: true }).catch(() => {
          // Same swallow as the gate in routes/index.tsx — the
          // user lands back on the sign-in page if navigation
          // fails for any reason.
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Transient-network class: link is still valid (oobCode only
        // consumed on a successful redemption) and the stash is
        // intact. Render a retry affordance against the SAME link so
        // the user isn't forced into a fresh send for a connectivity
        // blip. Symmetric with the cross-device prompt path's
        // recoverable-error handling.
        if (isTransientNetworkError(err)) {
          setState({ kind: 'auto-retry', email, message });
          return;
        }
        // Non-recoverable — link is unusable. Clear the stash so a
        // future re-send doesn't carry the spent value forward.
        clearStashedEmail();
        setState({ kind: 'error', message });
      }
    },
    [navigate],
  );

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    async function run() {
      const href = window.location.href;
      if (!isSignInWithEmailLink(href)) {
        setState({ kind: 'not-a-link' });
        return;
      }
      const stashed = peekStashedEmail();
      if (!stashed) {
        // Cross-device — user typed the email on one device, opened
        // the link on another. Prompt for it; the user resolves the
        // signing-in branch from the form below.
        setState({ kind: 'prompt', inlineError: null });
        return;
      }
      await runAutoSignIn(stashed);
    }

    run();
  }, [runAutoSignIn]);

  const onPromptSubmit = promptForm.handleSubmit(async (input) => {
    // Zod has already validated `required` + `email format`. Burn the
    // SDK call only on a well-formed entry.
    setState({ kind: 'signing-in-from-prompt' });
    try {
      await completeSignInWithEmailLink(input.email, window.location.href);
      // Defensive — `peekStashedEmail` may have left a value if the
      // user opened the link both on this device and another; ensure
      // we don't carry it forward.
      clearStashedEmail();
      navigate({ to: '/', replace: true }).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Recoverable errors (typed-email mismatch / malformed /
      // transient network failure): the link is still good because
      // Firebase only consumes the `oobCode` on a successful
      // redemption. Keep the prompt visible with an inline error so
      // the user can fix the typo or retry the network call without
      // requesting a fresh link. The `prompt → signing-in-from-prompt
      // → prompt` transition keeps the CrossDevicePrompt mounted (see
      // `showPrompt` below) so RHF state is preserved.
      if (isRecoverableError(err)) {
        setState({ kind: 'prompt', inlineError: message });
        return;
      }
      setState({ kind: 'error', message });
    }
  });

  const showPrompt =
    state.kind === 'prompt' ||
    // Keep the prompt mounted during `signing-in-from-prompt` so RHF
    // state survives a bounce back to `prompt` on a typed-email
    // rejection. The form disables the submit button and swaps the
    // label to "Signing in…" to communicate pending state.
    state.kind === 'signing-in-from-prompt';
  const inlineError = state.kind === 'prompt' ? state.inlineError : null;
  const submittingFromPrompt = state.kind === 'signing-in-from-prompt';

  return (
    <div className="flex min-h-screen flex-col bg-[#f7f8fb] text-[color:var(--kd-fg-1)]">
      <header className="sticky top-0 z-20 border-b border-[color:var(--kd-chrome-border)] bg-white">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-5 py-3">
          <Link
            to="/"
            className="flex items-center gap-2.5 text-[color:var(--kd-primary)] no-underline hover:underline"
          >
            <BrandIcon size={28} />
            <span className="text-base font-semibold sm:text-[1.05rem]">Stake Building Access</span>
          </Link>
        </div>
      </header>

      <main className="flex flex-1 items-start justify-center px-5 py-12 sm:py-16">
        <div className="w-full max-w-md">
          {state.kind === 'verifying' || state.kind === 'signing-in' ? (
            <StatusCard
              title="Signing you in…"
              body="One moment while we finish the sign-in."
              role="status"
            />
          ) : null}

          {showPrompt ? (
            <CrossDevicePrompt
              form={promptForm}
              onSubmit={onPromptSubmit}
              inlineError={inlineError}
              submitting={submittingFromPrompt}
            />
          ) : null}

          {state.kind === 'error' ? <ErrorCard message={state.message} /> : null}

          {state.kind === 'auto-retry' ? (
            <RetryCard message={state.message} onRetry={() => runAutoSignIn(state.email)} />
          ) : null}

          {state.kind === 'not-a-link' ? (
            <ErrorCard message="This link is not a valid sign-in link. Open the most recent email we sent and click that link, or request a new one." />
          ) : null}
        </div>
      </main>
    </div>
  );
}

interface StatusCardProps {
  title: string;
  body: string;
  role?: 'status' | 'alert';
}

function StatusCard({ title, body, role = 'status' }: StatusCardProps) {
  return (
    <div
      role={role}
      className="flex flex-col gap-2 rounded border border-[color:var(--kd-border-soft)] bg-white p-6 text-center"
    >
      <h1 className="m-0 text-[1.1rem] font-semibold text-[color:var(--kd-fg-1)]">{title}</h1>
      <p className="m-0 text-sm leading-relaxed text-[color:var(--kd-fg-2)]">{body}</p>
    </div>
  );
}

interface CrossDevicePromptProps {
  form: UseFormReturn<SignInEmailForm>;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  inlineError: string | null;
  submitting: boolean;
}

function CrossDevicePrompt({ form, onSubmit, inlineError, submitting }: CrossDevicePromptProps) {
  const { register, formState } = form;
  // Field-level zod errors win over the parent-supplied SDK error
  // (zod runs client-side before the SDK is called; SDK rejection
  // surfaces only after a well-formed submit).
  const errorMessage = formState.errors.email?.message ?? inlineError ?? null;
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="flex flex-col gap-3 rounded border border-[color:var(--kd-border-soft)] bg-white p-6"
    >
      <h1 className="m-0 text-[1.1rem] font-semibold text-[color:var(--kd-fg-1)]">
        Confirm your email
      </h1>
      <p className="m-0 text-sm leading-relaxed text-[color:var(--kd-fg-2)]">
        For your security, please confirm the email address the sign-in link was sent to.
      </p>
      <label htmlFor="email-link-confirm-email" className="text-sm font-medium">
        Email address
      </label>
      <Input
        id="email-link-confirm-email"
        type="email"
        autoComplete="email"
        inputMode="email"
        placeholder="you@example.com"
        disabled={submitting}
        aria-invalid={errorMessage ? true : undefined}
        aria-describedby={errorMessage ? 'email-link-confirm-error' : undefined}
        {...register('email')}
      />
      <Button type="submit" disabled={submitting}>
        {submitting ? 'Signing in…' : 'Confirm and sign in'}
      </Button>
      {errorMessage ? (
        <div
          role="alert"
          id="email-link-confirm-error"
          data-testid="email-link-prompt-error"
          className="text-sm text-[color:var(--kd-danger-fg)]"
        >
          {errorMessage}
        </div>
      ) : null}
    </form>
  );
}

interface RetryCardProps {
  message: string;
  onRetry: () => void;
}

// Auto-signin transient-network branch. Same surface shape as
// ErrorCard but the primary affordance is "Retry sign-in" (re-dispatch
// against the same still-valid link) instead of "Send a new link."
// The stash is preserved across this state, so the retry handler has
// the email it needs.
function RetryCard({ message, onRetry }: RetryCardProps) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded border border-[color:var(--kd-danger-tint)] bg-white p-6"
      data-testid="email-link-retry"
    >
      <h1 className="m-0 text-[1.1rem] font-semibold text-[color:var(--kd-danger-fg)]">
        We couldn’t reach the sign-in service.
      </h1>
      <p className="m-0 text-sm leading-relaxed text-[color:var(--kd-fg-2)]">{message}</p>
      <p className="m-0 text-sm leading-relaxed text-[color:var(--kd-fg-2)]">
        Your sign-in link is still valid. Check your connection and try again.
      </p>
      <Button type="button" onClick={onRetry} className="self-start">
        Retry sign-in
      </Button>
    </div>
  );
}

interface ErrorCardProps {
  message: string;
}

function ErrorCard({ message }: ErrorCardProps) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded border border-[color:var(--kd-danger-tint)] bg-white p-6"
      data-testid="email-link-error"
    >
      <h1 className="m-0 text-[1.1rem] font-semibold text-[color:var(--kd-danger-fg)]">
        We couldn’t complete sign-in.
      </h1>
      <p className="m-0 text-sm leading-relaxed text-[color:var(--kd-fg-2)]">{message}</p>
      <p className="m-0 text-sm leading-relaxed text-[color:var(--kd-fg-2)]">
        The link may have expired or been used already. Request a new sign-in link to try again.
      </p>
      <Link
        to="/"
        className="self-start text-sm text-[color:var(--kd-primary)] underline-offset-2 hover:underline"
      >
        Send a new link
      </Link>
    </div>
  );
}
