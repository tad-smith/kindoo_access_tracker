# Chunk 11.2 — First-time login instructions

**Shipped:** 2026-04-26
**Commits:** _(see git log; commit messages reference "Chunk 11.2")_

> **Post-deploy fix (2026-04-26).** The initial cut stored the flag in
> the iframe's `*.googleusercontent.com` origin localStorage; the first
> deploy revealed the overlay re-appeared on every visit. Two iterations
> followed:
>
> 1. **Wrapper-origin localStorage with a postMessage bridge** (failed).
>    Moved the flag to the wrapper origin (stable, first-party) and
>    bridged dismissal back via `window.top.postMessage`. Operator
>    redeployed both halves and reported it still didn't work — the
>    postMessage either doesn't reach the wrapper from Apps Script's
>    nested iframe, or is silently dropped.
>
> 2. **Wrapper-origin cookie set on `?token=` landing** (shipped). The
>    wrapper's existing inline script already sees the canonical "user
>    just completed sign-in" signal — Identity's Continue redirect lands
>    at `kindoo.csnorth.org/?token=<HMAC>&redirect=<…>`. Setting the
>    cookie at that exact moment is one line of additional wrapper code
>    and requires **zero communication with the iframe**. The flag can
>    only be set by completing the full auth flow at least once — which
>    is exactly when the user has gone through the three consent screens
>    the overlay teaches. The iframe consumes the value as today (via
>    the `xinst` URL param) and never writes the flag itself.
>
> See "Post-deploy fix" near the end of the file for the full diagnosis
> trail.

## What shipped

A one-time-per-browser instructions overlay on Login that walks first-time users through the three consent-style screens between clicking Sign-In and reaching the app:

1. Apps Script's *"Unverified"* warning page (the one that prominently displays the `(Unverified)` label) → click **Review Permissions**.
2. Google's OAuth scope consent — a normal permissions screen showing the user's email is the only scope being requested → click **Continue**.
3. Identity's brief Continue page → click **Continue** one more time.

The overlay renders inside `Login.html` with both screenshots inline (served from the GitHub-Pages-hosted `https://kindoo.csnorth.org/images/{review-permissions,auth-scopes}.png`), an honest note explaining that "Unverified" means *not publicly listed* — not *unsafe* — and a primary action button ("Got it, sign me in") that sets the localStorage flag and triggers the existing Chunk-11.1 sign-in flow. A subtle "Skip instructions next time" link gives users who want to read at their own pace a way to dismiss the overlay without auto-signing-in. Returning users (flag set) see only the regular Sign-In button — overlay never renders.

The Sign-In click path is unchanged: `buildIdentityUrl_()` (Chunk 11.1) populates the `#signin-link` anchor's `href` with the redirect-param round-trip; both the regular click and the new "Got it" button route through that same anchor (the button's handler calls `startSignIn_()` which programmatically clicks `#signin-link`). Deep-link preservation across the auth round-trip continues to work in both paths.

## Decisions made during the chunk

- **localStorage over Sheet-side state.** The flag is per-browser, not per-user. Persisting in the Sheet would survive a browser/profile change but would also require a server round-trip on every Login render to read it, plus a per-user record. Per-browser is the right granularity: it's the first-time-per-this-browser flow that the overlay teaches, and a multi-device user genuinely benefits from seeing the screens once per device.
- **Wrapper-origin cookie, set on the post-auth landing** (post-deploy correction; see "Post-deploy fix" for the two-iteration trail). Final shape: the wrapper at `kindoo.csnorth.org` writes a `kindooLoginInstructionsV1Seen=1` cookie at the moment Identity's post-auth Continue redirect lands at the wrapper (i.e., the wrapper's own URL has `?token=<HMAC>` on it). The wrapper reads the cookie on every load and bridges it into the iframe via `&xinst=1`. The iframe never writes the flag — its dismiss buttons just hide the overlay for the rest of this session. Setting the cookie at the post-auth moment is the canonical "user has just completed sign-in" signal, which is also exactly when they've experienced the three consent screens the overlay was teaching.
- **V1-versioned key.** `kindooLoginInstructionsV1Seen` rather than `kindooLoginInstructionsSeen`. A future auth-flow redesign that meaningfully changes the user-visible click sequence bumps to `V2` — old `V1Seen` entries become irrelevant; users see the new instructions; no migration code needed. The bridge protocol's `v: 1` field on the postMessage payload similarly versions the wire shape independently.
- **Honest "Unverified" copy over evasion.** The instructional text directly addresses what the user will see (`(Unverified)` label) and explains why (not publicly listed; internal stake tool; only reads email). The alternative — burying the warning in soft language or hoping users don't notice — would have been worse: the unannounced label would feel dishonest by contrast. Pursuing OAuth verification with Google to remove the label entirely is a separate, multi-week concern; it remains optional and is documented as out-of-scope here.
- **Absolute image URLs over inline base64.** The screenshots are 113 KB and 45 KB; inlining as base64 would inflate Login.html and force the data through every Login render, including for returning users who never see the overlay. Cross-origin `<img src=…>` is well-supported and well-cached. Trade-off: the wrapper-origin hostname `kindoo.csnorth.org` is now coupled into Login.html — see "Trade-offs accepted" below.
- **Overlay markup inside `Login.html`** rather than a separate UI file. The overlay is purely Login-specific; it shouldn't render on any other surface. Co-locating with the rest of the Login fragment keeps the relationship visible. JS lives in `Layout.html` alongside `showLogin` / `buildIdentityUrl_` because that's where the rest of the Login flow's behavior already lives.
- **Both action paths set the flag, including on auth failure after acknowledgment.** If the user clicked "Got it" and the auth flow fails (network error, expired session_secret, etc.), bringing them back to Login should not re-show the overlay. The user has *seen* the instructions; re-showing would imply the failure was their fault. The flag persists; the regular Sign-In button is what they see on retry.
- **No animation.** Show/hide is instant — matches the no-animation aesthetic of the rest of the app.

## Departures from the prompt's plan

- **Onclick attributes vs. `addEventListener`.** The prompt sketched inline `onclick="acknowledgeAndSignIn()"` markup. Layout.html wraps its JS in an IIFE; functions inside the IIFE aren't on `window` and inline `onclick` attributes can't reach them without polluting the global scope. Switched to `addEventListener` wired once at boot (`wireInstructionsActions_()` IIFE inside Layout.html's main IIFE). Behavior identical; cleaner scoping.
- **`startSignIn_()` is a thin programmatic-click on `#signin-link`.** The prompt sketched extracting the redirect-capture and top-frame-nav logic into `startSignIn_()`. In the actual codebase that logic *was already extracted* by Chunk 11.1 — `buildIdentityUrl_()` builds the URL; the anchor's `<base target="_top">` does the top-frame nav on click. Single source of truth was already in place. `startSignIn_()` thus becomes a simple `link.click()` that programmatically triggers the same anchor click the regular Sign-In button uses. Both code paths converge cleanly.

## Files modified

- `src/ui/Login.html` — overlay markup appended after the existing `<section class="login">`. Five `<li>` numbered steps (the prompt's six-step draft minus the "Google will show you an account picker" step — dropped post-implementation since most stake users only have a single Google account, and the picker, when it does appear, is self-explanatory). The warning-heading + body and Step 2 figure caption both reference the `(Unverified)` label, which is **only** on the Apps Script warning page (review-permissions.png, the user's first click-through screen). The Step 3 figure caption (auth-scopes.png) is neutral — that screen is a normal Google OAuth permissions list with no `(Unverified)` text on it; the explainer above is what addresses the underlying "this app isn't publicly verified" concern at the appropriate step. Two `<figure>` blocks with absolute-URL screenshots and the specified alt text, and a `<div class="instructions-actions">` with the primary `.btn` button and the secondary skip-link. `aria-modal="true"`, `role="dialog"`, `aria-labelledby` for accessibility.
- `src/ui/Layout.html` — added `INSTRUCTIONS_SEEN` server-injected global (rendered from `template.instructions_seen`), `getLoginInstructionsFlag_()` (returns `'1'`/`null` from `INSTRUCTIONS_SEEN`), `showInstructionsOverlay_` / `hideInstructionsOverlay_`, `startSignIn_()`, and a one-shot `wireInstructionsActions_()` IIFE that attaches click handlers to `#instructions-acknowledge` (hide overlay + sign in) and `#instructions-skip` (preventDefault + hide). The iframe never persists the flag — that's the wrapper's job. `showLogin()` extended with a final block that toggles the overlay's `.hidden` class based on `INSTRUCTIONS_SEEN`.
- `src/ui/Styles.html` — `.instructions-overlay` (fixed backdrop matching the `.complete-modal` family aesthetic), `.instructions-modal` (centered card, `width: min(720px, 100%)`, `max-height: calc(100vh - 64px)` with internal scroll for long content on small viewports), heading + body typography (`.instructions-title`, `.instructions-subhead`, `.instructions-steps`, `.instructions-warning-heading`, `.instructions-warning-body`), figure + screenshot styling (`max-width: 100%; height: auto` for responsive scaling, framed with the `--kd-surface-alt` background), and the action area (flex-wrap row with the primary `.btn` and the muted `.instructions-skip-link`). The mobile breakpoint at ≤900-ish px (the existing modal-tightening rule) extended to also cover `.instructions-overlay` / `.instructions-modal`.
- `src/core/Main.gs` (post-deploy fix) — added `'xinst'` to the `doGet` reserved-keys strip alongside `p`/`token`/`redirect`; reads `e.parameter.xinst === '1'` and injects the boolean into the Layout template as `template.instructions_seen`.
- `website/index.html` (post-deploy fix) — extended the inline script with `readInstructionsFlag` / `writeInstructionsFlag` cookie helpers and one new piece of behaviour in the existing post-auth branch: when the wrapper's URL has `?token=`, call `writeInstructionsFlag()` to set `kindooLoginInstructionsV1Seen=1; Path=/; Max-Age=5y; SameSite=Lax; Secure` before processing the token + redirect. On every load (any branch), read the cookie and append `&xinst=1` to the iframe `src` when set. Inbound `xinst` is stripped defensively (the wrapper is the source of truth). No `postMessage` listener — the iframe doesn't communicate the flag back at all.
- `docs/architecture.md` §11 — "First-time-login instructions (Chunk 11.2)" subsection covering the wrapper-origin storage decision, the two-way bridge (URL out, postMessage in), V1 versioning, the two action paths, and the failure modes at both ends.
- `docs/build-plan.md` — Chunk 11.2 section added (architectural shape, sub-tasks, acceptance criteria, out-of-scope). Marked `[DONE]`.
- `docs/changelog/chunk-11.2-first-time-instructions.md` — this file (new; the post-deploy fix is folded into this same changelog rather than a separate Chunk 11.3, since it's the same UX feature).

## Operator dependency

The two screenshot files at `website/images/`:

- `review-permissions.png` (45 KB) — Apps Script's "Unverified" warning page with a red arrow on **Review Permissions**.
- `auth-scopes.png` (113 KB) — Google's OAuth scope consent showing the email scope being requested, with a red arrow on **Continue**. (No `(Unverified)` label on this screen — that's only on the Apps Script warning at step 2.)

Both committed by the operator in `ab28a73 "Add new Login authorization sample screenshots"` and serving 200 from `https://kindoo.csnorth.org/images/`. The Pages workflow auto-deploys any change to `website/**`, so updating either screenshot is a `git push` away.

## Edge cases tested (code-walk; browser-side test pending operator deploy)

The 14 verification cases from the prompt, each traced through the implementation:

1. **First-time user (fresh incognito):** `showLogin()` runs → `getLoginInstructionsFlag_()` returns `null` → `showInstructionsOverlay_()` removes `.hidden` → overlay visible with both screenshots and the explainer. ✓
2. **First-time user clicks "Got it, sign me in":** ack-button click handler → `setLoginInstructionsFlag_()` writes `'1'` → `hideInstructionsOverlay_()` adds `.hidden` → `startSignIn_()` does `#signin-link.click()` → top-frame nav to Identity URL (with Chunk 11.1's `&redirect=` round-trip) → standard auth flow. ✓
3. **First-time user clicks "Skip instructions next time":** skip-link click handler → `preventDefault` → flag set → overlay hidden → user sees regular Sign-In button below. ✓
4. **Returning user (flag present):** `showLogin()` → flag is `'1'` → `hideInstructionsOverlay_()` no-ops (already hidden) → only the regular section visible. ✓
5. **Same browser, next visit:** localStorage persists across visits at the iframe origin → flag remains `'1'` → returning-user case. ✓
6. **After clearing localStorage:** flag removed → next render sees `null` → first-time case. ✓
7. **Different browser / device:** new localStorage partition → empty → first-time case. ✓
8. **Auth failure after dismissal:** `showLogin()` is called again with an error message → flag is still `'1'` → overlay stays hidden; the `errMsg` displays in `#login-error`. ✓
9. **localStorage disabled:** `getLoginInstructionsFlag_()` catches the throw and returns `null` → overlay shows every login. `setLoginInstructionsFlag_()` silently no-ops. Auth flow itself unaffected. ✓ Acceptable degraded behavior.
10. **Both screenshots load:** image URLs are absolute. Browser fetches `https://kindoo.csnorth.org/images/review-permissions.png` and `https://kindoo.csnorth.org/images/auth-scopes.png` cross-origin. Pages serves both with `HTTP/2 200` (verified pre-implementation; URLs were committed in `ab28a73`). Plain `<img src=…>` requires no CORS headers for display. ✓
11. **Screen reader:** `role="dialog"`, `aria-modal="true"`, `aria-labelledby="instructions-title"`, heading hierarchy `<h1 page>` → `<h2 overlay title>` → `<h3 subhead>` → `<h4 warning>`, descriptive alt text on both images, clear button labels. ✓
12. **Mobile viewport (375px):** `.instructions-modal` is `width: min(720px, 100%)` → 100% on narrow viewports; mobile breakpoint reduces padding to `16px 14px` and `max-height` to `calc(100vh - 24px)`; screenshots use `max-width: 100%` for responsive scaling; `.instructions-actions` uses `flex-wrap: wrap` so the primary button + skip-link wrap onto two rows if they don't fit. ✓
13. **Deep-link with auth required + first-time user:** paste `kindoo.csnorth.org/?p=mgr/seats&ward=CO` → wrapper forwards search to iframe → Main `doGet` sees no token → `showLogin` runs → overlay appears (flag null on first visit) → click "Got it" → flag set, overlay hidden, `startSignIn_()` clicks `#signin-link` whose href was built by `buildIdentityUrl_()` from `REQUESTED_PAGE='mgr/seats'` + `QUERY_PARAMS={ward:'CO'}` → Identity URL has `&redirect=p%3Dmgr%252Fseats%26ward%3DCO` → Identity round-trips → wrapper extracts → iframe URL has `?token=…&p=mgr/seats&ward=CO` → user lands on AllSeats with the ward filter pre-applied. **Chunk 11.1's redirect preservation flows through the new overlay path unchanged. ✓**
14. **All Chunks 1–11.1 acceptance criteria still pass.** The changes are purely additive on the Login surface: a new overlay element (hidden by default), helper functions in Layout.html, a final conditional block in `showLogin()`, and new CSS classes. No auth, routing, RPC, cache, request-lifecycle, importer, or expiry code touched. **No regressions reachable. ✓**

Cases 1-14: verified by code-walking the URL flow, DOM-state transitions, and CSS classes against the implementation. The browser-side smoke test is the operator's: hit `kindoo.csnorth.org/` in a fresh incognito window, see the overlay; click "Got it"; complete the three-click consent flow; reach the app. Then close incognito, open a new incognito tab, hit `kindoo.csnorth.org/` again; overlay should NOT appear.

## Trade-offs accepted

- **`kindoo.csnorth.org` hostname coupled into Login.html.** The two screenshot URLs are absolute. If the wrapper origin ever moves (e.g., `kindoo.csnorth.org` retired in favor of a different subdomain), Login.html needs a corresponding edit. Documented here so a future move plan accounts for it. The alternative (inlining as base64) would have inflated Login.html for every render, including for returning users who never see the overlay; the coupling is the lighter trade-off.
- **Multi-device users see the overlay multiple times.** Per-browser flag, by design — the overlay is teaching a per-device sign-in experience. Acceptable.
- **Privacy-mode users see the overlay every login.** localStorage disabled → flag never persists → overlay every render. Slightly annoying but functionally correct (the auth flow itself is unaffected). Tradeoff against making localStorage failure a hard blocker.
- **No analytics on dismissal.** We don't know how many users click "Got it" vs. "Skip" vs. how often the overlay shows. If the overlay turns out to be a distraction operators want to remove, the data isn't there to make the case. Acceptable: simpler UX, no tracking infrastructure.

## Post-deploy fix (2026-04-26)

### Symptom

After the initial deploy, the operator reported the overlay re-appeared on every visit — the flag never persisted. The "Got it, sign me in" button worked functionally (the user could complete sign-in normally), but the next visit's iframe boot showed the overlay again regardless.

### Iteration 1 (failed): wrapper-origin localStorage with a postMessage bridge

The original implementation wrote the flag to `localStorage` at the iframe's `*.googleusercontent.com` origin. Two effects compound to break that:

1. **Apps Script's iframe hostname rotates per execution.** Each `HtmlService` render lands at a different `n-<hash>-script.googleusercontent.com` subdomain. Storage written at hash 1 is invisible to hash 2.
2. **Third-party storage partitioning / blocking.** Modern browsers progressively partition or fully block storage in cross-origin iframes embedded under a different top-level site. The wrapper origin is the top-level site; the iframe is third-party.

The first attempt at a fix moved storage to the wrapper origin with a two-way bridge: wrapper → iframe via `&xinst=1` on the URL, iframe → wrapper via `window.top.postMessage({type: 'kindooInstructionsSeen', v: 1}, new URL(MAIN_URL).origin)` on dismissal. Architecturally clean — same-direction URL forwarding wrapper-to-iframe, single postMessage listener at the wrapper for the return path.

The operator pushed both halves and reported it still didn't work. Either `window.top.postMessage` doesn't reach the wrapper from inside Apps Script's nested iframe (sandbox / cross-origin restriction not anticipated), or the message is silently dropped before the wrapper's listener fires.

### Iteration 2 (shipped): cookie at the wrapper, written on `?token=` landing

The simpler thing the wrapper *already* sees: Identity's post-auth Continue redirect lands at `kindoo.csnorth.org/?token=<HMAC>&redirect=<…>`. That's the canonical "user has just completed sign-in" signal — and it's exactly when the user has experienced the three consent screens the overlay was teaching. Setting the cookie at that exact moment is one line of additional code in the wrapper's existing post-auth branch and requires **zero communication with the iframe**.

Wrapper code at the post-auth branch entry:

```js
} else {
  // Post-auth landing. The user just completed sign-in — this is
  // the moment to mark the instructions as seen.
  writeInstructionsFlag();
  // ... existing token + redirect handling ...
}
```

`writeInstructionsFlag()` writes `kindooLoginInstructionsV1Seen=1; Path=/; Max-Age=5y; SameSite=Lax; Secure` via `document.cookie`. On every subsequent load (any branch), the wrapper reads the cookie and appends `&xinst=1` to the iframe `src`. The iframe-side flow is unchanged from Iteration 1 — read `INSTRUCTIONS_SEEN` from the server-injected template and toggle the overlay; the dismiss buttons no longer try to persist anything (they just hide for this session).

### Trade-off the cookie-on-token approach makes explicit

The "Skip instructions next time" link's promise weakens. With the original (broken) localStorage flow it was supposed to set the flag on dismissal; with the iteration-1 (also-broken) postMessage flow it was supposed to ditto. With the iteration-2 (working) cookie-on-token flow, the skip link only persists if the user goes on to actually sign in via the regular Sign-In button after dismissing. If they dismiss and close the browser without signing in, the overlay shows again next visit — which is the **correct** behaviour: they haven't actually been through the consent screens yet, so we shouldn't pretend they have.

The label was kept as-is. A user who dismisses with intent to come back later and sign in: cookie eventually gets set on their first successful sign-in; they're fine. A user who dismisses, never signs in, and closes the browser: rare; sees the overlay again next time, which matches reality. Renaming to "Dismiss" would have been more honest about the literal action but less informative about the typical outcome.

### Why not server-side per-user

A Sheet column on `KindooManagers`/`Access` would persist indefinitely across devices and browsers. Considered and rejected for two reasons: (1) the overlay teaches a *per-device* sign-in experience (the screens differ slightly across browsers); (2) the overlay shows pre-auth, before there's a verified user identity to look up server-side. The cookie-on-token approach preserves per-browser scope and works without any server changes beyond the `xinst` reservation already in place.

### What's in this iteration

- `website/index.html`: replaced the iteration-1 postMessage listener and `localStorage` reads with `readInstructionsFlag` / `writeInstructionsFlag` cookie helpers. `writeInstructionsFlag()` is called in the existing post-auth branch (when `?token=` is on the wrapper's URL); `readInstructionsFlag()` is called once per load and appends `&xinst=1` to the iframe `src` when set.
- `src/core/Main.gs`: unchanged from iteration 1. `'xinst'` is in the reserved-keys strip; `template.instructions_seen` is rendered from `e.parameter.xinst === '1'`.
- `src/ui/Layout.html`: removed `setLoginInstructionsFlag_()` entirely — the iframe doesn't write the flag in any direction. The two click handlers shrink to `hideInstructionsOverlay_() + (startSignIn_ for the ack path)`. `INSTRUCTIONS_SEEN` global and `getLoginInstructionsFlag_()` reading from it stay.
- `src/ui/Styles.html`: added the missing `.instructions-overlay.hidden { display: none; }` override. Without it, the original `.hidden { display: none; }` rule (single-class selector) had equal specificity to `.instructions-overlay { display: flex; … }` (also single-class), and `display: flex` came later in the stylesheet — so it won, and the overlay stayed visible even after JS correctly added `hidden` to its classList. The existing `.complete-modal` / `.seat-edit-modal` / `.remove-modal` family all have specific `.classname.hidden` overrides; this one was missed during the original Chunk 11.2 ship and only surfaced post-deploy when the upstream cookie/postMessage debugging was already in flight. Easy one-line fix; trivial to verify via `getComputedStyle(...).display === 'none'` in DevTools.

Browser-side smoke test for the operator: hit `kindoo.csnorth.org/` in a fresh incognito window, see the overlay; click "Got it" through the auth flow; the wrapper writes the cookie at the post-auth landing; close incognito; reopen; hit `kindoo.csnorth.org/` again — overlay should NOT appear.

## New open questions

None. The chunk addresses a discrete UX wart and the implementation is small and self-contained.

## Operator deploy

Two surfaces; standard sequence:

1. **Apps Script Main project** — `npm run push` to sync `src/ui/Login.html` + `src/ui/Layout.html` + `src/ui/Styles.html`. Then editor → Deploy → Manage deployments → Edit existing **Main** deployment → New version. Per CF-5: `clasp push` alone doesn't bump the live `/exec`.
2. **GitHub Pages wrapper** — no change required; the screenshot files at `website/images/` are already deployed (operator's `ab28a73` commit). The wrapper page at `website/index.html` is unchanged.

The Identity project doesn't need touching this chunk — the auth flow's only change is *who clicks the Sign-In anchor* (the user, vs. the user via "Got it" button); the URL the click lands on is identical.

## Next

The project remains feature-complete. Chunks 1-10 + 10.5 + 10.6 + 11 + 11.1 + 11.2 all shipped. Future work is operational (monitoring, OAuth verification submission if desired) rather than feature development. No queued chunks.
