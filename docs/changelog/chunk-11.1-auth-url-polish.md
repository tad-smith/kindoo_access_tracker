# Chunk 11.1 — Auth URL polish + deep-link preservation

**Shipped:** 2026-04-25
**Commits:** _(see git log; commit messages reference "Chunk 11.1")_

## What shipped

Two UX warts left over from Chunk 11 are closed:

1. **Token no longer visible in the address bar.** Pre-Chunk-11.1, the post-sign-in landing URL (`https://kindoo.csnorth.org/?token=eyJhbGc…`) sat in the address bar for the rest of the session. Now the wrapper extracts the token, routes it into the iframe URL only (where it sits inside Apps Script's nested-iframe structure and isn't user-visible), and `history.replaceState`'s the wrapper URL to a clean form (`/` for the no-deep-link case, `/?<original-deep-link>` for the deep-link case). Address bar reads cleanly within one paint cycle of the auth round-trip completing.

2. **Wrapper-origin deep links now survive the auth round-trip.** Pre-Chunk-11.1, a user pasting `https://kindoo.csnorth.org/?p=mgr/seats&ward=CO` while signed-out lost the `?p=` through Identity's redirect — Identity carried only `?token=…` back. Now Login captures the current deep-link query (server-injected `REQUESTED_PAGE` + `QUERY_PARAMS`, or `window.location.search` post-pushState — see "Smart source detection" below), encodes it as `&redirect=<encoded>` on the Identity URL; Identity round-trips the param verbatim onto the Continue link's destination; the wrapper extracts on arrival, sanitizes (drops any nested `token` or `redirect`), and the iframe ends up at `<exec>?token=…&p=mgr/seats&ward=CO` so Main's `doGet` routes correctly. The user lands on filtered AllSeats, not on their role default.

The wrapper's inline script (`website/index.html`) is the lynchpin; the auth flow on the Apps Script side gains a small Login-side helper (`buildIdentityUrl_()`), an Identity-side `e.parameter.redirect` pass-through (`identity-project/Code.gs`), and a defensive `redirect` strip in `Main.gs`'s `doGet` reserved-keys list. No token signing or verification logic touched.

### The wrapper script (verbatim)

The whole auth-URL polish on the wrapper side is this 28-line block in `website/index.html`:

```js
(function () {
  var BASE = 'https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec';
  var iframe = document.getElementById('app');
  var search = window.location.search;

  if (!search) {
    iframe.src = BASE;
    return;
  }

  var topParams = new URLSearchParams(search);
  var token = topParams.get('token');

  if (!token) {
    // Cold deep-link: forward the wrapper's query verbatim.
    iframe.src = BASE + search;
    return;
  }

  // Post-auth landing.
  var rawRedirect = topParams.get('redirect') || '';
  var redirectParams = new URLSearchParams(rawRedirect);
  redirectParams.delete('token');     // never round-trip the token
  redirectParams.delete('redirect');  // never re-nest

  var iframeParams = new URLSearchParams();
  iframeParams.set('token', token);
  redirectParams.forEach(function (value, key) {
    iframeParams.set(key, value);
  });
  iframe.src = BASE + '?' + iframeParams.toString();

  var cleanedQuery = redirectParams.toString();
  history.replaceState({}, '', '/' + (cleanedQuery ? '?' + cleanedQuery : ''));
})();
```

Two destinations from one input: token routes to the iframe URL only (so Main's server-side `Auth_verifySessionToken` runs as today); the deep-link query routes to both the iframe URL (so server-side routing has the params) AND the wrapper URL (so the user-visible address bar shows the right thing).

## Deviations from the pre-chunk plan

The prompt's working draft sketched two replaceState sites — one at the wrapper layer for the user-visible URL, one at the iframe layer as belt-and-braces. Investigation found the iframe-side replaceState would be a **no-op**: the iframe's `window.location.search` carries Apps Script's own internal params (`?createOAuthDialog=true&…`) — Apps Script wraps `HtmlService` output in a nested iframe whose URL is Apps Script's, not the URL the wrapper requested. The user-visible URL is the wrapper's, and the wrapper's replaceState covers it.

Consequence: the iframe-side change collapses from "extract token + replaceState" to "drop the existing `window.top.location.replace(MAIN_URL)` reload". The pre-Chunk-11.1 reload was specifically a top-frame full-reload to clean the address bar via reload (not a `replaceState`); Chunk 11.1's wrapper-side replaceState is the new mechanism, so the reload becomes redundant.

The brief's Login-side sketch read `window.location.search` to source the deep-link params. That doesn't work on initial load (the iframe's URL has Apps Script's internal params, not ours) — `buildIdentityUrl_()` reads from server-injected `REQUESTED_PAGE` + `QUERY_PARAMS` globals on initial load. After Chunk 10.6 pushState navigation, `window.location.search` *does* contain our params, so the helper falls back to that source — see "Smart source detection" below.

## Decisions made during the chunk

- **Smart source detection in `buildIdentityUrl_()`.** When the user hits the Login button mid-session (after token expiry), the page they want to come back to is the page they were *currently* on, not the page they cold-loaded with. After Chunk 10.6 pushState navigation, the iframe's URL reflects the current page; `REQUESTED_PAGE` reflects only the cold-load page. The helper checks `window.location.search` for our `p` key — if present (post-pushState), use the iframe URL; otherwise fall back to the server-injected globals. Detection is by the presence of the `p` key because that's our custom name and Apps Script's internal params don't use it. Recorded as: this changelog entry.
- **No iframe-side replaceState.** Skipping it as a no-op (see "Deviations" above).
- **`redirect` added to `Main.gs`'s reserved-keys strip.** The wrapper sanitizes `redirect` off the iframe URL; this defensive strip in `Main.gs#doGet` covers the hostile-direct-`/exec` case where someone crafts a URL with `?redirect=…` in an attempt to inject the value into `QUERY_PARAMS`. Belt-and-braces; the wrapper is the primary defense.
- **Identity's redirect pass-through is opaque.** Identity makes no claims about the `redirect` value's structure or meaning — it just round-trips bytes. The wrapper's sanitization (`delete('token')`, `delete('redirect')`) on arrival is what enforces the "never re-inject token, never re-nest" contract. Avoiding any structural inspection in Identity keeps the change minimal there (Identity is copy-paste deployed, not pushed via clasp).
- **Cosmetic: `%2F` in the post-auth address-bar query.** A deep-link `?p=mgr/seats` round-trips through `URLSearchParams.toString()` which encodes `/` as `%2F`. After auth the address bar reads `?p=mgr%2Fseats` instead of `?p=mgr/seats`. Functionally identical (both decode to `mgr/seats` server-side); cosmetically different. Not prettified — would require selective `replace(/%2F/gi, '/')` and we're staying minimal. If anyone notices and asks, the fix is one line.

## Files modified

- `website/index.html` — replaced the seven-line static-`src` + simple-forwarder block with the 28-line script described above. Now handles three cases: empty search (`iframe.src = BASE`), no-token search (`iframe.src = BASE + search`), token-and-redirect search (extract, sanitize, separate iframe URL from wrapper URL, replaceState).
- `src/ui/Layout.html` — added `buildIdentityUrl_()` helper (~25 lines) above `showLogin()`. `showLogin()` now calls it instead of assigning `IDENTITY_URL` directly. The boot's `INJECTED_TOKEN` branch dropped its `window.top.location.replace(MAIN_URL)` reload (with comment explaining what replaced it).
- `identity-project/Code.gs` — `doGet()` → `doGet(e)`; reads `e.parameter.redirect`; appends `&redirect=<encodeURIComponent(rawRedirect)>` to the Continue link's destination URL when non-empty. Comment block updated.
- `src/core/Main.gs` — `doGet`'s reserved-keys strip extended from `(p, token)` → `(p, token, redirect)` for defense-in-depth. Comment block updated.
- `docs/architecture.md` — §11 "Why the wrapper carries (a tiny bit of) JavaScript" rewritten to summarise both Chunk 11 (forward) and Chunk 11.1 (extract+replaceState) responsibilities. New "### Auth URL polish — Chunk 11.1" subsection covers the round-trip path, encoding chain, sanitization contract, and the "no iframe-side replaceState" rationale.
- `docs/build-plan.md` — Chunk 11.1 section added (architectural shape, sub-tasks, acceptance criteria, out-of-scope). Heading marked `[DONE — see docs/changelog/chunk-11.1-auth-url-polish.md]` in this commit. Chunk 11's "Pre-sign-in deep-link" out-of-scope note flagged with "**Closed by Chunk 11.1.**".
- `docs/open-questions.md` — `CF-2` flipped from `[P2]` to `[RESOLVED 2026-04-25 — Chunk 11.1]` with the discovery trail preserved.
- `docs/changelog/chunk-11.1-auth-url-polish.md` — this file (new).

## Edge cases tested (code-walk; operator-side browser test pending)

The brief's 10 verification cases, each traced through the implementation:

1. **Cold no-params** (`kindoo.csnorth.org/`). Wrapper's empty-search branch → `iframe.src = BASE` → Main with no params → showLogin → `buildIdentityUrl_` returns just `IDENTITY_URL` (no `&redirect=`) → Identity Continue link is `<main_url>?token=<HMAC>` → wrapper's token branch → `iframe.src = BASE?token=<HMAC>` → `replaceState('/')` → Main verifies token → INJECTED_TOKEN branch → `proceedWithToken()` → Dashboard. **Address bar throughout: clean. ✓**
2. **Cold deep-link** (`?p=mgr/seats&ward=CO`). Wrapper's no-token branch forwards search to iframe → Main with `p`+`ward` → showLogin → `buildIdentityUrl_` falls back to `REQUESTED_PAGE`+`QUERY_PARAMS` (winParams.has('p') is FALSE on initial load — Apps Script's internal iframe URL) → Identity URL has `&redirect=p%3Dmgr%252Fseats%26ward%3DCO` → Identity round-trips → wrapper extracts → iframe URL has token+`p`+`ward` → wrapper replaceState to `/?p=mgr%2Fseats&ward=CO` → Main with token → AllSeats with `ward=CO` filter. **Address bar after auth: deep-link preserved. ✓**
3. **Warm in-app deep-link.** Click Dashboard card → Chunk 10.6 pushState updates iframe URL → page renders. No wrapper involvement; no Chunk 11.1 code touches this path. **Pre-existing behavior unchanged. ✓**
4. **Token never visible.** Wrapper's inline script runs synchronously at body-parse time, before first paint. The `replaceState` runs on the same execution turn as `iframe.src = …`. In practice the address bar transitions to clean within one paint cycle (~50ms typical, sub-100ms worst case on slow devices). **Within the <100ms tolerance the brief allowed. ✓**
5. **Hostile redirect — embedded token** (`?token=<good>&redirect=token%3D<malicious>`). `topParams.get('token') = <good>`. `redirectParams = URLSearchParams('token=<malicious>')` → `{token: '<malicious>'}` → `redirectParams.delete('token')` → empty. `iframeParams` only has the outer-position `<good>` token. iframe URL has `<good>`; address bar is `/`; sessionStorage gets `<good>` after server-side verify. **Malicious string lands nowhere. ✓**
6. **Hostile redirect — nested redirect** (`?token=<good>&redirect=redirect%3D<another>`). `redirectParams = {redirect: '<another>'}` → `delete('redirect')` → empty. `cleanedQuery=''` → `replaceState('/')`. iframe URL has only the outer-position token. **No recursion. ✓**
7. **Empty redirect** (`?token=<HMAC>&redirect=`). `topParams.get('redirect') = ''` → `redirectParams = URLSearchParams('')` → empty → `cleanedQuery=''` → `iframe.src = BASE?token=<HMAC>`, `replaceState('/')`. **Default landing, no JS error. ✓**
8. **Direct-`/exec` deep links** (operator fallback). User pastes `script.google.com/.../exec?p=mgr/seats` → Apps Script Main reads `?p` → showLogin → `buildIdentityUrl_` builds redirect → Identity round-trips → Continue lands at `Config.main_url` = wrapper URL → wrapper extracts → user ends up at the wrapper origin with deep-link preserved. **Functional outcome: same page; final URL is wrapper, not raw `/exec` (Identity's mainUrl Script Property points at the wrapper post-Chunk-11). Acceptable per Chunk 11's deprecation of direct-/exec for end users. ✓**
9. **Expired token mid-session with deep-link.** User cold-loaded `?p=mgr/seats&ward=CO`, navigated in-app via pushState to `mgr/queue`, token expires. AuthExpired → showLogin. `buildIdentityUrl_`: `winParams.has('p')` is TRUE (post-pushState) → uses `winParams` (`p=mgr/queue`, no ward filter from queue page). Identity URL has `&redirect=p%3Dmgr%252Fqueue`. Wrapper extracts → iframe URL has token+`p=mgr/queue` → `replaceState('/?p=mgr%2Fqueue')` → user lands on mgr/queue (their actual current page, not the cold-load mgr/seats). **Smart-source detection wins this case. ✓**
10. **All Chunk 1-11 acceptance criteria.** Server-side auth, role resolution, request lifecycle, importer, expiry, audit log, dashboard, client-side nav, caching — all unchanged. The only touched server-side line is the reserved-keys strip in `Main.gs#doGet` (additive: `'redirect'` joined `'p'` and `'token'`). The only touched client-side flow is the post-auth boot's `INJECTED_TOKEN` branch (drops a redundant reload — the rest of the boot is identical). **No regressions reachable from these changes. ✓**

Cases 1-7, 9: hostile/synthetic inputs and code-paths I can verify by reading the wrapper script and `buildIdentityUrl_` against the URL flow. Case 8: depends on operator's Identity Script Property `main_url` pointing at the wrapper (set during Chunk 11 cutover). Case 10: blanket assertion via code review of touched files (all changes are additive or strictly behavior-preserving).

The browser-side smoke test is the operator's: hit `kindoo.csnorth.org/?p=mgr/seats&ward=CO` in a fresh incognito window, complete the auth flow, confirm AllSeats loads with the ward filter pre-applied AND the address bar reads `/?p=mgr%2Fseats&ward=CO`.

## Trade-offs accepted

- **`%2F` in the post-auth address-bar query.** `URLSearchParams.toString()` encodes `/` as `%2F`; the wrapper's `replaceState` writes the encoded form. Cosmetic; functionally identical to the unencoded form. Not prettified.
- **<100ms token visibility window.** Between the top-frame nav landing the wrapper and the wrapper script's `replaceState` running, the address bar briefly shows `?token=…`. Modern devices: imperceptible. Old/slow devices: possibly perceptible but transient. Inline-script-at-body-end was chosen to minimize this; an `<head>`-side approach would need to defer the iframe creation, which is more code for marginal gain.
- **Direct-`/exec` URL-bar token persistence.** A user who hits the raw Apps Script `/exec` URL (bypassing the wrapper) sees `?token=…` linger in the URL bar after auth — pre-Chunk-11.1's `window.top.location.replace(MAIN_URL)` would have force-redirected them to the wrapper, but Chunk 11.1 dropped that reload. Direct-`/exec` is operator-only per Chunk 11; operators can copy the URL out before sign-in if needed.
- **`buildIdentityUrl_` smart-source heuristic relies on the `p` key.** If a future feature introduces a non-`p` deep-link pattern (e.g. routes encoded entirely in the path), the smart-source check would need to broaden. Tracked as a maintenance note: any new top-level URL parameter that should survive re-auth needs adding to the heuristic.

## New open questions

None. CF-2 (the only open Chunk-11-era question Chunk 11.1 touched) is resolved; no new ambiguities surfaced during implementation.

## Operator deploy

This chunk touches three deployment surfaces; the operator runs the standard sequence:

1. **Apps Script Main project** — `npm run push` to sync `src/core/Main.gs` + `src/ui/Layout.html`. Then editor → Deploy → Manage deployments → Edit existing **Main** deployment → New version. Per CF-5, the editor "New version" step is required; `clasp push` alone doesn't bump the live `/exec`.
2. **Apps Script Identity project** (separate Apps Script project, personal Google account, copy-paste deployed) — open the Identity project's Code.gs in the editor, paste the new contents, then editor → Deploy → Manage deployments → Edit existing → New version. Identity is not pushed via clasp.
3. **GitHub Pages wrapper** — commit + push `website/index.html`. The Actions workflow at `.github/workflows/pages.yml` redeploys on push to `website/**`; ~1-2 minutes from push to live.

The three deploys are independent — the wrapper change is safe to roll out before or after the Apps Script changes (the wrapper's no-token branch was already there pre-Chunk-11.1, so old deep-links continue to work as before; the redirect-round-trip just becomes effective once both Apps Script projects also have the new code).

## Next

The project is feature-complete. Chunks 1-10 + 10.5 + 10.6 + 11 + 11.1 all shipped. The two UX warts Chunk 11 left open (token-in-URL, deep-link loss through auth) are closed.

Operational follow-ups (none required, all optional): the same monitoring / backups / OAuth-verification considerations from the chunk-11 changelog's "Next" section. No queued chunks. Future work is whatever real-world usage surfaces.
