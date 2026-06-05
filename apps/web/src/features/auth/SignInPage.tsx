// Signed-out landing page. The route at `/` renders this whenever no
// Firebase Auth user is present (see `routes/index.tsx` gate decision).
//
// Audience is ward + stake leadership (bishopric, stake presidency,
// executive secretaries, clerks) — the people who request and approve
// building access. Kindoo provisioning lives downstream in the Chrome
// extension; the homepage acknowledges it but does not pitch it.
//
// Sign-in surface (per spec §4.1 / §5.0): both providers visible on
// the SPA. The hero hosts a primary "Continue with Google" button
// directly above the email magic-link form (email input + "Send me a
// sign-in link" primary button). With Firebase Auth's "one account
// per email address" project setting enabled both providers resolve
// to the same Firebase UID for the same email.
//
// The topbar carries a secondary "Sign in" affordance that scrolls +
// focuses the hero form so the CTA remains reachable after the user
// has scrolled.
//
// After a successful magic-link submit the hero swaps to a "Check your
// email" confirmation state with a "Use a different email" link that
// resets to the form. The action-handler route at `/auth/email-link`
// consumes the link the user clicks in their inbox; on success the SPA
// redirects to `/` and the gate decision in `routes/index.tsx` runs
// unchanged.
//
// Buttons route through the shadcn `<Button>` primitive so they pick up
// the `.btn` chrome from `base.css` (Tailwind v4 preflight regression
// guarded by `e2e/tests/auth/sign-in-button-renders.spec.ts`).

import { Link } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { FirebaseError } from 'firebase/app';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { BrandIcon } from '../../components/layout/BrandIcon';
import { CHROME_WEB_STORE_URL } from '../../lib/links';
import { signInEmailSchema, type SignInEmailForm } from './schemas';
import { clearStashedEmail, sendMagicLink, signInWithGoogle } from './signIn';

// Normal user cancellations from `signInWithPopup` — the popup was
// dismissed or raced by a second invocation. These are not failures
// and must not surface as red alerts.
const SILENT_GOOGLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'auth/popup-closed-by-user',
  'auth/cancelled-popup-request',
]);

const CONTACT_MAILTO = 'mailto:support@stakebuildingaccess.org';

// Verbatim copy from spec §4.1.
const PENDING_AUTH_COPY =
  'New sign-ins land in pending authorization until a stake manager adds your email. Contact your stake manager if you can’t reach the next screen.';

export function SignInPage() {
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
  const emailInputRef = useRef<HTMLInputElement>(null);
  const { ref: rhfEmailRef, ...rhfEmailRest } = register('email');

  function focusHeroForm() {
    emailInputRef.current?.focus();
    emailInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  async function handleGoogleSignIn() {
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

  function handleUseDifferentEmail() {
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
    queueMicrotask(focusHeroForm);
  }

  const fieldError = formState.errors.email?.message ?? submitError ?? null;
  const pending = formState.isSubmitting;

  return (
    <div className="flex min-h-screen flex-col bg-[#f7f8fb] text-[color:var(--kd-fg-1)]">
      {/* Hide the topbar Sign-in affordance once the hero is in the
          confirmation state — the form is unmounted, so clicking the
          topbar would silently no-op against a null ref. The user is
          mid-flow and already knows where they are. */}
      <HomeTopBar onSignIn={focusHeroForm} hidden={sentTo !== null} />
      <main className="flex-1">
        <HomeHero
          onSubmit={onSubmit}
          pending={pending}
          error={fieldError}
          sentTo={sentTo}
          onUseDifferentEmail={handleUseDifferentEmail}
          inputRef={(node) => {
            rhfEmailRef(node);
            emailInputRef.current = node;
          }}
          inputProps={rhfEmailRest}
          onGoogleSignIn={handleGoogleSignIn}
          googlePending={googlePending}
          googleError={googleError}
        />
        <HomeFeatures />
        <HomeExplainer />
      </main>
      <HomeFooter />
    </div>
  );
}

interface TopBarProps {
  onSignIn: () => void;
  hidden: boolean;
}

function HomeTopBar({ onSignIn, hidden }: TopBarProps) {
  return (
    <header className="sticky top-0 z-20 border-b border-[color:var(--kd-chrome-border)] bg-white">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-5 py-3">
        <div className="flex items-center gap-2.5 text-[color:var(--kd-primary)]">
          <BrandIcon size={28} />
          <span className="text-base font-semibold sm:text-[1.05rem]">Stake Building Access</span>
        </div>
        {/* Topbar Sign-in is a secondary affordance — it scrolls /
            focuses the hero form rather than initiating its own sign-in
            flow. Hidden once the hero swaps to the confirmation state
            (the form is unmounted; clicking would silently no-op). */}
        {hidden ? null : (
          <Button variant="secondary" onClick={onSignIn}>
            Sign in
          </Button>
        )}
      </div>
    </header>
  );
}

interface HeroProps {
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  pending: boolean;
  error: string | null;
  sentTo: string | null;
  onUseDifferentEmail: () => void;
  inputRef: (node: HTMLInputElement | null) => void;
  // Spread these onto the input (`name`, `onChange`, `onBlur`) — the
  // value is owned by react-hook-form internally; the field stays
  // uncontrolled at the DOM level which is what RHF expects.
  inputProps: Omit<React.ComponentPropsWithoutRef<typeof Input>, 'ref'>;
  onGoogleSignIn: () => void;
  googlePending: boolean;
  googleError: string | null;
}

function HomeHero(props: HeroProps) {
  const {
    onSubmit,
    pending,
    error,
    sentTo,
    onUseDifferentEmail,
    inputRef,
    inputProps,
    onGoogleSignIn,
    googlePending,
    googleError,
  } = props;
  return (
    <section className="border-b border-[color:var(--kd-border-soft)]">
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-5 py-14 text-center sm:py-20">
        <h1 className="m-0 text-[1.6rem] font-semibold leading-tight tracking-tight text-[color:var(--kd-fg-1)] sm:text-[2.1rem]">
          Building access for your stake.
        </h1>
        <p className="mx-auto mt-4 max-w-[44ch] text-[1rem] leading-relaxed text-[color:var(--kd-fg-2)] sm:text-[1.05rem]">
          Grant church members access to the buildings they need &mdash; approved by the right
          leaders.
        </p>

        <div className="mt-8 w-full max-w-[28rem]">
          {sentTo ? (
            <ConfirmationState sentTo={sentTo} onUseDifferentEmail={onUseDifferentEmail} />
          ) : (
            <div className="flex flex-col gap-3 text-left">
              {/* Google CTA — primary affordance, auto-width so it
                  doesn't visually merge with the magic-link submit
                  below. With Firebase Auth's "one account per email
                  address" project setting both providers resolve to
                  the same UID. */}
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
                <span className="text-xs uppercase tracking-wide text-[color:var(--kd-fg-3)]">
                  or
                </span>
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
                  ref={inputRef}
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  spellCheck={false}
                  disabled={pending || googlePending}
                  placeholder="you@example.com"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? 'signin-email-error' : undefined}
                  {...inputProps}
                />
                <Button
                  type="submit"
                  disabled={pending || googlePending}
                  className="w-full text-[0.95rem]"
                >
                  {pending ? 'Sending…' : 'Send me a sign-in link'}
                </Button>
                {error ? (
                  <div
                    role="alert"
                    id="signin-email-error"
                    className="text-sm text-[color:var(--kd-danger-fg)]"
                  >
                    {error}
                  </div>
                ) : null}
              </form>
            </div>
          )}
        </div>

        <p className="mx-auto mt-8 max-w-[44ch] text-sm leading-relaxed text-[color:var(--kd-fg-2)]">
          {PENDING_AUTH_COPY}
        </p>
      </div>
    </section>
  );
}

interface ConfirmationStateProps {
  sentTo: string;
  onUseDifferentEmail: () => void;
}

function ConfirmationState({ sentTo, onUseDifferentEmail }: ConfirmationStateProps) {
  return (
    <div
      className="flex flex-col gap-3 rounded border border-[color:var(--kd-border-soft)] bg-white p-5 text-left"
      data-testid="signin-confirmation"
    >
      <h2 className="m-0 text-[1.05rem] font-semibold text-[color:var(--kd-fg-1)]">
        Check your email
      </h2>
      <p className="m-0 text-sm leading-relaxed text-[color:var(--kd-fg-2)]">
        We sent a sign-in link to <strong className="text-[color:var(--kd-fg-1)]">{sentTo}</strong>.
        Open it on this device to finish signing in.
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

function HomeFeatures() {
  const items: { title: string; body: string }[] = [
    {
      title: 'Request access for any member, any building',
      body: 'Ward leaders submit requests for the buildings and members they oversee.',
    },
    {
      title: 'Auto-expiring temporary grants',
      body: 'Short-term access expires on its own — no follow-up to chase down.',
    },
  ];
  return (
    <section className="bg-[color:var(--kd-surface-alt)] border-b border-[color:var(--kd-border-soft)]">
      <div className="mx-auto w-full max-w-5xl px-5 py-12 sm:py-14">
        <ul className="grid list-none grid-cols-1 gap-6 p-0 sm:grid-cols-2 sm:gap-8">
          {items.map((item) => (
            <li
              key={item.title}
              className="flex flex-col gap-1.5 border-l-2 border-[color:var(--kd-primary-tint)] pl-4 text-left"
            >
              <h2 className="m-0 text-[1rem] font-semibold text-[color:var(--kd-fg-1)]">
                {item.title}
              </h2>
              <p className="m-0 text-[0.95rem] leading-relaxed text-[color:var(--kd-fg-2)]">
                {item.body}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function HomeExplainer() {
  return (
    <section>
      <div className="mx-auto w-full max-w-3xl px-5 py-12 text-center sm:py-14">
        <p className="m-0 text-[0.98rem] leading-relaxed text-[color:var(--kd-fg-2)]">
          Built for stake and ward leaders. Kindoo provisioning is handled by your stake&rsquo;s
          Kindoo Manager — you focus on who needs access; the system handles the rest.
        </p>
      </div>
    </section>
  );
}

function HomeFooter() {
  return (
    <footer className="border-t border-[color:var(--kd-chrome-border)] bg-white">
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-center gap-3 px-5 py-5 text-sm text-[color:var(--kd-chrome-fg-muted)] sm:flex-row sm:gap-6">
        <Link to="/privacy" className="text-[color:var(--kd-primary)] hover:underline">
          Privacy
        </Link>
        <span aria-hidden="true" className="hidden text-[color:var(--kd-border)] sm:inline">
          ·
        </span>
        <a
          href={CHROME_WEB_STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[color:var(--kd-primary)] hover:underline"
        >
          Chrome extension
        </a>
        <span aria-hidden="true" className="hidden text-[color:var(--kd-border)] sm:inline">
          ·
        </span>
        <a href={CONTACT_MAILTO} className="text-[color:var(--kd-primary)] hover:underline">
          Contact
        </a>
      </div>
    </footer>
  );
}
