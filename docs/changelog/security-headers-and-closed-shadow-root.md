# Anti-framing headers on Hosting; closed shadow root in the extension

**PR #297 · 2026-09-07**

The two HIGH findings from the 2026-09-06 security review.

## Clickjacking

`firebase.json` set only `Cache-Control`. Nothing stopped the SPA being framed,
so a signed-in manager's hijacked click could land on **Add manager** in
Configuration → Kindoo Managers — a write Firestore rules must allow, because it
arrives carrying the manager's real token. Rules cannot defend clickjacking;
only a header can.

Now enforcing on `**`: `Content-Security-Policy: frame-ancestors 'none'`, plus
`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and
`Cross-Origin-Opener-Policy`.

Three things not to undo. `firebase.json` is strict JSON and cannot hold
comments, so they live here:

- **`frame-ancestors`, not `X-Frame-Options`.** XFO has only `DENY` and
  `SAMEORIGIN`. Neither permits the cross-origin framing the Firebase Auth
  iframe needs, and Hosting cannot *unset* a header on a narrower glob — so an
  XFO on `**` could not be scoped away from `/__/auth/*`. Since
  `<project>.firebaseapp.com` is a hostname of this same Hosting site, that
  would have broken Google sign-in.
- **The `/__/**` block must stay last.** Hosting is last-match-wins, and that
  entry is what relaxes `frame-ancestors` and COOP for the reserved namespace.
  It covers the popup as well as the iframe: a `same-origin-allow-popups` opener
  keeps `window.opener` only if the popup's own COOP is `unsafe-none`.
- **COOP is `same-origin-allow-popups`, not `same-origin`.** Sign-in is
  `signInWithPopup`; plain `same-origin` severs `window.opener` and it silently
  never completes.

No full Content-Security-Policy here. The finding was clickjacking and
`frame-ancestors` closes it; a complete policy is a larger piece of work whose
`connect-src` has to cover Firestore's WebChannel long-poll, and getting that
wrong fails as *an app that loads but never shows data*.

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

**Accepted cost:** Playwright cannot evaluate inside an extension's isolated
world, so this forecloses browser-level coverage of the panel entirely. Unit
tests plus the unpacked-load step in `infra/runbooks/extension-deploy.md` are
what remain.

One existing test asserted `host.shadowRoot?.textContent` did **not** contain a
string. Under a closed root that is `undefined?.textContent` → `undefined`, so
it would have passed vacuously — green while testing nothing. Rewired through
the handle, and a test now pins `host.shadowRoot === null`, because that null
*is* the boundary.

## Not covered by CI

E2E runs against `vite preview`, which ignores `firebase.json`, so the header
globs can regress silently. The curl block in `infra/runbooks/deploy.md` is the
only check, and signing in on staging is the only way to confirm the `/__/**`
override still holds.
