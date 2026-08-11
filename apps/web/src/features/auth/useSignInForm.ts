// State + handlers behind the two sign-in providers the SPA exposes
// (spec §4.1): the "Continue with Google" popup CTA and the email
// magic-link form.
//
// Extracted from `SignInPage` so the extension-auth route
// (`routes/auth/extension.tsx`) drives the same providers instead of
// re-implementing them. The markup lives in `SignInProviders`; this
// hook owns everything stateful so a host page can still read
// `sentTo` (to hide its own affordances) and call `focusEmailInput()`.

import { useRef, useState } from 'react';
import { useForm, type UseFormRegisterReturn, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { FirebaseError } from 'firebase/app';
import { signInEmailSchema, type SignInEmailForm } from './schemas';
import { clearStashedEmail, sendMagicLink, signInWithGoogle } from './signIn';

// Normal user cancellations from `signInWithPopup` — the popup was
// dismissed or raced by a second invocation. These are not failures
// and must not surface as red alerts.
const SILENT_GOOGLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'auth/popup-closed-by-user',
  'auth/cancelled-popup-request',
]);

export interface SignInFormState {
  form: UseFormReturn<SignInEmailForm>;
  onSubmit: React.FormEventHandler<HTMLFormElement>;
  /** Merged callback ref — wires RHF's ref and the focus target. */
  emailInputRef: (node: HTMLInputElement | null) => void;
  /** Spread onto the email input; RHF owns the value internally. */
  emailInputProps: Omit<UseFormRegisterReturn<'email'>, 'ref'>;
  /** Field-level zod error, else the post-submit SDK rejection. */
  fieldError: string | null;
  /** Magic-link submit in flight. */
  pending: boolean;
  /** Non-null once a link has been sent — swaps to the confirmation state. */
  sentTo: string | null;
  onUseDifferentEmail: () => void;
  onGoogleSignIn: () => void;
  googlePending: boolean;
  googleError: string | null;
  focusEmailInput: () => void;
}

export function useSignInForm(): SignInFormState {
  // Form-level zod-resolver covers required + format. `submitError`
  // captures the post-submit SDK rejection (network /
  // unauthorized-continue-uri / etc.) so the field-level error spot
  // can render either source.
  const form = useForm<SignInEmailForm>({
    resolver: zodResolver(signInEmailSchema),
    defaultValues: { email: '' },
  });
  const { register, handleSubmit, formState, reset } = form;
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [googlePending, setGooglePending] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const emailInputEl = useRef<HTMLInputElement>(null);
  const { ref: rhfEmailRef, ...emailInputProps } = register('email');

  function focusEmailInput() {
    emailInputEl.current?.focus();
    emailInputEl.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const onSubmit = handleSubmit(async (input) => {
    setSubmitError(null);
    try {
      await sendMagicLink(input.email);
      setSentTo(input.email);
    } catch (err) {
      // `sendSignInLinkToEmail` rejects with `FirebaseError` for
      // `auth/invalid-email`, `auth/unauthorized-continue-uri`,
      // network failures, etc. Surface the message verbatim so the
      // operator can debug without opening devtools.
      const message = err instanceof Error ? err.message : String(err);
      setSubmitError(message);
    }
  });

  async function onGoogleSignIn() {
    setGoogleError(null);
    setGooglePending(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      // User-initiated cancellations are not failures — silently
      // swallow them so the alert region stays empty when the user
      // closes the popup or a second popup raced.
      if (err instanceof FirebaseError && SILENT_GOOGLE_ERROR_CODES.has(err.code)) {
        return;
      }
      // `signInWithPopup` rejects with `FirebaseError` for popup-blocked,
      // network failure, etc. Surface the message verbatim so the
      // operator can debug without opening devtools.
      const message = err instanceof Error ? err.message : String(err);
      setGoogleError(message);
    } finally {
      setGooglePending(false);
    }
  }

  function onUseDifferentEmail() {
    // Clear the previously stashed email so a still-in-flight first
    // link (already in the user's inbox) routes through the action
    // handler's cross-device prompt rather than completing against
    // the new email — otherwise `signInWithEmailLink(B, hrefForA)`
    // rejects with `auth/invalid-email` and turns a recoverable typo
    // into a hard error.
    clearStashedEmail();
    setSentTo(null);
    setSubmitError(null);
    reset({ email: '' });
    // Focus runs after the next paint, when the form is back on screen.
    queueMicrotask(focusEmailInput);
  }

  return {
    form,
    onSubmit,
    emailInputRef: (node) => {
      rhfEmailRef(node);
      emailInputEl.current = node;
    },
    emailInputProps,
    fieldError: formState.errors.email?.message ?? submitError ?? null,
    pending: formState.isSubmitting,
    sentTo,
    onUseDifferentEmail,
    onGoogleSignIn,
    googlePending,
    googleError,
    focusEmailInput,
  };
}
