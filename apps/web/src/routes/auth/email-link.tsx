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
//      back to the sign-in page.

import { useEffect, useState, type FormEvent } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { BrandIcon } from '../../components/layout/BrandIcon';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import {
  clearStashedEmail,
  completeSignInWithEmailLink,
  isSignInWithEmailLink,
  peekStashedEmail,
  readAndClearStashedEmail,
} from '../../features/auth/signIn';

export const Route = createFileRoute('/auth/email-link')({
  component: EmailLinkActionPage,
});

type State =
  | { kind: 'verifying' }
  | { kind: 'prompt'; defaultEmail: string }
  | { kind: 'signing-in' }
  | { kind: 'error'; message: string }
  | { kind: 'not-a-link' };

function EmailLinkActionPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: 'verifying' });

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const href = window.location.href;
      if (!isSignInWithEmailLink(href)) {
        if (!cancelled) setState({ kind: 'not-a-link' });
        return;
      }
      const stashed = readAndClearStashedEmail();
      if (!stashed) {
        // Cross-device — user typed the email on one device, opened
        // the link on another. Prompt for it; the user resolves the
        // signing-in branch from the form below.
        if (!cancelled) setState({ kind: 'prompt', defaultEmail: '' });
        return;
      }
      if (!cancelled) setState({ kind: 'signing-in' });
      try {
        await completeSignInWithEmailLink(stashed, href);
        if (!cancelled) {
          navigate({ to: '/', replace: true }).catch(() => {
            // Same swallow as the gate in routes/index.tsx — the
            // user lands back on the sign-in page if navigation
            // fails for any reason.
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!cancelled) setState({ kind: 'error', message });
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  async function handlePromptSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const typed = String(data.get('email') ?? '').trim();
    if (!typed) {
      setState({ kind: 'error', message: 'Enter the email address the link was sent to.' });
      return;
    }
    setState({ kind: 'signing-in' });
    try {
      await completeSignInWithEmailLink(typed, window.location.href);
      // Defensive — `readAndClearStashedEmail` may have left a
      // value if the user opened the link both on this device and
      // another; ensure we don't carry it forward.
      clearStashedEmail();
      navigate({ to: '/', replace: true }).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ kind: 'error', message });
    }
  }

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

          {state.kind === 'prompt' ? <CrossDevicePrompt onSubmit={handlePromptSubmit} /> : null}

          {state.kind === 'error' ? <ErrorCard message={state.message} /> : null}

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
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

function CrossDevicePrompt({ onSubmit }: CrossDevicePromptProps) {
  // If the localStorage entry is somehow still present (e.g. user opened
  // the link twice from the same device in quick succession) prefill the
  // field so they don't have to retype.
  const stashed = peekStashedEmail();
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
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        defaultValue={stashed ?? ''}
        placeholder="you@example.com"
        required
      />
      <Button type="submit">Confirm and sign in</Button>
    </form>
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
