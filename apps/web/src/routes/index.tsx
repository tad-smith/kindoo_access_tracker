// Root route handler. Gate ordering per `docs/firebase-migration.md`
// §Phase 7 "Setup-complete gate" + `docs/spec.md` §10:
//
//   1. No Firebase Auth user → SignInPage.
//   2. Stake-doc subscription still pending → render null (avoid
//      flashing NotAuthorized while the snapshot is in flight).
//   3. Stake doc loaded with `setup_complete=false`:
//        a. Bootstrap admin (token email matches stake.bootstrap_admin_email)
//           → BootstrapWizardPage. `?p=` deep-links are ignored until
//           the wizard finishes.
//        b. Anyone else → SetupInProgressPage. **SetupInProgress takes
//           precedence over NotAuthorized during setup**, including
//           users with zero claims. Spec §10: non-admins during
//           bootstrap aren't unauthorised, the app simply isn't ready
//           yet for them.
//   4. Stake doc loaded with `setup_complete=true` and no role claims
//      → NotAuthorizedPage (wrong account / bishopric-import lag from
//      `docs/spec.md` §6).
//   5. Authenticated principal post-setup → redirect to default
//      landing (`?p=` wins over the per-role default).
//
// Back-compat deep-link: `/?p=<page-key>` lands the user on the
// matching SPA route after the gate runs. Page keys mirror the Apps
// Script keys. Unknown keys fall back to the role default.

import { useEffect } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { canonicalEmail as canonicalEmailFn } from '@kindoo/shared';
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

  const setupIncomplete = stake.data !== undefined && stake.data.setup_complete === false;
  const adminCanonical = setupIncomplete
    ? canonicalEmailFn(stake.data?.bootstrap_admin_email ?? '')
    : '';
  const meCanonical = principal.canonical ?? canonicalEmailFn(principal.email ?? '');
  const isBootstrapAdminUser =
    setupIncomplete && adminCanonical && meCanonical && adminCanonical === meCanonical;

  // Decide where to send an authenticated principal. `p=...` wins over
  // the per-role default when it resolves to a known route; otherwise
  // we fall back to the role's leftmost nav tab. Only meaningful when
  // setup is complete AND the stake-doc subscription has resolved.
  const target =
    principal.isAuthenticated && !setupIncomplete && stake.status !== 'pending'
      ? (deepLinkPath(p) ?? defaultLandingFor(principal))
      : null;

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

  if (!principal.firebaseAuthSignedIn) {
    return <SignInPage />;
  }

  // Wait for the stake-doc subscription to settle before deciding any
  // setup-state branch. With the rules clause that lets any authed
  // user read the parent stake doc during `setup_complete=false`, the
  // subscription resolves quickly for everyone; this prevents flashing
  // NotAuthorized while the snapshot is in flight.
  if (stake.status === 'pending') {
    return null;
  }

  // Setup gate (precedence over NotAuthorized): bootstrap admin →
  // wizard; anyone else (incl. zero-claims users) → SetupInProgress.
  if (setupIncomplete) {
    if (isBootstrapAdminUser) {
      return <BootstrapWizardPage />;
    }
    return <SetupInProgressPage />;
  }

  // Post-setup: no-claims fallback.
  if (!principal.isAuthenticated) {
    return <NotAuthorizedPage />;
  }

  // Authenticated principal whose role-default redirect is in flight —
  // render nothing. The `useEffect` above fires `navigate(...)` on the
  // next tick.
  return null;
}
