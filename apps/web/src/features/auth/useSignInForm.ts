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
// dismissed or raced by a second invocation. On the homepage these are
// not failures and must not surface as red alerts.
//
// `/auth/extension` opts out via `announceCancelledPopup`, because the
// same silence reads differently there: that page renders inside a
// `chrome.identity.launchWebAuthFlow` window, where a Google popup that
// never opened — or opened and vanished — is indistinguishable from
// nothing having happened at all. Saying nothing leaves the manager
// staring at the page that just told them to use whichever sign-in they
// have, with no hint that the other one is right below.
const CANCELLED_GOOGLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'auth/popup-closed-by-user',
  'auth/cancelled-popup-request',
]);

/**
 * A Google sign-in failure, already translated for a human.
 *
 * `message` leads with what to do next — always the magic-link form,
 * which is on screen in both hosts and needs no Google account. `code`
 * carries the SDK's own identifier for the operator, rendered small
 * beside it: a raw `FirebaseError` string is useless to a manager, but
 * discarding the code entirely would cost the operator the one token
 * that makes a smoke-test failure searchable.
 */
export interface GoogleSignInError {
  message: string;
  code: string | null;
}

const GOOGLE_FALLBACK_HINT =
  'Use the email sign-in link below instead — it works without a Google account.';

/**
 * Translate a `signInWithPopup` rejection into copy. Returns `null` when
 * the rejection is a cancellation the host chose not to announce.
 *
 * Every branch names the magic-link form. `signInWithPopup` needs
 * `window.open` plus opener `postMessage`, neither of which is
 * guaranteed inside an extension auth window, so "the popup route is
 * unavailable here" is a real state this page has to survive rather
 * than merely report.
 */
export function describeGoogleSignInError(
  err: unknown,
  announceCancelled: boolean,
): GoogleSignInError | null {
  const code = err instanceof FirebaseError ? err.code : null;
  if (code !== null && CANCELLED_GOOGLE_ERROR_CODES.has(code)) {
    if (!announceCancelled) return null;
    return {
      message: `Google sign-in didn’t finish. Try it again, or ${lowerFirst(GOOGLE_FALLBACK_HINT)}`,
      code,
    };
  }
  if (code === 'auth/popup-blocked') {
    return {
      message: `Your browser blocked the Google sign-in window. ${GOOGLE_FALLBACK_HINT}`,
      code,
    };
  }
  if (code === 'auth/network-request-failed') {
    return { message: `Google sign-in couldn’t reach the network. ${GOOGLE_FALLBACK_HINT}`, code };
  }
  return { message: `Google sign-in didn’t work. ${GOOGLE_FALLBACK_HINT}`, code };
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export interface SignInFormOptions {
  /**
   * Surface a dismissed / raced Google popup as copy instead of
   * swallowing it. See `CANCELLED_GOOGLE_ERROR_CODES`.
   */
  announceCancelledPopup?: boolean;
}

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
  googleError: GoogleSignInError | null;
  focusEmailInput: () => void;
}

export function useSignInForm(options: SignInFormOptions = {}): SignInFormState {
  const announceCancelledPopup = options.announceCancelledPopup ?? false;
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
  const [googleError, setGoogleError] = useState<GoogleSignInError | null>(null);
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
      // `describeGoogleSignInError` returns `null` for a cancellation
      // the host chose to swallow, and otherwise copy that names the
      // magic-link form as the way through.
      setGoogleError(describeGoogleSignInError(err, announceCancelledPopup));
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
