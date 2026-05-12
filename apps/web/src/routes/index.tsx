// Root route handler. Gate ordering per `docs/spec.md` §10.
//
// The branch picker is `gateDecision()` in `lib/setupGate.ts` — same
// module powers `routes/_authed.tsx` so the two gates can never drift.
// See that module's header for the full rule table; the short version:
//
//   1. No Firebase Auth user                → SignInPage.
//   2. Stake-doc subscription pending       → render null.
//   3. Stake doc loaded with setup_complete !== true (incl. doc absent
//      and missing field — Option A from the bug report):
//        a. Token email matches stake.bootstrap_admin_email →
//           BootstrapWizardPage. `?p=` deep-links are ignored until
//           the wizard finishes.
//        b. Otherwise (incl. claim-bearing users) →
//           SetupInProgressPage. Setup precedence over both Dashboard
//           and NotAuthorized is the staging-bug fix.
//   4. Stake doc loaded with setup_complete === true:
//        a. No role claims → NotAuthorizedPage.
//        b. Claim-bearing  → redirect to default landing
//                            (`?p=` wins over per-role).
//
// Back-compat deep-link: `/?p=<page-key>` lands the user on the
// matching SPA route after the gate runs. Page keys mirror the Apps
// Script keys. Unknown keys fall back to the role default.

import { useEffect } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { SignInPage } from '../features/auth/SignInPage';
import { NotAuthorizedPage } from '../features/auth/NotAuthorizedPage';
import { SetupInProgressPage } from '../features/auth/SetupInProgressPage';
import { BootstrapWizardPage } from '../features/bootstrap/BootstrapWizardPage';
import { usePrincipal } from '../lib/principal';
import { defaultLandingFor, deepLinkPath } from '../lib/routing';
import { useFirestoreDoc } from '../lib/data';
import { stakeRef } from '../lib/docs';
import { db } from '../lib/firebase';
import { STAKE_ID } from '../lib/constants';
import { gateDecision } from '../lib/setupGate';

const indexSearchSchema = z.object({
  p: z.string().optional(),
});

export type IndexSearch = z.infer<typeof indexSearchSchema>;

export const Route = createFileRoute('/')({
  validateSearch: (raw): IndexSearch => indexSearchSchema.parse(raw),
  component: Index,
});

function Index() {
  const principal = usePrincipal();
  const navigate = useNavigate();
  const stake = useFirestoreDoc(principal.firebaseAuthSignedIn ? stakeRef(db, STAKE_ID) : null);
  // Typed search params from `validateSearch`. The autogen plugin
  // wires `Route.useSearch()` so the `p` field is statically known
  // here; we still use the raw URLSearchParams shape for parity with
  // the schema's `.optional()` field.
  const { p } = Route.useSearch();

  const decision = gateDecision(principal, { data: stake.data, status: stake.status });

  // Decide where to send a fully-authed principal. Only meaningful
  // when the gate has cleared all the setup-precedence branches.
  const target = decision === 'authed' ? (deepLinkPath(p) ?? defaultLandingFor(principal)) : null;

  useEffect(() => {
    if (target !== null) {
      navigate({ to: target, replace: true }).catch(() => {
        // Navigation can fail when the target route hasn't been built
        // yet (some `?p=` keys map to routes that arrive in later
        // phases). Swallow — the user sees the SignInPage again rather
        // than a hung loading state.
      });
    }
  }, [target, navigate]);

  switch (decision) {
    case 'sign-in':
      return <SignInPage />;
    case 'pending':
      return null;
    case 'wizard':
      return <BootstrapWizardPage />;
    case 'setup-in-progress':
      return <SetupInProgressPage />;
    case 'not-authorized':
      return <NotAuthorizedPage />;
    case 'authed':
      // Redirect is in flight via the useEffect above. Render
      // nothing in the meantime so we don't flash anything.
      return null;
  }
}
