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
import { SignInPage } from '../features/auth/SignInPage';
import { NotAuthorizedPage } from '../features/auth/NotAuthorizedPage';
import { usePrincipal } from '../lib/principal';
import { defaultLandingFor, deepLinkPath } from '../lib/routing';

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
  // Typed search params from `validateSearch`. The autogen plugin
  // wires `Route.useSearch()` so the `p` field is statically known
  // here; we still use the raw URLSearchParams shape for parity with
  // the schema's `.optional()` field.
  const { p } = Route.useSearch();

  // Decide where to send an authenticated principal. `p=...` wins over
  // the per-role default when it resolves to a known route; otherwise
  // we fall back to the role's leftmost nav tab.
  const target = principal.isAuthenticated
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
  if (!principal.isAuthenticated) {
    return <NotAuthorizedPage />;
  }
  // While the redirect effect is pending, render nothing (a flash of
  // the previous page is preferable to a flash of unrelated content).
  return null;
}
