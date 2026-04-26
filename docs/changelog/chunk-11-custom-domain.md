# Chunk 11 — Custom domain via iframe wrapper

**Shipped:** 2026-04-25
**Commits:** `0ad6919..5a55355` (Phase 1 + Step 6 iframe URL replacement; plus the GitHub-auto-committed `0e7725c` adding `docs/CNAME`)

## What shipped

`https://kindoo.csnorth.org` now serves the app with **no Apps Script banner**. A static `docs/index.html` page on GitHub Pages contains a single full-viewport iframe pointing at the Main `/exec` URL; both `doGet` deployments (Main + Identity) set `setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)` so the cross-origin embed is permitted. The top frame at `kindoo.csnorth.org` is the static wrapper (no banner-bearing chrome at all); the wrapper iframe loads Apps Script directly.

`Config.main_url` was flipped from the raw Main `/exec` URL to `https://kindoo.csnorth.org`, with the matching `main_url` Script Property in the Identity project updated in lockstep, so the Identity → Main post-sign-in redirect lands users back on the wrapper origin.

The wrapper carries one small piece of JavaScript — six lines, same-origin only — that copies `window.location.search` into the iframe `src` before the iframe's first navigation. This makes wrapper-origin direct-load deep links work for already-signed-in users (`https://kindoo.csnorth.org/?p=mgr/seats&ward=CO` lands on the filtered AllSeats page), and it's also what makes Identity's post-sign-in `?token=…` redirect reach Main's `doGet` for HMAC verification.

The full operator runbook (DNS, GitHub Pages, push + redeploy on existing deployments, iframe URL replace, `Config.main_url` flip, end-to-end auth tests, multi-user smoke test, Workspace mail regression check) ran cleanly end-to-end with no discrepancies surfaced against the documented steps.

## Deviations from the pre-chunk spec

- **Iframe-embed wrapper, not a Cloudflare Worker proxy.** `spec.md` §12 and `architecture.md` §11 both described a Worker on `csnorth.org` proxying `kindoo.csnorth.org/*` to the Main `/exec` URL. **A transparent proxy delivers the pretty URL but cannot remove the *"This application was created by a Google Apps Script user"* banner** — the banner lives in the outer wrapper page Apps Script serves from `script.google.com`, which a transparent proxy ships through unchanged; stripping it would require modifying HTML in flight (brittle, breaks any time Apps Script's wrapper changes). The iframe-embed approach removes the banner because the top frame never loads Apps Script's outer wrapper page at all. Spec: `architecture.md` §11 fully rewritten; `spec.md` §2/§12/§14 updated.
- **GitHub Pages, not Cloudflare.** No proxy in the request path; one CNAME at Squarespace points `kindoo` at `<github-username>.github.io`; HTTPS auto-provisioned by Let's Encrypt; no Cloudflare account introduced. Spec: `architecture.md` §11.
- **Wrapper carries a six-line same-origin JavaScript forwarder.** The original Phase 1 design called for a strictly no-JS wrapper. Recognising that "no JS" was conflating the genuinely problematic case (cross-origin `postMessage` for iframe height auto-sizing) with a benign one (same-origin DOM read of `window.location.search` to set the iframe's `src` once before navigation), the wrapper grew this minimum to make wrapper-origin deep-links + post-sign-in token landing actually work. Spec: `architecture.md` §11 "Why the wrapper carries (a tiny bit of) JavaScript".

## Decisions made during the chunk

- **`ALLOWALL` was already on every `doGet` HtmlOutput** (Main.gs:75, identity-project/Code.gs:117, identity-project/Code.gs:154 for the shared `Identity_errPage_` helper covering all three error returns). No Apps Script code change was needed for Chunk 11; the runbook's "apply ALLOWALL" step collapsed to a *push + verify* step. Recorded in `architecture.md` §11 as an audit table.
- **`Config.main_url` is edited directly in the Sheet's `Config` tab, not via the manager Configuration page.** The key is in `CONFIG_PROTECTED_KEYS_` (`src/repos/ConfigRepo.gs:47`) — the manager UI renders it read-only by design (open-questions.md C-4). Direct-Sheet edits bypass `AuditRepo`, so no audit row was written for the cutover. Acceptable given the operational nature of the change and that the wrapper-cutover is documented in this changelog.
- **Identity's `main_url` Script Property updates in lockstep with `Config.main_url`.** Identity reads `main_url` from its own Script Properties, not from the Sheet (`identity-project/Code.gs:49`). Updating only the Sheet would leave Identity redirecting to the raw `/exec` URL post-sign-in. Runbook Step 8 enforces the paired update.
- **Deploy → New version on the *existing* Main + Identity deployments**, not new deployments. New deployments mint fresh `/exec` URLs; preserving the existing URL is necessary so `Config.main_url` (pre-cutover), Identity's `main_url` Script Property, and every existing user bookmark continue to work. Runbook Step 5.
- **`docs/runbooks/chunk-11-custom-domain.md` follows the existing `docs/runbooks/<name>.md` convention** (alongside the paused-Firebase-migration `enable-warm-instances.md`), rather than the `docs/runbook-chunk-11.md` path the original brief sketched.
- **No OAuth Client ID changes were needed.** The auth flow uses HMAC session tokens (Chunk 1, A-8). `src/ui/Login.html` is a plain anchor — no `google.accounts` JS library, no GSI library — so neither `https://kindoo.csnorth.org` nor `https://script.google.com` needed to be added to OAuth Authorized JavaScript Origins. Verified by grep across `src/` and `identity-project/`.

## Spec / doc edits in this chunk

- `docs/spec.md` — §2 Stack "Domain" line rewritten (GitHub Pages wrapper iframe, not Cloudflare Worker); §12 "Custom domain" section fully rewritten; §14 build-order Chunk 11 entry rewritten with explicit Worker-proxy → iframe-embed pivot note.
- `docs/architecture.md` — §11 fully rewritten: ASCII diagram of the wrapper / Apps Script / user-content nesting; "Why this shape (and not a Cloudflare Worker proxy)" rationale; full `docs/index.html` listing including the JS forwarder; "Why the wrapper carries (a tiny bit of) JavaScript" explainer; ALLOWALL audit table; trade-offs (top-frame back, Continue click, third-party cookies, GitHub Pages as host); "Why GitHub Pages over a Cloudflare Worker" decision rationale.
- `docs/build-plan.md` — Chunk 11 section rewritten end-to-end: dependencies, architectural pivot note, auth-pattern note (HMAC, no OAuth), Apps-Script-side deliverables (all `[x]`), operator-driven deliverables (now `[x]` post-runbook), acceptance criteria split into in-app / already-signed-in / pre-sign-in deep-link cases, "Out of scope" trimmed to just the pre-sign-in `?p=` gap. Header marked `[DONE — see docs/changelog/chunk-11-custom-domain.md]` in this chunk.
- `docs/open-questions.md` — CF-1 marked `[RESOLVED 2026-04-25 — pivoted to iframe-embed wrapper, not a Worker proxy]` with full discovery trail (banner-removal-needs-iframe). CF-2 retained at `[P2]` with revised scope: only the pre-sign-in deep-link case is open; in-app + already-signed-in cases work. CF-3 added (iframe-embed durability against future browser changes — third-party cookie partitioning, Storage Access API, etc.). CF-4 added (GitHub Pages as wrapper host — reliability, lock-in, future server-side wrapper logic).
- `docs/TASKS.md` — #6 marked done (see the entry below).
- `docs/index.html` *(new)* — wrapper page; full-viewport iframe + `clipboard-read; clipboard-write` allow + same-origin query-string forwarder script.
- `docs/runbooks/chunk-11-custom-domain.md` *(new)* — 10-step operator runbook with verification points, rollback notes, and a pre-deploy sanity check.
- `docs/CNAME` *(new, GitHub-auto-committed during Step 2)* — single line `kindoo.csnorth.org` written by GitHub Pages when the custom domain was saved.

## Trade-offs accepted

- **Top-frame back-button leaves the app**, rather than navigating within it. Chunk 10.6's `pushState` / `popstate` work happens inside the wrapper iframe; the top frame's history stack contains only `kindoo.csnorth.org` and whatever the user came from. In-app back / forward still works via the iframe's own history. Accepted because users do not typically use browser-back in this app.
- **The auth flow's "Continue" click on Identity remains.** Required by the Apps Script iframe sandbox's user-activation rule for cross-origin top-frame navigation; nothing about the wrapper changes it. Out of scope for Chunk 11.
- **Two iframe boundaries.** `kindoo.csnorth.org` (wrapper) → Apps Script's outer iframe context, briefly → `n-<hash>-script.googleusercontent.com` (the user-content iframe where Main's HTML actually runs). All cross-origin navigations the app needs (`window.top.location.replace` for the auth round-trip) still work — they navigate the *top* frame regardless of how deep the iframe nesting is.
- **Pre-sign-in wrapper-origin deep links lose `?p=`** through the auth round-trip. Identity's redirect carries only `?token=…`. In-app deep links work; already-signed-in wrapper-origin deep links work; only fresh-sign-in-from-deep-link is gapped. Tracked in `open-questions.md` CF-2; closing it would require an auth-flow change (teach Identity to echo a `next` page-parameter back).

## New open questions

- **CF-3** (`P2`) — iframe-embed durability against future browser changes (third-party cookie partitioning, Storage Access API enforcement, COEP/COOP). Current architecture is resilient (HMAC token in `sessionStorage` which is partitioned per-origin and unaffected by third-party cookie restrictions; the wrapper does no cross-origin `postMessage`), but the surface area is non-zero. Documented fallback if iframe-embed becomes unusable: drop wrapping and accept the banner; second-fallback is a Cloudflare Worker as a transparent proxy (no longer in scope but reachable as a path forward).
- **CF-4** (`P2`) — GitHub Pages as the wrapper host. Reliability ~99.9%; lock-in is essentially nil (the wrapper is one HTML file); HTTPS auto-renews via Let's Encrypt. If we ever need server-side wrapper logic (auth gating, rate limiting, A/B), the wrapper migrates to Cloudflare Pages + Worker or similar. No current need.

## TASKS.md follow-ups

- **#6 "Use OAuth to try and get rid of the Apps Script warning"** — DONE 2026-04-25, addressed by Chunk 11. The "warning" the task referred to is the *"This application was created by a Google Apps Script user"* banner, which the iframe wrapper hides by not loading Apps Script's outer wrapper page at the top frame. The mechanism differs from the original framing (iframe wrapper, not OAuth verification submission), but the user-facing outcome is the same: the banner is gone. OAuth verification submission is no longer needed for banner removal; it remains optional if a future need surfaces (e.g. removing the first-time per-user consent prompt on the Identity project — a different concern from the banner).

## Deferred

- **Pre-sign-in deep-link `?p=` preservation through Identity round-trip.** Auth-flow change — teach the Login link to pass `?next=<pageId>&…` through to Identity, and Identity to echo it back into the post-sign-in redirect. Tracked in `open-questions.md` CF-2; deferred until real-usage signal that anyone hits this. The realistic deep-link use cases (sharing URLs to teammates already in the app) are covered.
- **OAuth verification submission to Google.** Was loosely associated with TASKS.md #6 in the original framing. Not needed for banner removal post-Chunk-11. Remains optional if a future need surfaces (e.g. removing the first-time per-user OAuth consent prompt on the Identity project for the email scope — a one-time per-user prompt, not a banner).
- **Wrapper-origin iframe height auto-sizing**, animations, skeleton loaders. Not needed for the full-viewport case; explicitly out of scope for the wrapper minimum.
- **Staging wrapper / staging subdomain.** Single-environment is fine at this scale.

## Next

**The project is feature-complete.** Chunks 1–10 + 10.5 + 10.6 + 11 are all shipped; every acceptance criterion across the 11-chunk build plan passes; the Apps Script app runs at `https://kindoo.csnorth.org` with full role-aware UI, auth, importer, expiry, requests, audit log, dashboard, client-side navigation, caching, and now a custom domain with no Apps Script banner. There is no Chunk 12.

Future work is **operational**, not feature-development:

- **Monitoring** — pick a cadence to spot-check the daily expiry and weekly import audit rows; surface a deferred "last over-cap warning" via the Dashboard's existing Warnings card; consider a manual-import-now sanity check after any LCR template changes.
- **Backups** — the backing Sheet has Drive's built-in revision history; consider a periodic Apps Script export to a sibling backup Sheet if data loss tolerance changes.
- **Operational runbooks** — `docs/runbooks/` is the right home for any new procedures (rotating `session_secret`, rebuilding triggers, recovering from a header-drift error, etc.). The `enable-warm-instances.md` runbook from the paused Firebase migration is harmless to keep as a reference for that path forward.
- **Future-proofing** — CF-3 (iframe-embed durability) and CF-4 (GitHub Pages as wrapper host) are both `P2` and surface only if a browser policy change or hosting incident makes them load-bearing. The documented fallbacks (drop iframe-embed → accept banner; migrate wrapper off GitHub Pages → Cloudflare Pages or similar) are both single-day operations.

The Firebase migration plan in `docs/firebase-migration.md` remains paused as of 2026-04-24; nothing in Chunk 11 changes that decision. With Chunk 11 shipped and the app fully functional behind a clean URL, the case for the Firebase rewrite has gotten incrementally weaker — the largest UX wart it would have closed (the banner) is now closed without the rewrite. Revisit if real-world usage surfaces the auth-complexity / no-API / deployer-as-actor pain points the migration plan was meant to address.
