// Root route handler. Three jobs, in this order:
//
//   1. Render the SignInPage when no Firebase Auth user is present.
//   2. Render the NotAuthorizedPage when the user is signed in but
//      has no role claims (the "weekly LCR import hasn't run yet"
//      lag described in `docs/spec.md` §6 + the wrong-account case).
//   3. Redirect to the principal's default landing page when both
//      signed in and at least one role claim is present.
//
// The default-landing rule mirrors `Router_defaultPageFor_` in the
// Apps Script Router — manager > stake > bishopric priority, leftmost
// nav tab per role. See `docs/spec.md` §5.
//
// Back-compat deep-link: `/?p=<page-key>` lands the user on the
// matching SPA route after the gate runs. Page keys mirror the Apps
// Script keys. Unknown keys are ignored (the principal lands on the
// default tab as if no `?p` was present). Phase 5 wires the read-side
// pages; Phase 6+ adds the remaining keys.

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

  // Bootstrap gate (must run BEFORE role-based redirect). Phase 7
  // routing per `docs/spec.md` §10: if `stake.setup_complete=false`,
  // the bootstrap admin sees the wizard and everyone else sees the
  // SetupInProgress page — `?p=` deep-links are deliberately ignored
  // until the wizard finishes.
  const setupIncomplete =
    principal.firebaseAuthSignedIn &&
    stake.data !== undefined &&
    stake.data.setup_complete === false;
  const adminCanonical = setupIncomplete
    ? canonicalEmailFn(stake.data?.bootstrap_admin_email ?? '')
    : '';
  const meCanonical = principal.canonical ?? canonicalEmailFn(principal.email ?? '');

  // Decide where to send an authenticated principal. `p=...` wins over
  // the per-role default when it resolves to a known route; otherwise
  // we fall back to the role's leftmost nav tab. Only meaningful when
  // setup is complete AND the stake-doc subscription has resolved
  // (otherwise `setupIncomplete` reads false transiently and we'd
  // redirect a bootstrap admin away from the wizard).
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

  // Wait for stake doc to load before deciding setup-state branches —
  // a flash of NotAuthorized while the doc is in flight would be
  // wrong on a fresh stake.
  if (stake.status === 'pending') {
    return null;
  }

  if (setupIncomplete) {
    if (adminCanonical && meCanonical && adminCanonical === meCanonical) {
      return <BootstrapWizardPage />;
    }
    return <SetupInProgressPage />;
  }

  if (!principal.isAuthenticated) {
    return <NotAuthorizedPage />;
  }
  // While the redirect effect is pending, render nothing (a flash of
  // the previous page is preferable to a flash of unrelated content).
  return null;
}
