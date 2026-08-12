# Extension sign-in without a Google account — delegating to the SPA for a custom token

**Shipped:** 2026-08-11
**Commits:** `feat/extension-any-email-signin` (PR #282), folded from `feat/ext-auth-callable`, `feat/ext-auth-route`, `feat/ext-auth-client`, `feat/ext-auth-infra`

## What shipped

A Kindoo Manager who holds no Google account can now sign the Chrome extension in. The signed-out panel has a second button — **Sign in with email** — beside the original **Sign in with Google**. It opens the SPA's new `/auth/extension` route inside `chrome.identity.launchWebAuthFlow`, the manager signs in there by whichever provider they have, confirms on a card that names the account, and the SPA hands a Firebase **custom** token back on the fragment of the extension's own callback URL. The service worker exchanges it via `signInWithCustomToken`. Recorded as **D33**.

- **`mintExtensionToken`** (`functions/src/callable/mintExtensionToken.ts`) — no payload, gated on `request.auth` and nothing further, mints for the caller's own uid, returns `{ token }`, writes nothing.
- **`/auth/extension`** (`apps/web/src/routes/auth/extension.tsx`) — public route, sibling of `/auth/email-link`. Two gates gate the mint (below); renders the shared provider block when signed out, the confirm card when signed in.
- **`isAllowedRedirectUri`** (`apps/web/src/features/auth/extensionRedirect.ts`) — the trust boundary, and the only sanctioned way to decide whether a handoff may proceed.
- **`signInViaWeb`** (`extension/src/lib/auth.ts`) — the `launchWebAuthFlow` call, the fragment parse, and the custom-token exchange, alongside the untouched `signIn`.
- **`/privacy`** (`apps/web/src/routes/privacy.tsx`) — §3, §5, §6, and §7 rewritten for two sign-in paths: the `identity` permission justified against both `getAuthToken` and `launchWebAuthFlow`, the custom-token handoff described, `sba.googleAccessToken` marked as Google-path-only, and the "revoke the OAuth grant" remedy scoped to the path that has one. This page is the privacy URL on the Chrome Web Store listing and reviewers read it against the declared permission list, so it ships with the code it describes.

The Google path is byte-for-byte unchanged. The two are alternatives a manager picks between, not a fallback chain.

## Why

**Google-only was an exclusion, not a narrowing.** The manager this exists for could hold the role, receive the emails, and work the queue on the SPA — and had no way to reach the extension, which is where every Kindoo write actually happens. T-44 gave the SPA a magic link in May; the extension had no way to reach it until now.

**Delegating beats embedding.** Teaching the extension the magic-link provider directly does not work cleanly: `signInWithEmailLink` needs the emailed link to land back on the origin that sent it, and an extension page is not a web origin Firebase Auth will take as a continue URL. It would also mean a second set of Console prerequisites and a second copy of the provider UI to keep in step with the SPA's. Delegating means the extension inherits whatever providers the SPA offers, now and later, with no extension release.

**A custom token, not a relayed ID token.** An ID token expires in an hour and only the context holding the refresh token can renew it. The SPA's session lives in a `launchWebAuthFlow` window the extension cannot re-open silently, so relaying its ID token buys a session that dies an hour in — mid-shift, with no recovery but a full re-sign-in. `signInWithCustomToken` mints the extension its **own** refresh token, which is what survives service-worker suspends and browser restarts.

The custom token is **not** single-use, which is the fact that sets the stakes for everything below. Within its hour it can be redeemed repeatedly, and every redemption yields a full session with its own renewable refresh token. A token that leaks inside that window is a session compromise, not a spent coupon.

**The exchange preserves scope but not duration, and we accepted that rather than missed it.** `mintExtensionToken` mints for the caller's own uid, so it is easy — and we did it in the first draft of this entry and of D33 — to describe the result as conveying "exactly the authority they arrived with." That is true of scope and false of duration: the caller arrives holding an ID token with a one-hour ceiling and leaves with a session that renews itself indefinitely. It is the property every mint-for-itself endpoint has, and it is the point of a custom token rather than a defect in this one; gating the callable harder was considered and rejected, because a caller who can invoke it already holds a valid session and the real boundary is the two SPA-side gates.

The consequence to carry forward is about revocation. **Signing out of the SPA does not end the extension's session** — the two hold independent refresh tokens, and the extension stays signed in until its own `signOut()` runs. Role revocation *does* reach it: the claim-sync triggers call `revokeRefreshTokens` on the uid, which invalidates the extension's refresh token on the same envelope as every other session for that user. Server-side revocation propagates; a user-initiated sign-out on one surface does not.

## The security boundary, and the version of it that shipped first and was wrong

The route originally validated `redirect_uri` against the *shape* of a Chrome extension callback origin — 32 characters from `a`–`p` under `chromiumapp.org`, no path, no query — and D33 recorded that check as the whole security boundary. The reasoning for why it needn't identify *which* extension was that "completing the handoff requires the user to sign in inside the window that opened it."

**That premise is false, and PR #282's automated reviewer caught it.** A manager who already holds an SPA session on the origin signs in to nothing, and the route minted on mount. So any extension in the profile holding only the `identity` permission could call `launchWebAuthFlow({ interactive: false })` against `/auth/extension` and receive a custom token — no window, no click, nothing observable — exchangeable into a session indistinguishable from the manager's. Every extension's callback origin has the same shape, so shape-only validation trusted every extension installed in the profile.

The generalisable lesson, worth more than the fix: **a check on the shape of an identifier is never a check on who holds it.** The pattern was genuinely restrictive and every clause in it was load-bearing; it bounded the recipient to *a* Chrome extension rather than an arbitrary web origin. It simply never answered *which*, and no amount of tightening the shape could.

Two gates now stand in its place, and they defend different attacks:

1. **The `redirect_uri` must name an extension this build trusts.** The shape test is demoted to a precondition that extracts the ID; `isAllowedRedirectUri` then decides on it, against the build's allowlist (below).
2. **Nothing is minted without an explicit click.** The signed-in branch renders a "Connect the extension" confirm card and the mint fires only from that button. A non-interactive flow renders no UI and therefore can never produce the click — which is what stops a silent harvest *even from an allowlisted ID*. `handleConnect` re-tests the allowlist before minting anyway, so no future refactor can reach the mint without crossing the boundary.

**Neither gate would have been enough alone.** The allowlist without the click still mints on mount, so anything that can get an allowlisted ID into a URL takes a token with nothing on screen. The click without the allowlist stops the silent harvest but still hands the token to whichever extension asked.

**The confirm card earns its keep twice.** Beyond defeating `interactive: false`, it answers a question the auto-mint could not: whose session is being handed over. The browser profile decides that, not the extension, and on a shared or family machine the signed-in account is not always the manager standing there. The card names the account and offers "Not you? Use a different account."

**An allowlist of extension IDs was rejected in the first design and then adopted.** The original objection was that staging, prod, and unpacked builds carry different IDs, so the list would need an env-specific SPA deploy. It also mis-framed the two as alternatives when they compose: the pattern extracts the ID, the list decides on it.

**The first version of the allowlist then got that objection's factual half backwards, and the reviewer's second round caught it.** The docs and the code both said the published `CHROME_EXTENSION_ID` was an implicit default everywhere, so `VITE_EXTENSION_IDS` was optional — a developer convenience, with unset "failing closed to published-extension-only." That is not what happens. Chrome strips the manifest `key` from a Web Store build and assigns its own ID at first upload, while every unpacked build keeps the deterministic ID derived from its own per-environment keypair — and `extension/src/manifest.config.ts` sets that `key` per environment, with the deploy runbook having the operator generate a separate keypair for each. So **three distinct IDs are in play**: the Web Store ID, the staging keypair ID, and the prod-mode keypair ID used for the pre-upload smoke test. `CHROME_EXTENSION_ID` is only the first of them. Unset in staging, the allowlist refused every redirect the staging extension sent, breaking both pre-release test paths. The env var was never optional; it only looked that way from production, the one environment where the compiled-in default is the right answer.

What shipped in response draws the line at the environment rather than at the variable. `CHROME_EXTENSION_ID` is trusted implicitly **in production builds only** — the Web Store extension pins its `VITE_WEB_BASE_URL` at the production origin, so it cannot legitimately call staging or localhost and trusting it there would widen the set to an identity that cannot appear. That exemption is what makes emptiness meaningful: a non-production allowlist is exactly `VITE_EXTENSION_IDS`, so empty reliably means misconfigured, and `vite build --mode staging` now fails on it with the `ext-id` command in the message. Production keeps its fallback and stays unbreakable by a missing env var. The dev server is exempt too — failing every `pnpm dev` would punish developers who never touch the extension — so an empty allowlist survives in exactly one place, and the route's error card detects that case and names the variable rather than implying the developer's own extension is untrusted. The parser is shared between the build check and the runtime (`apps/web/src/lib/extensionIds.ts`), so the build can never accept a value the route would drop.

## `consent_dismissed` swallowed the primary journey, and four times running the fix was incomplete

The SPA redirects only to hand back a token or an error code. Every other way the flow can end arrives at `launchWebAuthFlow`'s callback as a `chrome.runtime.lastError` and left, for most of this branch, as the single code `consent_dismissed`. Four situations piled into it:

- the manager closing the window;
- a `redirect_uri` the SPA refused;
- an unset or wrong `VITE_WEB_BASE_URL`;
- **the magic-link first pass** — the manager asks for a link, the SPA swaps to "check your email," and they close the window. This is the feature's primary journey working correctly, not an edge case.

Each one shipped as a bug of the identical shape: copy that asserted a cause the code had never observed. **The fact worth more than the tally is the sequence — every instance was found only after the previous one had been declared fixed.** Naming a cause, then narrowing the claim, then removing the assertion, then re-styling it: each pass looked like the end of it, because each pass fixed the path that had just been reported. What none of them did until the last was ask what else arrives at the same line. If there is one thing to carry out of this feature, it is that a funnel is fixed at the funnel, not at whichever inlet complained.

The fourth pass also overturned the premise the first three shared. `lastError` is not opaque: **`isApprovalDismissal`** — one matcher in `lib/auth.ts`, shared with the Google path so the two flows cannot disagree — reads the message and matches the *approval* shape only. Checked against Chromium's `identity_constants.cc`, two of twelve constants match: `kUserRejected` ("The user did not approve access.", also what a closed `launchWebAuthFlow` window reports) and `kCanceled`. `kPageLoadFailure` does not, and neither does `kInvalidRedirect` ("Did not redirect to the right URL.") — a near-miss that correctly stays out, since it says *redirect*, not *approve*.

**An unrecognised message is a hard failure on purpose**, and the asymmetry is the argument: Chrome's strings vary across builds and the failure set cannot be enumerated, so the matcher recognises the one shape it can name and lets the rest fall through. Guessing "dismissal" wrongly tells a manager to retry through an outage or watch an inbox that will never receive a link; guessing "failure" wrongly shows a slightly wrong red message for a cancel. So a page that never loaded — a **wrong** `VITE_WEB_BASE_URL`, an SPA outage, an offline manager — is now `sign_in_failed`, and an **unset** one is caught earlier still in `buildWebAuthUrl` so the message names the variable rather than the symptom.

**What remains indistinguishable is three situations that are all literally a closed window**: the magic-link first pass, a changed mind, and a refusal card read and closed. That set does not shrink further, and the copy has to stay true for all three. **The copy therefore asserts no cause**, and the web path leads with the likeliest one as an instruction — "Sign-in isn't complete yet. If you asked for a sign-in link, open it from your email first. Then click again — unless that window showed a configuration error, in which case retrying won't help." A bare "click again" is wrong for the magic-link case, since it reopens the same form and gets the manager nowhere; the trailing clause is the exit from a retry loop for the refusal case, where the SPA rendered its reason inside the window that just closed. Google keeps "Sign-in cancelled. Click again to retry.", because Chrome's consent dialog has no failure state to explain and a dismissal there really is one.

**And neither path styles it as a failure.** Both render `role="status"` with the muted `.sba-note` class rather than `role="alert"` with error styling. On Google it is a deliberate choice; on web the likeliest reader is a manager who just did exactly what the instructions said. Red there reads as an accusation, and `alert` interrupts a screen reader assertively for what is really a next step. Genuine failures keep the alert treatment.

**The same question came up one layer in, on the SPA's own Google popup, and got the opposite answer per host.** A dismissed `signInWithPopup` is swallowed on the homepage — a cancellation is not a failure, and two tests pin that silence. `/auth/extension` opts in to announcing it (`useSignInForm`'s `announceCancelledPopup`, set by that route alone), because inside a `launchWebAuthFlow` window the popup may never have opened at all: `signInWithPopup` needs `window.open` plus opener `postMessage`, neither guaranteed there. Silence in that context is indistinguishable from nothing happening, on a page that has just told the manager to use whichever sign-in they have — with no hint that the form below it needs no Google account. So the divergence is per-host and deliberate rather than an inconsistency to reconcile: same event, different amount of context the user has for interpreting it. Every Google-failure message in both hosts now names the magic-link form as the way through, and carries the SDK error code beside it, small and muted, so a smoke-test failure stays searchable for the operator without showing a manager a raw `FirebaseError`.

**"configuration error" is shared wording across the two surfaces** — the panel points back at the SPA's refusal card by that phrase, the card uses it, and a test on each side pins it. The card is the referent, so on any drift the card's wording wins. The card also echoes the rejected `redirect_uri` as inert text (never a link, truncated at 120 characters), and `buildWebAuthUrl` logs it before launching. That value is otherwise unobservable from either side, which is what turns "sign-in keeps cancelling" into a diagnosis during a smoke test.

## Prerequisites the operator owns

All three are configured outside the repo. The first two are caught by nothing — not CI, not the emulator, not any test:

1. **`kindoo-app@<project>` needs `roles/iam.serviceAccountTokenCreator` on itself.** Under Application Default Credentials, `createCustomToken` signs through the IAM `signBlob` API. The emulator substitutes an unsigned token, so a missing grant is invisible locally and surfaces in a deployed environment as `#error=mint_failed` on every email sign-in. Now in `infra/runbooks/provision-firebase-projects.md` with a retrofit path — neither existing project had it.
2. **`VITE_WEB_BASE_URL` must name the SPA origin for the same environment as that build's `VITE_FIREBASE_*` values.** A custom token minted by the other project will not verify. Both ways of getting it wrong now name a real fault: **unset** throws "VITE_WEB_BASE_URL is not configured for this build" before a window ever opens, and **wrong** lets the window open and fail to load, which the message-based branch reports as a hard failure. Under the original mapping either one presented as a permanent "click again to retry" on a button that could never work.

3. **`VITE_EXTENSION_IDS` must list the extension's keypair-derived ID, for every non-production build** — see the allowlist section above for why there is no usable default outside production. This one *is* caught, and deliberately so: `vite build --mode staging` fails rather than shipping a page that refuses the extension it was built for.

The IAM grant is flagged inside T-26 (the Phase 11 service-account hardening item) so an IAM tidy-up doesn't revoke it.

One caveat on the third that is worth carrying past this PR: **production may legitimately need a temporary `VITE_EXTENSION_IDS` entry** during the deploy runbook's pre-upload smoke test, which loads a prod-mode unpacked build against the production origin. That build is a distinct artifact from the store zip — it retains its manifest `key`, so it presents the keypair-derived ID rather than the Web Store one, which is why the implicit production default does not cover it. **The allowlist is compiled into the bundle, not read at runtime**, so admitting that ID costs a prod redeploy and removing it costs another. It still has to come back out once the Web Store version is live: a listed ID stays trusted indefinitely, and this is the only prerequisite in the set meant to be removed again. `infra/runbooks/deploy.md` step 6 carries the operator-facing sequence.

## Settled during the build

**The `launchWebAuthFlow` window shares the profile's storage.** The two-pass magic-link journey depends on it: the emailed link opens in an ordinary browser tab, not the auth window, so the manager clicks it there, returns to Kindoo, and presses Sign in again — and that second pass finds Firebase Auth already hydrated on the origin. This was the one open question that could have forced a different transport; the operator tested it in their own Chrome and the window opened signed in. The route's copy promises **one button left to press**, not zero, so the instruction matches Gate 2 rather than contradicting it.

## What didn't change

- **The Google path.** `signIn`, the `oauth2` manifest block, the OAuth scopes, and the `sba.googleAccessToken` storage key are untouched.
- **Authorization.** A custom-token session resolves roles from exactly the same custom claims as any other session — §4 is unmodified. A roleless manager who signs in this way lands on NotAuthorized, as they always did. This is also why `mintExtensionToken` needs no role gate: it mints for the caller's own uid, so the token reaches no scope its holder could not already reach — which is precisely why *which extension receives it* is the question worth gating. What it does extend is lifetime, not reach; see the scope-versus-duration note above.
- **Chrome permissions.** `launchWebAuthFlow` rides the `identity` permission the extension already declares; no new permission and no new host permission.
- **Audit.** Minting a session token is not an entity write, so `auditTrigger` fans nothing and the callable is stateless under retry.
- **Firestore rules and indexes.** Nothing touched.

## Spec / doc edits

- `docs/architecture.md` — **D33**: the delegation, the custom-token choice, the two gates and why neither suffices alone, the per-path failure copy, the callable's auth surface, and the rejected alternatives. The entry was corrected in place rather than superseded by a D34 — same decision, wrong the first time, fixed before merge; the wrong version is recorded inside it so the reasoning isn't re-derived.
- `docs/spec.md` §4.1 — the flow in order: surfaces → handoff steps → why a custom token → message-based failure mapping and what `consent_dismissed` still cannot distinguish → the per-path copy → the SPA half (both gates, the per-host popup announcement, the terminal card) → the server half (including scope-versus-duration) → prerequisites.
- `docs/spec.md` §5.0 — names `/auth/email-link` and `/auth/extension` as the two ungated routes that are handoff endpoints rather than pages.
- `docs/spec.md` §15 — the "all extension callables propagate `stakeId`" claim now says which callables it means and notes `mintExtensionToken` is stake-agnostic and SPA-invoked.
- `docs/firebase-schema.md` §7 — `mintExtensionToken` row, carrying the IAM prerequisite.
- `CLAUDE.md` — follow-up bullet; T-26 flagged not to revoke the self-grant.
- `apps/web/CLAUDE.md` — `isAllowedRedirectUri` is the only sanctioned check; `CHROME_EXTENSION_ID` is a production-only default and the build gate is what keeps that honest; the sign-in providers are one component with two hosts.
- `functions/CLAUDE.md` — `mintExtensionToken.ts` in the callable tree (plus `createStake.ts` and `backfillEqPresidentAccess.ts`, which were already missing).
- `extension/CLAUDE.md` — two-path auth section, the `isApprovalDismissal` rule (match the approval shape, never enumerate failures, one matcher only), what `consent_dismissed` still means, the per-path wording split, and the `signOut()` rule.
- `docs/user-guide/kindoo-managers.html` §3 — install step names both buttons; callouts cover the email path, the confirm card, and the magic link's extra step; §13 gains a sign-in troubleshooting entry.
- `infra/runbooks/provision-firebase-projects.md`, `infra/runbooks/deploy.md`, `infra/runbooks/extension-deploy.md`, `apps/web/.env.example`, `extension/.env.example` — the IAM grant, `VITE_WEB_BASE_URL`, and `VITE_EXTENSION_IDS`.
- `docs/TASKS.md` — the placeholder task `web-engineer` filed against D33(d) is removed rather than numbered; correcting D33 here completed it on arrival.

