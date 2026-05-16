// Signed-out landing page. The route at `/` renders this whenever no
// Firebase Auth user is present (see `routes/index.tsx` gate decision).
//
// Audience is ward + stake leadership (bishopric, stake presidency,
// executive secretaries, clerks) — the people who request and approve
// building access. Kindoo provisioning lives downstream in the Chrome
// extension; the homepage acknowledges it but does not pitch it.
//
// Layout: top bar (brand + secondary Sign-in), hero (headline + primary
// Sign-in CTA), three short feature bullets, an explanatory paragraph,
// a thin footer with Privacy / Chrome extension / Contact links. The
// duplicate Sign-in is intentional — operator complaint was that the
// previous page had nothing *except* the button, but signed-out flow
// still needs the CTA prominent and reachable from the topbar after the
// user has scrolled.
//
// Both buttons route through the shadcn `<Button>` primitive so they
// pick up the `.btn` chrome from `base.css`. Tailwind v4's preflight
// would otherwise strip background + padding from bare `<button>`s
// (the bug that bit this page in PR #12, regression-guarded by
// `e2e/tests/auth/sign-in-button-renders.spec.ts`).

import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { BrandIcon } from '../../components/layout/BrandIcon';
import { signIn } from './signIn';

const CHROME_WEB_STORE_URL = 'https://chrome.google.com/webstore';
const CONTACT_MAILTO = 'mailto:support@stakebuildingaccess.org';

export function SignInPage() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSignIn() {
    setError(null);
    setPending(true);
    try {
      await signIn();
    } catch (err) {
      // `signInWithPopup` rejects with `FirebaseError` for popup-blocked,
      // user-cancelled, network failure, etc. We surface the message
      // verbatim so the operator can debug without opening devtools.
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#f7f8fb] text-[color:var(--kd-fg-1)]">
      <HomeTopBar onSignIn={handleSignIn} pending={pending} />
      <main className="flex-1">
        <HomeHero onSignIn={handleSignIn} pending={pending} error={error} />
        <HomeFeatures />
        <HomeExplainer />
      </main>
      <HomeFooter />
    </div>
  );
}

interface CtaProps {
  onSignIn: () => void;
  pending: boolean;
}

function HomeTopBar({ onSignIn, pending }: CtaProps) {
  return (
    <header className="sticky top-0 z-20 border-b border-[color:var(--kd-chrome-border)] bg-white">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-5 py-3">
        <div className="flex items-center gap-2.5 text-[color:var(--kd-primary)]">
          <BrandIcon size={28} />
          <span className="text-base font-semibold sm:text-[1.05rem]">Stake Building Access</span>
        </div>
        {/* Distinct accessible name from the hero CTA so the E2E
            `getByRole('button', { name: /Sign in with Google/i })` in
            `e2e/tests/auth/sign-in-button-renders.spec.ts` resolves to
            a single element (Playwright's getByRole is strict-mode). The
            shorter "Sign in" label also fits the topbar visually. */}
        <Button variant="secondary" onClick={onSignIn} disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </div>
    </header>
  );
}

interface HeroProps extends CtaProps {
  error: string | null;
}

function HomeHero({ onSignIn, pending, error }: HeroProps) {
  return (
    <section className="border-b border-[color:var(--kd-border-soft)]">
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-5 py-14 text-center sm:py-20">
        <h1 className="m-0 text-[1.6rem] font-semibold leading-tight tracking-tight text-[color:var(--kd-fg-1)] sm:text-[2.1rem]">
          Building access for your stake.
        </h1>
        <p className="mx-auto mt-4 max-w-[44ch] text-[1rem] leading-relaxed text-[color:var(--kd-fg-2)] sm:text-[1.05rem]">
          Grant church members the doors they need — approved by the right leaders.
        </p>
        <div className="mt-7">
          {/* No aria-label — visible text is the accessible name. The
              hero CTA is the canonical sign-in target for the E2E in
              `e2e/tests/auth/sign-in-button-renders.spec.ts`. Topbar
              has the shorter label "Sign in" so the two roles are
              unambiguous under Playwright's strict-mode getByRole. */}
          <Button onClick={onSignIn} disabled={pending} className="text-[0.95rem]">
            {pending ? 'Signing in…' : 'Sign in with Google'}
          </Button>
        </div>
        {error ? (
          <div role="alert" className="mt-4 max-w-[40ch] text-sm text-[color:var(--kd-danger-fg)]">
            Sign-in failed: {error}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function HomeFeatures() {
  // Three short factual bullets. We avoid the marketing-card / icon
  // treatment — same restrained voice as the rest of the SPA. Each
  // bullet is a single line on desktop, one block per row on phone.
  const items: { title: string; body: string }[] = [
    {
      title: 'Request access for any member, any building',
      body: 'Ward leaders submit requests for the buildings and members they oversee.',
    },
    {
      title: 'Routed to the right approver',
      body: 'Each request lands with the leader whose approval is required for that building.',
    },
    {
      title: 'Auto-expiring temporary grants',
      body: 'Short-term access expires on its own — no follow-up to chase down.',
    },
  ];
  return (
    <section className="bg-[color:var(--kd-surface-alt)] border-b border-[color:var(--kd-border-soft)]">
      <div className="mx-auto w-full max-w-5xl px-5 py-12 sm:py-14">
        <ul className="grid list-none grid-cols-1 gap-6 p-0 sm:grid-cols-3 sm:gap-8">
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
