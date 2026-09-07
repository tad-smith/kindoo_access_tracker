# Security headers on Hosting; closed shadow root in the extension

**PR #297 · 2026-09-07**

The two HIGH findings from the 2026-09-06 security review.

## Clickjacking — closed, enforcing

`firebase.json` set only `Cache-Control`. Nothing stopped the SPA being framed,
so a signed-in manager's hijacked click could land on **Add manager** in
Configuration → Kindoo Managers — a write Firestore rules must allow, because it
arrives carrying the manager's real token. Rules cannot defend clickjacking;
only a header can.

`Content-Security-Policy: frame-ancestors 'none'` now ships **enforcing**, with
`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and
`Cross-Origin-Opener-Policy`.

**`frame-ancestors` rather than `X-Frame-Options`, and this is the part not to
undo.** XFO has only `DENY` and `SAMEORIGIN`. Neither permits the cross-origin
framing the Firebase Auth iframe needs, and Hosting cannot *unset* a header on a
narrower glob — so an XFO on `**` could not be scoped away from `/__/auth/*`.
Since `<project>.firebaseapp.com` is a hostname of this same Hosting site, that
would have broken Google sign-in with nothing in this repo to catch it.
`frame-ancestors` can be overridden per path: a `/__/**` entry, placed last
because Hosting is last-match-wins, relaxes it and COOP for the reserved
namespace.

## Full CSP — report-only, deliberately

`Content-Security-Policy-Report-Only` carries the complete policy. Its
`connect-src` has to cover Firestore's WebChannel long-poll, and a wrong entry
fails as *an app that loads but never shows data*. One deploy of reports first,
then the flip.

Three values are load-bearing. `firebase.json` is strict JSON and cannot hold
comments, so they are recorded here:

- **COOP is `same-origin-allow-popups`, not `same-origin`.** Sign-in is
  `signInWithPopup`; plain `same-origin` severs `window.opener` and it silently
  never completes.
- **`script-src` carries `https://www.gstatic.com`** — the `**` header also
  governs `/firebase-messaging-sw.js`, whose `importScripts` loads the compat
  SDK from there. Omit it and background push dies.
- **No COEP.** It breaks the auth iframe and that same gstatic load. COOP alone
  is what is wanted.

`/help/**` has its own looser policy: two hand-authored guides carry an inline
`<script>` and an inline `<style>`. (An earlier draft of this entry also claimed
an inline `onclick`; there is none — the grep behind that claim matched the
`on="` inside `content="`.) A nonce or hash per build would let one strict
policy cover everything and is the better end state; the looser block is the
cheap step, and those pages are static, in-repo, and fetch nothing —
`connect-src 'none'`.

**Flipping to enforcing renames two headers, not one.** `/help/**` overrides
`**` only while both use the same key. Rename just the `**` one and the help
pages fall under both policies at once, intersected, losing the
`'unsafe-inline'` their inline script needs. The procedure is in
`infra/runbooks/deploy.md`.

## Closed shadow root

`extension/src/content/mount.tsx` attached the panel with `mode: 'open'`, inside
`web.kindoo.tech` — an origin this project does not control. Page script could
read every queued member's name, email and reason off `.textContent`, and
synthesise clicks on Provision & Complete (which runs `applyRequest` with **no
confirmation step**), Reject, both sign-in buttons, and the remote-apply opt-in.
React cannot distinguish a synthetic click from a real one.

`mode: 'closed'` removes both paths. Isolated worlds carry their own DOM wrapper
prototypes, so a main-world patch of `Element.prototype.attachShadow` cannot
capture the root either. `PanelHandles` now carries the root, since with it
closed that reference is the only one in existence.

One existing test asserted `host.shadowRoot?.textContent` did **not** contain a
string. Under a closed root that is `undefined?.textContent` → `undefined`, so
it would have passed vacuously — green while testing nothing. Rewired through
the handle, and a test now pins `host.shadowRoot === null` directly, because
that null *is* the boundary.

## What is not covered

E2E runs against `vite preview`, which ignores `firebase.json` entirely, so the
header globs have **no automated coverage** and can regress silently. The curl
block in `infra/runbooks/deploy.md` is the only check, and signing in on staging
is the only way to confirm the `/__/**` override still holds.
