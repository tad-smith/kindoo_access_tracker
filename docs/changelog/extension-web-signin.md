# Extension sign-in without a Google account — delegating to the SPA for a custom token

**Shipped:** 2026-08-11
**Commits:** `feat/extension-any-email-signin` (PR #282), folded from `feat/ext-auth-callable`, `feat/ext-auth-route`, `feat/ext-auth-client`

## What shipped

A Kindoo Manager who holds no Google account can now sign the Chrome extension in. The signed-out panel has a second button — **Sign in with email** — beside the original **Sign in with Google**. It opens the SPA's new `/auth/extension` route inside `chrome.identity.launchWebAuthFlow`, the manager signs in there by whichever provider they have, and the SPA hands a Firebase **custom** token back on the fragment of the extension's own callback URL. The service worker exchanges it via `signInWithCustomToken`. Recorded as **D33**.

Three pieces, one per folded branch:

- **`mintExtensionToken`** (`functions/src/callable/mintExtensionToken.ts`) — no payload, gated on `request.auth` and nothing further, mints for the caller's own uid, returns `{ token }`, writes nothing.
- **`/auth/extension`** (`apps/web/src/routes/auth/extension.tsx`) — public route, sibling of `/auth/email-link`. Validates `redirect_uri`, renders the shared provider block when signed out, mints and redirects when signed in.
- **`signInViaWeb`** (`extension/src/lib/auth.ts`) — the `launchWebAuthFlow` call, the fragment parse, and the custom-token exchange, alongside the untouched `signIn`.

The Google path is byte-for-byte unchanged. The two are alternatives a manager picks between, not a fallback chain.

## Why

**Google-only was an exclusion, not a narrowing.** The manager this exists for could hold the role, receive the emails, and work the queue on the SPA — and had no way at all to reach the extension, which is where every Kindoo write actually happens. T-44 gave the SPA a magic link in May; the extension had no way to reach it until now.

**Delegating beats embedding.** Teaching the extension the magic-link provider directly does not work cleanly: `signInWithEmailLink` needs the emailed link to land back on the origin that sent it, and an extension page is not a web origin Firebase Auth will take as a continue URL. It would also mean a second set of Console prerequisites and a second copy of the provider UI to keep in step with the SPA's. Delegating means the extension inherits whatever providers the SPA offers, now and later, with no extension release.

**A custom token, not a relayed ID token.** This is the load-bearing choice. An ID token expires in an hour and only the context holding the refresh token can renew it. The SPA's session lives in a `launchWebAuthFlow` window the extension cannot re-open silently, so relaying its ID token buys a session that dies an hour in — mid-shift, with no recovery but a full re-sign-in. `signInWithCustomToken` mints the extension its **own** refresh token, which is what survives service-worker suspends and browser restarts. Everything else in the design follows from wanting that property.

**`redirect_uri` validation is the entire security boundary, so it is the first thing the route does.** `REDIRECT_URI_PATTERN` is anchored on a 32-character `a`–`p` extension ID under `chromiumapp.org`, with no path and no query. A value that fails gets a terminal error card and **no redirect of any kind** — deliberately no "continue anyway," which would defeat the check. A missing or non-string param degrades to `''` rather than throwing, so it lands in that same card instead of the router's error boundary, which would tell the user nothing.

What the check bounds is worth stating precisely: a fragment can only ever be delivered to a Chrome extension's own callback origin, never to an arbitrary web origin. It does not distinguish this extension from another one the user has installed — and does not need to, because the mint conveys only the caller's own authority and completing the handoff requires the user to sign in inside the window that opened it. An allow-list of known extension IDs was rejected: staging, prod, and unpacked dev builds carry different IDs, so the list would need an env-specific SPA deploy to admit each one.

**The callable gates on `request.auth` and stops there.** Adding a manager check would fork authorization: the extension's own callables already gate, Firestore rules already gate, and a mint that refused a roleless caller would trade a clear NotAuthorized screen inside the extension for an opaque sign-in failure in a browser window. **No `developerClaims`** for the same reason in a different register — claims written by `setCustomUserClaims` live on the user record and appear in every ID token minted for that uid, custom-token sign-ins included, so the `stakes` block survives the exchange untouched. Passing one through `developerClaims` (which the Admin SDK nests under the token's own `claims` field rather than merging) would fork the source of truth behind every `claims.stakes[...]` read in rules and `usePrincipal()`, and fork it to a mint-time snapshot.

**Cancellation has no redirect shape.** The SPA never redirects on a cancelled sign-in, so a closed window arrives as a `launchWebAuthFlow` failure with no redirect URL — mapped to the existing `consent_dismissed` code so the panel reuses the Google path's quiet retry copy. A **rejected `redirect_uri` looks identical from the extension's side**: Chrome hands back nothing either way. That is why `buildWebAuthUrl` logs the redirect URI it sends. Without that line, a config fault is a retry-forever dead end wearing a "click again" message; with it, one look at the service-worker console during a smoke test settles which of the two happened.

**Every `#error=<code>` is a hard failure, unrecognised codes included.** `mint_failed` is the only code the SPA emits today. An installed build that predates a future code must degrade to an error, never fall through to "success with no token."

**The web path persists no Google access token, and `signOut()` still serves both.** Writing a `googleAccessToken` for a session that has none would be a lie the sign-out path acts on. The cached-token probe in `signOut()` resolves `undefined` when there is nothing to revoke and falls through to `firebaseSignOut` — a manager who cannot sign out is worse off than one who cannot sign in.

## Two operator prerequisites, neither of which fails locally

Both are configured outside the repo and neither is caught by CI, the emulator, or any test:

1. **`kindoo-app@<project>` needs `roles/iam.serviceAccountTokenCreator` on itself.** Under Application Default Credentials, `createCustomToken` signs through the IAM `signBlob` API. The emulator substitutes an unsigned token, so a missing grant is invisible locally and surfaces in a deployed environment as `#error=mint_failed` on every email sign-in.
2. **`VITE_WEB_BASE_URL` must name the SPA origin for the same environment as that build's `VITE_FIREBASE_*` values.** A custom token minted by the other project will not verify.

The first is now flagged inside T-26 (the Phase 11 service-account hardening item) so an IAM tidy-up doesn't revoke it.

## What didn't change

- **The Google path.** `signIn`, the `oauth2` manifest block, the OAuth scopes, and the `sba.googleAccessToken` storage key are untouched.
- **Authorization.** A custom-token session resolves roles from exactly the same custom claims as any other session — §4 is unmodified. A roleless manager who signs in this way lands on NotAuthorized, as they always did.
- **Chrome permissions.** `launchWebAuthFlow` rides the `identity` permission the extension already declares; no new permission and no new host permission.
- **Audit.** Minting a session token is not an entity write, so `auditTrigger` fans nothing and the callable is stateless under retry.
- **Firestore rules and indexes.** Nothing touched.

## Spec / doc edits

- `docs/architecture.md` — **D33** added: the delegation, the custom-token choice, the `redirect_uri` boundary and what it does and does not bound, the callable's auth surface, and the rejected alternatives.
- `docs/spec.md` §4.1 — the folded flow reads in order: surfaces → handoff steps → why a custom token → cancellation → the SPA half → the server half. Cancellation and the no-Google-token property were split apart (one paragraph was carrying both). The `redirect_uri` bullet gained the empty-param degradation. The deployment-prerequisites list dropped its stale "before T-44 ships" framing (T-44 shipped 2026-05-18) and gained the IAM self-grant; the duplicate authorized-domains sentence above it now points at the list instead of restating it.
- `docs/spec.md` §5.0 — names `/auth/email-link` and `/auth/extension` as the two ungated routes that are handoff endpoints rather than pages.
- `docs/spec.md` §15 — the "all extension callables propagate `stakeId`" claim now says which callables it means and notes that `mintExtensionToken` is stake-agnostic and SPA-invoked.
- `docs/firebase-schema.md` §7 — `mintExtensionToken` row, carrying the IAM prerequisite.
- `CLAUDE.md` — follow-up bullet; T-26 flagged not to revoke the self-grant.
- `apps/web/CLAUDE.md` — the sign-in providers are one component with two hosts; add providers there, never in a host page.
- `functions/CLAUDE.md` — `mintExtensionToken.ts` in the callable tree (plus `createStake.ts` and `backfillEqPresidentAccess.ts`, which were already missing).
- `extension/CLAUDE.md` — two-path auth section, failure mapping, and the `signOut()` rule (written with the extension change).
- `docs/user-guide/kindoo-managers.html` §3 — install step 3 names both buttons; a callout explains the email path and the one extra step the magic link costs; §13 gains a sign-in troubleshooting entry.
- `infra/runbooks/extension-deploy.md`, `extension/.env.example` — `VITE_WEB_BASE_URL` (written with the extension change).

## Known issue

`apps/web/src/routes/privacy.tsx` §5 and §6 still describe the extension's authentication as Google-only — "uses Chrome's built-in identity API to request a Google OAuth access token, which it exchanges for a Firebase session," and the `identity` permission justified solely as "to obtain a Google OAuth access token." Both are now incomplete: the web handoff uses `chrome.identity.launchWebAuthFlow`, obtains no Google token, and persists no `sba.googleAccessToken`. That page is the privacy URL declared on the Chrome Web Store listing, so the copy is user-facing and review-visible. It is application source, owned by `web-engineer`.
