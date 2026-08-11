# Extension sign-in without a Google account — delegating to the SPA for a custom token

**Shipped:** 2026-08-11
**Commits:** `feat/extension-any-email-signin` (PR #282), folded from `feat/ext-auth-callable`, `feat/ext-auth-route`, `feat/ext-auth-client`, `feat/ext-auth-infra`

## What shipped

A Kindoo Manager who holds no Google account can now sign the Chrome extension in. The signed-out panel has a second button — **Sign in with email** — beside the original **Sign in with Google**. It opens the SPA's new `/auth/extension` route inside `chrome.identity.launchWebAuthFlow`, the manager signs in there by whichever provider they have, confirms on a card that names the account, and the SPA hands a Firebase **custom** token back on the fragment of the extension's own callback URL. The service worker exchanges it via `signInWithCustomToken`. Recorded as **D33**.

- **`mintExtensionToken`** (`functions/src/callable/mintExtensionToken.ts`) — no payload, gated on `request.auth` and nothing further, mints for the caller's own uid, returns `{ token }`, writes nothing.
- **`/auth/extension`** (`apps/web/src/routes/auth/extension.tsx`) — public route, sibling of `/auth/email-link`. Two gates gate the mint (below); renders the shared provider block when signed out, the confirm card when signed in.
- **`isAllowedRedirectUri`** (`apps/web/src/features/auth/extensionRedirect.ts`) — the trust boundary, and the only sanctioned way to decide whether a handoff may proceed.
- **`signInViaWeb`** (`extension/src/lib/auth.ts`) — the `launchWebAuthFlow` call, the fragment parse, and the custom-token exchange, alongside the untouched `signIn`.

The Google path is byte-for-byte unchanged. The two are alternatives a manager picks between, not a fallback chain.

## Why

**Google-only was an exclusion, not a narrowing.** The manager this exists for could hold the role, receive the emails, and work the queue on the SPA — and had no way to reach the extension, which is where every Kindoo write actually happens. T-44 gave the SPA a magic link in May; the extension had no way to reach it until now.

**Delegating beats embedding.** Teaching the extension the magic-link provider directly does not work cleanly: `signInWithEmailLink` needs the emailed link to land back on the origin that sent it, and an extension page is not a web origin Firebase Auth will take as a continue URL. It would also mean a second set of Console prerequisites and a second copy of the provider UI to keep in step with the SPA's. Delegating means the extension inherits whatever providers the SPA offers, now and later, with no extension release.

**A custom token, not a relayed ID token.** An ID token expires in an hour and only the context holding the refresh token can renew it. The SPA's session lives in a `launchWebAuthFlow` window the extension cannot re-open silently, so relaying its ID token buys a session that dies an hour in — mid-shift, with no recovery but a full re-sign-in. `signInWithCustomToken` mints the extension its **own** refresh token, which is what survives service-worker suspends and browser restarts.

The custom token is **not** single-use, which is the fact that sets the stakes for everything below. Within its hour it can be redeemed repeatedly, and every redemption yields a full session with its own renewable refresh token. A token that leaks inside that window is a session compromise, not a spent coupon.

## The security boundary, and the version of it that shipped first and was wrong

The route originally validated `redirect_uri` against the *shape* of a Chrome extension callback origin — 32 characters from `a`–`p` under `chromiumapp.org`, no path, no query — and D33 recorded that check as the whole security boundary. The reasoning for why it needn't identify *which* extension was that "completing the handoff requires the user to sign in inside the window that opened it."

**That premise is false, and PR #282's automated reviewer caught it.** A manager who already holds an SPA session on the origin signs in to nothing, and the route minted on mount. So any extension in the profile holding only the `identity` permission could call `launchWebAuthFlow({ interactive: false })` against `/auth/extension` and receive a custom token — no window, no click, nothing observable — exchangeable into a session indistinguishable from the manager's. Every extension's callback origin has the same shape, so shape-only validation trusted every extension installed in the profile.

The generalisable lesson, worth more than the fix: **a check on the shape of an identifier is never a check on who holds it.** The pattern was genuinely restrictive and every clause in it was load-bearing; it bounded the recipient to *a* Chrome extension rather than an arbitrary web origin. It simply never answered *which*, and no amount of tightening the shape could.

Two gates now stand in its place, and they defend different attacks:

1. **The `redirect_uri` must name an extension this build trusts.** The shape test is demoted to a precondition that extracts the ID; `isAllowedRedirectUri` then decides on it. The allowlist is the published extension (`CHROME_EXTENSION_ID`, which also composes the store URL so the linked listing and the trusted extension cannot name two different extensions) plus whatever the comma-separated `VITE_EXTENSION_IDS` adds. That var is **additive and fails closed** — malformed entries are dropped rather than widening the set, and unset degrades to "only the published extension," which is the correct value for staging and production. It exists for unpacked dev builds, whose IDs differ per machine and per profile and so cannot be baked in.
2. **Nothing is minted without an explicit click.** The signed-in branch renders a "Connect the extension" confirm card and the mint fires only from that button. A non-interactive flow renders no UI and therefore can never produce the click — which is what stops a silent harvest *even from an allowlisted ID*. `handleConnect` re-tests the allowlist before minting anyway, so no future refactor can reach the mint without crossing the boundary.

**Neither gate would have been enough alone.** The allowlist without the click still mints on mount, so anything that can get an allowlisted ID into a URL takes a token with nothing on screen. The click without the allowlist stops the silent harvest but still hands the token to whichever extension asked.

**The confirm card earns its keep twice.** Beyond defeating `interactive: false`, it answers a question the auto-mint could not: whose session is being handed over. The browser profile decides that, not the extension, and on a shared or family machine the signed-in account is not always the manager standing there. The card names the account and offers "Not you? Use a different account."

**An allowlist of extension IDs was rejected in the first design and then adopted.** The original objection — that staging, prod, and unpacked builds carry different IDs, so the list would need an env-specific SPA deploy — is answered by the published ID being compiled in and working everywhere with no per-env value. The objection also mis-framed the two as alternatives when they compose: the pattern extracts the ID, the list decides on it.

## A refusal and a cancellation are the same event, so the copy says neither

The SPA never redirects on a cancelled sign-in, and never redirects on a `redirect_uri` it refused. Both leave `launchWebAuthFlow` with nothing and arrive as the identical bare `chrome.runtime.lastError`. There is nothing for the extension to branch on, so the copy is worded per path instead:

- **Google** keeps "Sign-in cancelled. Click again to retry." Chrome's consent dialog has no failure state to explain, so a dismissal there really is a dismissal.
- **Web** reads "Sign-in didn't finish. Click again to retry — unless that window showed a configuration error, in which case retrying won't help."

The SPA renders its refusal reason *inside* the auth window, which is gone by the time the panel message shows. Copy that ordered a retry would overwrite the one explanation the manager was given and loop them on the single action that cannot work. **"configuration error" is shared wording across the two surfaces** — the panel points back at the card by that phrase, the card uses it, and a test on each side pins it. The card is the referent, so on any drift the card's wording wins.

The card also echoes the rejected `redirect_uri` as inert text (never a link, truncated at 120 characters), and `buildWebAuthUrl` logs it before launching. That value is otherwise unobservable from either side, which is what turns "sign-in keeps cancelling" into a diagnosis during a smoke test.

## Prerequisites the operator owns

Both are configured outside the repo and neither is caught by CI, the emulator, or any test:

1. **`kindoo-app@<project>` needs `roles/iam.serviceAccountTokenCreator` on itself.** Under Application Default Credentials, `createCustomToken` signs through the IAM `signBlob` API. The emulator substitutes an unsigned token, so a missing grant is invisible locally and surfaces in a deployed environment as `#error=mint_failed` on every email sign-in. Now in `infra/runbooks/provision-firebase-projects.md` with a retrofit path — neither existing project had it.
2. **`VITE_WEB_BASE_URL` must name the SPA origin for the same environment as that build's `VITE_FIREBASE_*` values.** A custom token minted by the other project will not verify. An unset var now throws "VITE_WEB_BASE_URL is not configured for this build" rather than opening a window that cannot succeed — without that guard it presented, via the failure mapping above, as a permanent "click again to retry" on a button that could never work.

The IAM grant is flagged inside T-26 (the Phase 11 service-account hardening item) so an IAM tidy-up doesn't revoke it. **`VITE_EXTENSION_IDS` is deliberately not a third prerequisite** — unset is the right value everywhere but a developer's own machine.

## Settled during the build

**The `launchWebAuthFlow` window shares the profile's storage.** The two-pass magic-link journey depends on it: the emailed link opens in an ordinary browser tab, not the auth window, so the manager clicks it there, returns to Kindoo, and presses Sign in again — and that second pass finds Firebase Auth already hydrated on the origin. This was the one open question that could have forced a different transport; the operator tested it in their own Chrome and the window opened signed in. The route's copy promises **one button left to press**, not zero, so the instruction matches Gate 2 rather than contradicting it.

## What didn't change

- **The Google path.** `signIn`, the `oauth2` manifest block, the OAuth scopes, and the `sba.googleAccessToken` storage key are untouched.
- **Authorization.** A custom-token session resolves roles from exactly the same custom claims as any other session — §4 is unmodified. A roleless manager who signs in this way lands on NotAuthorized, as they always did. This is also why `mintExtensionToken` needs no role gate: it mints for the caller's own uid, so the token can do exactly what its holder could already do — which is precisely why *which extension receives it* is the question worth gating.
- **Chrome permissions.** `launchWebAuthFlow` rides the `identity` permission the extension already declares; no new permission and no new host permission.
- **Audit.** Minting a session token is not an entity write, so `auditTrigger` fans nothing and the callable is stateless under retry.
- **Firestore rules and indexes.** Nothing touched.

## Spec / doc edits

- `docs/architecture.md` — **D33**: the delegation, the custom-token choice, the two gates and why neither suffices alone, the per-path failure copy, the callable's auth surface, and the rejected alternatives. The entry was corrected in place rather than superseded by a D34 — same decision, wrong the first time, fixed before merge; the wrong version is recorded inside it so the reasoning isn't re-derived.
- `docs/spec.md` §4.1 — the flow in order: surfaces → handoff steps → why a custom token → cancellation and the per-path copy → the SPA half (both gates, the terminal card) → the server half → prerequisites.
- `docs/spec.md` §5.0 — names `/auth/email-link` and `/auth/extension` as the two ungated routes that are handoff endpoints rather than pages.
- `docs/spec.md` §15 — the "all extension callables propagate `stakeId`" claim now says which callables it means and notes `mintExtensionToken` is stake-agnostic and SPA-invoked.
- `docs/firebase-schema.md` §7 — `mintExtensionToken` row, carrying the IAM prerequisite.
- `CLAUDE.md` — follow-up bullet; T-26 flagged not to revoke the self-grant.
- `apps/web/CLAUDE.md` — the sign-in providers are one component with two hosts; add providers there, never in a host page.
- `functions/CLAUDE.md` — `mintExtensionToken.ts` in the callable tree (plus `createStake.ts` and `backfillEqPresidentAccess.ts`, which were already missing).
- `extension/CLAUDE.md` — two-path auth section, the per-path `consent_dismissed` wording rule, and the `signOut()` rule.
- `docs/user-guide/kindoo-managers.html` §3 — install step names both buttons; callouts cover the email path, the confirm card, and the magic link's extra step; §13 gains a sign-in troubleshooting entry.
- `infra/runbooks/provision-firebase-projects.md`, `infra/runbooks/deploy.md`, `infra/runbooks/extension-deploy.md`, `apps/web/.env.example`, `extension/.env.example` — the IAM grant, `VITE_WEB_BASE_URL`, and `VITE_EXTENSION_IDS`.
- `docs/TASKS.md` — the placeholder task `web-engineer` filed against D33(d) is removed rather than numbered; correcting D33 here completed it on arrival.

## Known issue

`apps/web/src/routes/privacy.tsx` §5 and §6 still describe the extension's authentication as Google-only — "uses Chrome's built-in identity API to request a Google OAuth access token, which it exchanges for a Firebase session," and the `identity` permission justified solely as "to obtain a Google OAuth access token." Both are now incomplete: the web handoff uses `chrome.identity.launchWebAuthFlow`, obtains no Google token, and persists no `sba.googleAccessToken`. (§5's "The web app uses Google Sign-In" has also been stale since T-44.) That page is the privacy URL declared on the Chrome Web Store listing, so the copy is user-facing and review-visible. It is application source, owned by `web-engineer`.
