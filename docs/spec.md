# Stake Building Access — Specification

> **Live source of truth.** This doc always describes the system as it is right now. Code and spec change together, in the same commit — if you want to know what the deployed app does, this is the file. Per-phase history and deviation rationale live in [`docs/changelog/`](changelog/); read the latest phase file plus this doc to be caught up. The Firebase data model and security rules are referenced in [`firebase-schema.md`](firebase-schema.md). Numbered architecture decisions live in [`architecture.md`](architecture.md). Ambiguities and watch-outs are tracked in [`open-questions.md`](open-questions.md).
>
> **Phase 11 cutover (2026-05-03):** this spec was rewritten in lockstep with the cutover from describing the legacy Apps Script implementation to describing the Firebase implementation. The Apps Script source and its per-chunk changelog history were removed from the repo on 2026-05-11; the content is preserved in git history. See [`docs/changelog/phase-11-cutover.md`](changelog/phase-11-cutover.md).

## 1. Context

The Church of Jesus Christ of Latter-day Saints organizes members into **stakes**, each containing multiple **wards** (individual congregations). This app is built for a single stake; the schema is parameterized on `{stakeId}` from day one (per F15) so a future second stake is a routing change rather than a data refactor.

**Kindoo** is a door-access system licensed per seat. The stake receives a global pool of seats and allocates them across its wards and its own stake-level pool.

There are three seat types:

| Type | How it's assigned | Lifecycle |
| --- | --- | --- |
| **Automatic** | Tied to callings (church roles) assigned in LCR (the church's membership system). | Managed via the Chrome extension's Sync feature, which reads the operator's live Kindoo session (Kindoo itself ingests LCR via Church Access Automation). See §8. |
| **Manual** | Assigned to an individual. | Held until explicitly removed. |
| **Temporary** | Assigned with a start and end date. | Auto-expires on the end date. |

Bishoprics (Bishop + two counselors; one bishopric per ward) submit requests for manual/temp seats in their ward. The Stake Presidency does the same against the stake pool. One or more **Kindoo Managers** process those requests by manually mirroring changes into Kindoo (which has no API), then marking the requests complete.

## 2. Stack

- **Identity:** Firebase Authentication. The auth token (refreshed automatically by the Firebase JS SDK) carries custom claims that drive role resolution; see §4. Two providers are enabled at the Firebase Console level — Google and Email-link (passwordless) — and the SPA UI surfaces both (Google popup CTA above the magic-link form) while the Chrome extension uses only Google; see §4.1.
- **Authorization:** Firestore Security Rules consult `request.auth.token.stakes[stakeId]` for role checks. Custom claims are the only authoritative role source — there are no per-request Firestore lookups for role resolution from rules. See `firebase-schema.md` §6.
- **Database:** Firestore in Native mode (`us-central1`), single-stake project at `kindoo-prod`. All collections are parameterized under `stakes/{stakeId}/...` with three top-level collections (`userIndex`, `platformSuperadmins`, `platformAuditLog`) for cross-stake plumbing. Schema authoritative in `firebase-schema.md`.
- **Client:** React 19 + TypeScript + Vite SPA, served from Firebase Hosting. Reads Firestore directly through the JS SDK; writes go through Firestore transactions or `setDoc`/`updateDoc` with rules enforcing field-level invariants. TanStack Router for routing, TanStack Query as the cache substrate, with a small DIY hooks layer at `apps/web/src/lib/data/` (per architecture D11) that pushes `onSnapshot` results into the query cache.
- **Server compute:** Cloud Functions (2nd gen, Node 22) only — no Cloud Run, no Express, no per-request server-side path. Functions cover: daily temp-seat expiry, email send (Resend), audit-log fan-in, custom-claims sync, FCM push fanout, callable endpoints for the bootstrap wizard's manager-triggered actions, and a nightly audit-gap reconciliation. Auto-seat creation runs entirely through the extension's Sync feature — see §8. Function inventory: `firebase-schema.md` §7.
- **Email:** [Resend](https://resend.com) on the free tier (100/day, 3000/month). Domain verification on `mail.stakebuildingaccess.org` per F17. Wrapper at `functions/src/lib/resend.ts`; typed sender per notification type at `functions/src/services/EmailService.ts`. See §9.
- **Push notifications:** FCM Web Push, additive-opt-in on a per-device basis. Per-user `notificationPrefs` and per-device `fcmTokens` live on `userIndex/{canonical}`. Service worker at `apps/web/public/firebase-messaging-sw.js` handles background pushes. Phase 10.5 ships only "new request → managers"; the four-other-types expansion is Phase 10.6, deferred.
- **Scheduling:** Cloud Scheduler invokes the expiry callable wrapper on schedule. Per-stake scheduling is single-loop (one Scheduler job calls one Function which iterates over stakes whose schedule matches).
- **Hosting / domain:** Firebase Hosting on `kindoo-prod` serves the SPA build at both `stakebuildingaccess.org` (the F17 brand apex, live 2026-05-13) and the legacy `kindoo.csnorth.org` (live since Phase 11 cutover 2026-05-03). Both hostnames have auto-provisioned Let's Encrypt certs. Dual-hosting is the chosen final state — no redirect, no takedown of the legacy hostname.
- **PWA:** `vite-plugin-pwa` configures the service worker (cache-first for static assets, network-first for `index.html`, never cache Firestore traffic) and manifest. App is installable on iOS, Android, and desktop.
- **Local dev:** Firebase emulator suite (Firestore, Auth, Functions, Hosting). `pnpm dev` runs emulators + Vite + Functions in parallel.

### 2.1 Active stake

A user can hold roles on more than one stake simultaneously (per F18 / `architecture.md` D15). The SPA carries an **active-stake selector** that picks which stake's data the current tab is reading and writing. The selector's behaviour is fully specified here because it spans URL, per-tab session, and cross-tab sticky storage; the implementation lives in `apps/web/src/lib/activeStake.ts` (or equivalent, established in Phase 12's 12.4 PR).

**Resolution priority**, top wins. The chain fires on first render AND on every subsequent URL change that carries a new `?stake=X` param — necessary because the service-worker `notificationclick` handler reuses an existing window via `clients.matchAll` → `postMessage` → router navigation (see `apps/web/src/firebase-messaging-sw.template.js:70-92`), so a push tap on an already-open tab arrives mid-lifecycle, not at mount. 12.4 implementation must subscribe to the router-history navigation event (or equivalent) and re-run the validate-then-strip step on every `?stake=X` arrival.

1. URL `?stake=X` — read on first render and on every router navigation that carries the param, then `history.replaceState` strips it so the URL bar stays clean from then on. When the URL value resolves successfully (passes the validation step below), the SPA writes the value to both `sessionStorage` AND `localStorage` — same symmetric write as the switcher click handler — so subsequent reads in the same tab and fresh tabs see the deep-linked stake as sticky. Used by push-notification deep links (`click_action: https://<host>/<path>?stake=X`) and operator-shared URLs that need to target a specific stake.
2. `sessionStorage['kindoo.activeStake']` — per-tab. Switching the active stake in tab A does not retarget tab B.
3. `localStorage['kindoo.activeStake']` — sticky default. Fresh tabs that have no `sessionStorage` entry fall through to the last stake the user switched to in any tab.
4. Principal-derived first stake — deterministic sort across the union of `managerStakes ∪ stakeMemberStakes ∪ Object.keys(bishopricWards)`. The "first stake" tiebreaker is alphabetical on the stake's doc ID. This branch fires for a user's first-ever sign-in (no `localStorage` entry yet) and for a fresh tab whose `localStorage` was cleared.

**Switcher click handler** writes both `sessionStorage` AND `localStorage` and invalidates TanStack Query's per-stake reads so the SPA refetches against the newly-selected stake. The URL does not change.

**Stake switcher dropdown** in the brand bar surfaces a drop-down next to the current stake name when the user has any role on ≥ 2 stakes. Hidden entirely when the user has access to only one stake. Visible to all role types — managers, stake-presidency members, bishopric — anyone who holds a role on more than one stake.

**Middle-click / new-tab caveat.** A tab opened via middle-click on an in-SPA link starts with an empty `sessionStorage` and falls through to `localStorage`. That's acceptable: `localStorage` is almost always the right stake, and there is no `?stake=X` stamping on `<Link>` `href`s — the URL stays clean. If the user opens a new tab into a stake they weren't last on, they switch with the dropdown.

**No URL pollution.** Path-prefixed (`/{stakeId}/...`) URLs and on-every-link `?stake=X` query params were both considered and rejected. The query param is an entry-boundary signal only — push deep links and operator-shared URLs carry it; the SPA reads it once, persists it, and strips it.

**Invalid `?stake=X` or stale storage value.** The URL and both storage tiers (sessionStorage, localStorage) can name a stake the principal no longer has access to (shared link to a foreign stake, stale push tap after role revocation, hand-typed URL, last-active stake whose role was rotated away). The principal-derived branch (priority 4) is valid by construction; tiers 1, 2, and 3 must each validate-and-fall-through. On first render the SPA validates each tier's value against the principal's accessible set (`managerStakes ∪ stakeMemberStakes ∪ Object.keys(bishopricWards)` plus `isPlatformSuperadmin === true`, which can access any stake's `/superadmin/...` routes but not per-stake data). If a tier's value is invalid, the SPA ignores it, falls through to the next tier, and surfaces a one-time toast "This notification was for a stake you no longer have access to." (or "Your last-active stake is no longer available; switched to <new stake>." for the storage-tier case). The `history.replaceState` strip still runs on the URL so a bad param doesn't survive in the URL bar; an invalid storage entry is overwritten with the resolved-active stake.

**Zero-role platform superadmin.** A platform superadmin with no manager / stake / bishopric roles on any stake (the first-run state immediately after the operator seeds the first superadmin) has no accessible stake to render against. `useActiveStake()` returns `null` in this state — downstream consumers (TanStack Query keys, the `stakes/{activeStake}/…` path builder, the StakeSwitcher dropdown) must skip per-stake reads when the value is `null`. The brand bar shows no stake name (just the product mark). The post-sign-in landing route is `/superadmin/stakes` instead of the role-default per §5. The same first-run state applies to a superadmin who has created stakes but is not a member of any of them — they manage the platform via the Superadmin section without ever entering a per-stake page.

**Pre-claim bootstrap admin.** An authenticated user named as `bootstrap_admin_email` on a newly-created stake (`setup_complete === false`) whose wizard has not yet run has no role docs anywhere: `managerStakes`, `stakeMemberStakes`, and `bishopricWards` are all empty, so `accessibleStakes(principal)` is `[]`. The wizard's `useEnsureBootstrapAdmin` writes the kindooManager grant as part of completing setup; until then the claim-sync triggers have nothing to mint a claim from. To keep the wizard reachable in this state, the resolver treats an authenticated principal who has zero accessible stakes AND is not a platform superadmin as a **bootstrap candidate**: tiers 1 (URL), 2 (sessionStorage), and 3 (localStorage) each accept any non-empty stake slug **without validating against the (empty) accessible set**, and no invalidation toast fires. Tier 4 (principal-derived) still returns `null` because the accessible set is empty. The carve-out is implemented in `apps/web/src/lib/activeStake.ts` (`isBootstrapCandidate = accessible.length === 0 && !principal.isPlatformSuperadmin`).

The carve-out is a routing-resolver accommodation only — it does not loosen any per-stake-data rule. The downstream gate (`apps/web/src/lib/setupGate.ts`) decides whether to render the wizard by canonicalising the principal's token email and comparing it to the stake doc's `bootstrap_admin_email`; only the named bootstrap admin sees `'wizard'`. Anyone else with the same pre-claim shape (no claims yet, no role docs) who types `?stake=X` for a stake they aren't the bootstrap admin of resolves to `X` through this carve-out but is then dropped to `'setup-in-progress'` (or `'not-authorized'` once setup completes) by the gate. Firestore rules are unaffected — they continue to require `isAnyMember(stakeId)` for per-stake data reads.

The carve-out is intentionally narrow. It explicitly does NOT fire for unauthenticated users (`principal.firebaseAuthSignedIn === false`) — admitting an anonymous visitor to a `?stake=X` deep link as if they were a bootstrap candidate would surface setup state to a passer-by. It also does NOT fire for zero-role platform superadmins, who belong on `/superadmin/stakes`, not on a single-stake landing; stale storage tiers for that identity still invalidate so the "Your last-active stake is no longer available" toast still fires for them. See §10 for the bootstrap wizard's user-facing flow.

## 3. Data model

The authoritative schema reference is [`firebase-schema.md`](firebase-schema.md). This section names the collections and gives the role-resolution invariants; field-by-field shapes live in the schema doc.

### 3.1 Top-level collections

- **`userIndex/{canonicalEmail}`** — bridge between canonical-email-keyed role data and Firebase Auth's uid. Carries the FCM device-token map and per-category notification preferences. Written by `onAuthUserCreate` and by the user themselves (subscribing to push); claim-sync triggers translate canonical email → uid through this. See `firebase-schema.md` §3.1.
- **`platformSuperadmins/{canonicalEmail}`** — active source of truth for the platform-superadmin role (Phase 12). The `syncSuperadminClaims` trigger reads writes here and mints / revokes the `isPlatformSuperadmin: true` claim. Writes are console-only — there is no in-app management UI.
- **`platformAuditLog/{auditId}`** — cross-stake audit trail. The Phase 12 `createStake` callable writes `action='create_stake'` rows here; future cross-stake actions (e.g. superadmin add/remove triggers) append the same way.

### 3.2 Per-stake collections

All under `stakes/{stakeId}/`. Schema authoritative in `firebase-schema.md` §4.

- **`stakes/{stakeId}` (parent doc)** — collapses what was the legacy `Config` tab: stake_name, bootstrap_admin_email, setup_complete, stake_seat_cap, expiry_hour, timezone, notifications_enabled, last_over_caps_json, last_expiry_at, etc. `stake_seat_cap` is the home-site stake seat cap specifically — foreign-site wards (§15) draw against their own Kindoo site's pool, not this number. The `callings_sheet_id`, `import_day`, `import_hour`, `last_import_at`, `last_import_summary`, and `last_import_triggered_by` fields are deprecated — see `firebase-schema.md` §4.1.
- **`stakes/{stakeId}/wards/{wardCode}`** — 2-letter PK matching the LCR tab name and the `scope` value used elsewhere. Carries an optional `kindoo_site_id: string | null` (Kindoo Sites — §15); `null` / absent means the home site.
- **`stakes/{stakeId}/buildings/{buildingId}`** — slug-keyed (`Cordera Building` → `cordera-building`). Also carries `kindoo_site_id: string | null` with the same semantics.
- **`stakes/{stakeId}/kindooSites/{kindooSiteId}`** — foreign-Kindoo-site directory (§15). Manager-chosen slug as doc ID. Empty when the stake operates only its home Kindoo site.
- **`stakes/{stakeId}/kindooManagers/{canonicalEmail}`** — the manager allow-list. Doc existence + `active=true` defines the manager set.
- **`stakes/{stakeId}/access/{canonicalEmail}`** — per-user role-grant doc. Splits `importer_callings` (server-managed; Admin SDK only — written by Sync via the `syncApplyFix` callable) and `manual_grants` (manager-managed, via the manager Access page). Composite-key uniqueness on (canonical_email, scope, calling) is *structurally absent* — the two maps cannot collide. F7. Doc-level `sort_order` (Phase 10.3) denormalizes the lowest `sheet_order` across `importer_callings`. The `importer_callings` field name is historical (predates the LCR Sheet importer removal — see `architecture.md` D14); rename is out of scope.
- **`stakes/{stakeId}/seats/{canonicalEmail}`** — one doc per (stake, member). Multi-calling people get `callings: [...]`; the rare cross-scope collision lands the secondary grant in `duplicate_grants[]` and is informational, not counted in utilization. F5, F6. `sort_order` denormalizes the MIN of `sheet_order` across `callings[]`.
- **`stakes/{stakeId}/requests/{requestId}`** — UUID-keyed because a member can submit many requests over time. Carries the `urgent` flag (Phase 10.3) and the denormalized `seat_member_canonical` for remove-request completion. F19.
- **`stakes/{stakeId}/wardCallingTemplates/{callingName}`** — URL-encoded calling name as doc ID; carries `give_app_access`, `auto_kindoo_access` (Phase 10.4 — gates whether Sync's classifier produces an auto-seat fix), and `sheet_order` for wildcard tie-breaking + roster sort priority.
- **`stakes/{stakeId}/stakeCallingTemplates/{callingName}`** — same shape, applied to stake-scope Kindoo Description strings by Sync.
- **`stakes/{stakeId}/auditLog/{auditId}`** — flat, server-written audit collection. One row per write to seats, requests, access, kindooManagers, or the stake parent doc, fanned by the `auditTrigger` Cloud Function (F8). Doc IDs are deterministic from `(collection, docId, writeTime)` so retries are idempotent. 365-day Firestore TTL.

### 3.3 Naming and key conventions

- **Canonical email** is `lowercase + Gmail dot/+suffix strip + googlemail.com → gmail.com`. Computed in `packages/shared/canonicalEmail.ts` and applied at every input boundary. The canonical form is the doc-ID for `userIndex`, `kindooManagers`, `access`, and `seats` — there is no separate canonical column.
- **Typed-form email** (preserve case, dots, `+suffix`) is stored alongside in `member_email` / `typedEmail` for display and any future mail surface. The audit log carries both `actor_email` (typed) and `actor_canonical`.
- **Automated actors** use literal strings as the audit `actor_email` / `actor_canonical`: `"ExpiryTrigger"` (daily temp-seat expiry), `"RemoveTrigger"` (request-completion seat-side trigger fan-out), `"OutOfBand"` (writes not attributed to a specific trigger — see `auditTrigger` actor-resolution), `"Migration"` (one-shot backfills), and `"SyncActor:<code>"` (Sync's `syncApplyFix` writes, where `<code>` is the fix code that produced the row). Legacy `"Importer"` rows remain in the audit log from the pre-Sync era.
- **Building** doc IDs are slugs of `building_name`; the display name is preserved in the `building_name` field. Cross-collection references (e.g. `seats.building_names: string[]`) carry the slug.
- **Ward** doc IDs are the 2-letter `ward_code`; also the value used in `seats.scope`, `access.importer_callings` keys, and `requests.scope`.

## 4. Role resolution

The auth token's custom claims (set by Cloud Function triggers on `userIndex`, `access`, and `kindooManagers` writes) are the only authoritative role source. The token carries:

```typescript
{
  canonical: string;              // canonical email; trusted in rules
  isPlatformSuperadmin?: boolean;
  stakes?: {
    [stakeId: string]: {
      manager: boolean;           // active=true row in stakes/{stakeId}/kindooManagers/{canonical}
      stake: boolean;             // any non-empty grant in stakes/{stakeId}/access/{canonical} with scope='stake'
      wards: string[];            // ward_codes for which the user has any non-empty grant in scopes != 'stake'
    };
  };
}
```

Roles per stake:

- `stakes[stakeId].manager === true` → **Kindoo Manager** for that stake.
- `stakes[stakeId].stake === true` → **Stake Presidency** (or other stake-scope grant).
- A non-empty `stakes[stakeId].wards` → **Bishopric** for each listed ward.
- `isPlatformSuperadmin === true` → **Platform Superadmin** (cross-stake). Sourced from the `platformSuperadmins/{canonical}` allow-list via the `syncSuperadminClaims` trigger. Carries the Superadmin nav section in the SPA (see §5.4). Console-only management — no in-app UI for adding/removing superadmins.
- None of the above and not a superadmin → "not authorized".

A user can hold multiple roles per stake; the UI shows the union. A user can hold roles on multiple stakes simultaneously; the active stake (per §2.1) picks which stake the SPA is reading and writing against, and `usePrincipal()` (web) / `request.auth.token.stakes[stakeId]` (rules) consult that stake's claim sub-object.

The web app reads the principal via `usePrincipal()` from `apps/web/src/lib/principal.ts`, which derives the principal shape from the Firebase Auth token's custom claims. Rules read the same claims via `request.auth.token.stakes[stakeId]`. There is no second source of truth.

**Claim staleness.** When underlying role data changes (a manager toggles `active`, Sync adjusts `access.importer_callings` via `syncApplyFix`, etc.), the relevant sync trigger calls `setCustomUserClaims` then `revokeRefreshTokens` so the next request from that user picks up fresh claims. Worst-case staleness on revocation: ~1 hour for an idle session, <2 seconds for an active one (the SDK auto-refreshes on any 401).

**Bishopric lag.** A newly-called bishopric member can't sign in until Sync runs against the latest Kindoo data (which itself reflects Church Access Automation's LCR pull) and populates `access.importer_callings`. Accepted for v1.

### 4.1 Sign-in providers

Firebase Auth identifies the user; it does not authorize them. Authorization is keyed by canonical email and resolved exclusively from custom claims (§4). The provider that minted the Firebase user is irrelevant to authorization — Google and magic-link sign-ins for the same email resolve to the same `userIndex/{canonical}` doc and the same claim set.

**Surfaces.**

- **SPA (`apps/web/`):** Both providers visible. A "Continue with Google" button (calls `signInWithPopup` with `GoogleAuthProvider`) sits above the email magic-link form (email input + "Send me a sign-in link" submit). Both end at the same Firebase Auth UID for the same email when "Link accounts that use the same email" is enabled (Firebase Console → Authentication → Settings → User account linking — confirmed enabled 2026-05-18). No password field.
- **Chrome extension:** Google only, via `chrome.identity.getAuthToken` → Firebase credential exchange. Unchanged.

**Firebase Console provider config.** Both Google and Email/Password (with the Email-link sub-toggle on, password sub-toggle off) are enabled at the project level. Both are also surfaced in the SPA UI. Disabling either provider in Console would break the corresponding SPA affordance (and disabling Google would additionally break the extension).

**Google popup round-trip.** User visits `/` while signed out, clicks "Continue with Google" in the hero, and completes the Firebase Auth popup flow. On success the SPA force-refreshes the ID token (bounded-poll mitigation for B-4 — see `apps/web/src/features/auth/signIn.ts` module comment) and `gateDecision()` in `apps/web/src/routes/index.tsx` runs unchanged. The Google flow does NOT use `actionCodeSettings` / authorized continue URIs.

**Magic link round-trip.**

1. User visits `/` while signed out. Enters their email and clicks "Send me a sign-in link."
2. SPA calls `sendSignInLinkToEmail(auth, email, actionCodeSettings)` and stashes the typed email in `localStorage` for the return trip.
3. SPA renders a "Check your email" confirmation state on the same page.
4. User opens the email and clicks the link. The link lands on the SPA's action-handler route (path chosen by the implementer; the route is unauthed since the user is not yet signed in).
5. The handler route:
   - Reads the email from `localStorage`.
   - If absent (cross-device — link opened on a different device than where it was requested): prompts the user to enter the email address the link was sent to.
   - Calls `signInWithEmailLink(auth, email, window.location.href)`.
   - On success: clears the stashed email and redirects to `/`, where `gateDecision()` runs as it does today.
   - On error (expired link, malformed URL, email mismatch, network failure): renders a clear error message and offers a re-send affordance back to the sign-in flow.

**`actionCodeSettings`.** `url` is the full SPA action-handler URL (must include the host) and the host must be on Firebase Auth's Authorized Domains list (Console → Authentication → Settings → Authorized domains). **This is a separate Console-level list from the Firebase Hosting custom-domain config referenced in §12** — a host showing up under Hosting does NOT imply it's on the Auth Authorized Domains list. Adding a new authorized SPA host (or verifying an existing one is present) is a deployment prerequisite, not a runtime concern; a missing entry surfaces at runtime as `auth/unauthorized-continue-uri` on the `sendSignInLinkToEmail` call. `handleCodeInApp: true`. Verify before T-44 ships that the Auth Authorized Domains list contains `stakebuildingaccess.org`, `kindoo.csnorth.org`, and the project's default `kindoo-prod.firebaseapp.com` auth-domain entry.

**Authorization gate (unchanged).** A successful magic-link sign-in produces a Firebase user but does not by itself grant any role. A signed-in user with no `access` / `kindooManagers` / `superadmins` doc keyed to their canonical email lands on the existing `NotAuthorized` page exactly as a Google sign-in would. The sign-in page surfaces a short explanatory sentence so new users understand that creating an account does not immediately grant access — e.g., "New sign-ins land in pending authorization until a stake manager adds your email. Contact your stake manager if you can't reach the next screen."

**`userIndex` + claims sync (unchanged).** The `onAuthUserCreate` trigger writes a `userIndex/{canonical}` doc on first sign-in regardless of provider. Claim-sync triggers on `access` / `kindooManagers` / `superadmins` are keyed by canonical email, not by provider or uid. No backend changes ship with the SPA UI provider switch.

**Provider auto-linking — LOAD-BEARING ASSUMPTION.** Firebase Auth's project setting **"one account per email address"** (Console → Authentication → Settings → User account linking) auto-links the Google and Email-link providers for the same email under a single Firebase UID. **This is the Console default; verify it is still ON before T-44 ships.** An existing Google-signed-in user (e.g., the operator) who signs in via magic link to the same address keeps their UID, their `userIndex/{canonical}` doc, and every canonical-email-keyed role doc unchanged. If this setting were flipped to "multiple accounts per email," the same address would mint a second Firebase user the first time it signed in via magic link, breaking every UID-keyed assumption in the system. Future code must not branch on `firebase.auth().currentUser.providerData[0].providerId`.

**Deployment prerequisites** (must hold before T-44 ships):

- The Firebase Auth Authorized Domains list contains `stakebuildingaccess.org`, `kindoo.csnorth.org`, and `kindoo-prod.firebaseapp.com` (Console → Authentication → Settings → Authorized domains — separate from Hosting custom-domain config, see §12).
- The Firebase Auth user-account-linking setting is **"one account per email address"** (Console → Authentication → Settings → User account linking).
- The Email/Password provider is enabled at the Firebase Console level with the Email-link sub-toggle ON and the password sub-toggle OFF (Console → Authentication → Sign-in method).
- The Google provider remains enabled at the Firebase Console level (the Chrome extension depends on it).

**Out of scope.** Email/password (password sub-toggle stays off). Other OAuth providers (Apple, Microsoft, LDS Church Account). Self-service authorization or onboarding flows. Changes to the extension's Google-only auth path.

## 5. Page map

The SPA is built on TanStack Router with file-based routes under `apps/web/src/routes/`. Page components live under `apps/web/src/features/{feature}/pages/`. Navigation is the Phase-10.1 left-rail + sectioned-nav design (hamburger drawer on phone, icon-only rail on tablet, full rail on desktop); components live under `apps/web/src/components/layout/`. Spec in [`navigation-redesign.md`](navigation-redesign.md).

**Route gating.** Each route declares its role requirement; non-managers deep-linking to a manager page is currently inconsistently gated (T-31 — most manager routes rely on the nav not exposing them; only `/notifications` has an explicit redirect). Server-side enforcement is via Firestore rules regardless of client-side gating.

**Default landing rule.** Multi-role principals resolve via priority — manager > stake > bishopric — and land on the most-privileged role's default page.

### 5.0 Public pages

Two routes render without an auth gate; neither participates in role resolution or `gateDecision()`.

- **`/` (signed-out homepage)** — rendered by `apps/web/src/features/auth/SignInPage.tsx` whenever no Firebase Auth user is present. Audience is ward and stake leadership (bishopric, stake presidency, executive secretaries, clerks) — not Kindoo Managers, who are a downstream role. Layout: a sticky top bar (brand + secondary "Sign in" affordance), a centred hero (headline + sub-line + a "Continue with Google" primary button above the magic-link sign-in form: an email input + a "Send me a sign-in link" primary button), two short feature bullets (request access, auto-expiring temporary grants), a one-paragraph explainer, a short note that new sign-ins land in pending authorization until a stake manager adds the email (§4.1), and a footer linking to `/privacy`, the Chrome Web Store listing, and a contact `mailto:`. The topbar affordance scrolls / focuses the magic-link form. The Google CTA drives `signInWithPopup`; the magic-link form drives `sendSignInLinkToEmail()`. After a magic-link submit the form area swaps to a "Check your email" confirmation state. The action-handler route (the page the emailed link lands on) lives under the same app and runs `signInWithEmailLink()`; on success the SPA redirects to `/` and `gateDecision()` in `apps/web/src/routes/index.tsx` runs unchanged. Cross-device case is handled by re-prompting for the email when `localStorage` is empty (§4.1).
- **`/privacy`** — TanStack Router file route at `apps/web/src/routes/privacy.tsx`. Public; no auth gate; renders identically for reviewers, signed-out visitors, and signed-in users. Hosts the privacy policy for both the web app and the companion "Stake Building Access — Kindoo Helper" Chrome MV3 extension, and is the privacy URL declared on the Chrome Web Store listing. Sections cover: operator identity, what the extension does, data accessed and why, storage and processing (Firestore + Cloud Functions, US region), authentication via `chrome.identity` + Firebase, per-permission justifications for the extension's MV3 manifest, user rights, and a change log keyed on `LAST_UPDATED`. When the extension manifest changes (permissions, host_permissions, OAuth scopes) the corresponding section is updated in the same commit.

`/privacy` carries zero `[PLACEHOLDER]` tokens. The homepage's `CHROME_WEB_STORE_URL` points at the live Chrome Web Store listing for "Stake Building Access — Kindoo Helper" (extension ID `klkkpfdafbjebccodmgkogdklachelpb`). `CONTACT_MAILTO` is `mailto:support@stakebuildingaccess.org`.

### 5.1 Bishopric (scoped to own ward)

- **Roster** — active ward seats. All rows show calling + person (auto rows included). Manual/temp rows show reason; temp rows show dates. Each manual/temp row has a remove affordance; clicking opens "Remove access for [person]?" with a required reason field and submits a `remove` request via the shared submit flow. The row's remove control flips to a "removal pending" badge once submitted, so the requester cannot double-submit. Auto rows render no remove control — auto seats track Kindoo-side callings and are removed by Sync after the calling ends in Kindoo (which Church Access Automation populates from LCR). Utilization bar shows `current / cap`. Principals holding more than one bishopric role see a "Ward:" dropdown above the utilization bar; rules and the read-side query both validate the requested `wardCode` against the principal's claims so a bishopric for ward CO cannot read ward GE.
- **New Kindoo Request** — shared form (same page for bishopric and stake principals; scope is derived from the principal's claims, not the route). Form: `add_manual` / `add_temp`. Fields: request type, dates (only for `add_temp`, positioned directly under the type selector), member email (required, canonicalized at submit), member name (required for add types; not required for `remove`), reason (required), comment, urgent flag (Phase 10.3 — surfaces a red top-bar marker on the manager queue card), buildings (**at least one required regardless of scope** — enforced client-side via the form schema / disabled Submit button and rule-side on creation). Ward-scope submits default the ward's own `building_name` ticked when set; bishopric users may add or remove buildings the same as stake submitters. There is no "leave buildings blank and let the ward default fill in later" path — every `add_*` and `edit_*` request carries the buildings the requester chose. Client-side duplicate check warns when the member already has a seat in the selected scope; warns, does not block. Principals holding more than one request-capable role see a "Requesting for:" scope dropdown.
- **My Requests** — the current user's submitted requests with status; Cancel button on pending rows; rejection reason surfaced on rejected rows; completion note (when set) surfaced on complete rows. Multi-role principals see a scope filter dropdown.

### 5.2 Stake Presidency

Same three pages as Bishopric, scoped to the stake pool — uses the same shared form / list components. Plus:

- **Ward Rosters** — read-only dropdown to view any ward's roster.

### 5.3 Kindoo Manager

Every manager page renders against the **active stake** (§2.1). A manager who holds the role on two stakes sees the same five pages below in each stake's scope; the stake-switcher dropdown in the brand bar swaps which stake the queries target. Reads are scoped via `stakes/{activeStakeId}/...` in every collection path.

- **Dashboard** — manager default landing. Five cards: pending request counts grouped by type (deep-link to Requests Queue), recent activity (last 10 audit rows, deep-link to Audit Log filtered by `entity_id`), utilization per scope (one bar per ward + stake; colour-coded ok / warn ≥ 90% / over; deep-link to All Seats filtered by ward), warnings (over-cap pools from `stake.last_over_caps_json` with a deep-link per pool), and last operations (last expiry, triggers reinstall). The stake bar is home-site only — foreign-site wards do not contribute on either side of the calculation (§15, §244). Per-ward bars are unchanged regardless of site. Reads are per-card live subscriptions through the DIY Firestore hooks.
- **Requests Queue** — sectioned (Phase 10.3) into Urgent / Outstanding / Future by computed `comparison_date` (start_date for `add_temp`, requested_at otherwise) with a today+7 cutoff at user-local midnight. Each section heading shows the open-request count in parentheses, e.g., `Outstanding Requests (9)`. Sections with zero open requests are hidden. Filter by state (Pending / Complete) — the "Complete" view groups complete, rejected, and cancelled. Filter by ward and type. Pending sorts oldest-first (FIFO); Complete sorts newest-first. Pending cards render metadata + a duplicate-warning block when the member already has a seat in the scope, plus Mark Complete / Reject actions. **Mark Complete opens a confirmation dialog** with a Buildings checkbox group pre-ticked from the request's own `building_names` (every new request carries at least one — see §5.1 / §6). **At least one building must be ticked** — enforced both client-side and rule-side. The manager adjusts the selection if needed, clicks Confirm, and the resulting seat doc carries that `building_names` selection exactly. Self-approval policy: a manager who is also a bishopric/stake member may complete or reject requests they themselves submitted; the audit trail records both who submitted and who completed.
- **All Seats** — full roster across every scope; filter by scope/building/type. When the scope filter is "All" and `stake.stake_seat_cap` is set, a full-width "Seat utilization" bar renders between the filters and the per-scope summary cards (Phase 10.3 — contextual `<UtilizationBar>` follows the current scope filter). The "All" and Stake-scope bars are home-site only — foreign-site ward seats / caps are excluded from both sides (§15, §244). Per-ward bars are unchanged. Inline edit (Edit button on manual/temp rows only — auto rows are Sync-owned) of `member_name`, `reason`, `building_names`, plus `start_date` / `end_date` on temp rows. `scope`, `type`, `member_email`, and the canonical-email doc-ID are immutable; rules enforce.
- **Configuration** — edit Wards, Buildings, KindooManagers, Auto Ward Callings (Phase 10.4 — table view of `wardCallingTemplates` with three columns: Calling Name, Auto Kindoo Access, Can Request Access — the latter is the `give_app_access` field), Auto Stake Callings (same shape for `stakeCallingTemplates`), and the Config keys (`stake_seat_cap`, `expiry_hour`, `notifications_enabled`, etc.). Drag-to-reorder on the calling-template tables (mouse) / tap-and-hold + arrow buttons (touch) sets `sheet_order` for wildcard tie-breaking + roster sort priority.
- **App Access** — view over the `access/{canonical}` collection. Server-managed grants (`importer_callings`, written by Sync via `syncApplyFix`) are read-only; the manager cannot edit them because the next Sync run would just recreate them. Manual grants (`manual_grants`) have a themed Delete confirmation, and an "Add manual access" modal lets the manager grant app access to someone whose calling isn't in a template. On desktop the page renders a table; at narrow viewports it swaps to a card stack. The card view sorts by the doc-level `sort_order` (Phase 10.4); the table view's per-row sort is T-29 (open).
- **Audit Log** — filterable view over the `auditLog` subcollection (Phase 8 / Phase 10.3). Cursor-paginated against Firestore; max 100 rows per page. Filters combine as AND: `actor_canonical` (canonical-email compare; literal match against `"ExpiryTrigger"` and the legacy `"Importer"` value for pre-removal rows), `action` (exact match from the `firebase-schema.md` §4.10 enum), `entity_type` (enum), `entity_id` (exact, case-sensitive), `member_canonical` (cross-collection per-user view), `date_from` / `date_to` (ISO dates, inclusive on both ends in stake timezone). Default window when neither date is supplied is the last 7 days. Deep-linkable via search params. Per-row rendering: a coloured action badge, a one-line summary (with `complete_request.completion_note` surfaced inline for the R-1 no-op case), and a `<details>` block that expands to a Field / Before / After diff table sourced from `computeFieldDiff(before, after)` (T-21).
- **Notifications** (under Account) — push-subscription panel. Five render branches keyed by device state (`push-unsupported`, `push-requires-install`, `push-vapid-missing`, `push-denied`, `push-enable-button`, `push-subscribed-with-toggle`). Per-device subscription via stable `crypto.randomUUID()` persisted in localStorage; subscribe writes the deviceId-keyed token slot to `userIndex/{canonical}.fcmTokens`. Disable on one device leaves other devices' tokens intact. Manager-only for now; the route gate widens for bishopric/stake users in Phase 10.6 (deferred).

### 5.4 Platform Superadmin

Visible iff `principal.isPlatformSuperadmin === true`. A new "Super Admin" section in the app shell's nav (see `navigation-redesign.md` §8) carries one entry:

- **Stake List** (`/superadmin/stakes`) — lists every stake in the platform: `stake_name`, doc ID slug, `created_at`, `setup_complete` flag, and a deep-link to each stake's normal landing page (e.g. the manager Dashboard scoped to that stake). A **Create Stake** button in the page header opens a modal dialog containing the create form, which takes `stake_name`, `bootstrap_admin_email`, and an optional IANA timezone (defaults to `'America/Denver'`; the field uses the shared `TimezoneCombobox` in `apps/web/src/components/`, constrained to the curated US-IANA list in `usTimezones.ts`). The modal closes on successful submit (the new row arrives via the live stakes subscription), on Cancel, on Escape, or on backdrop click; re-opening it after a successful create yields an empty form. Submit calls the `createStake` Cloud Function callable (superadmin-gated server-side; the web-side render gate is defense-in-depth), which slugs the stake name into a doc ID, validates collision, lowercases the bootstrap email while preserving dots and `+suffix` (NOT `canonicalEmail()` — see F19 / `firebase-schema.md` §4.1: `isBootstrapAdmin` compares against `request.auth.token.email`, which Firebase Auth always emits lowercased, while Gmail-dot / `+suffix` aliases must survive to keep that escape hatch usable), writes the `stakes/{slug}` parent doc with `setup_complete=false`, and emits a `platformAuditLog` `create_stake` row. An inline hint under the email field (`"Lowercased on save to match the user's Google sign-in address."`) tells the operator the case-normalization will happen — without it, the resulting list row would silently show different casing than what they typed. The named bootstrap admin must then sign in for the bootstrap wizard (§10) to run — superadmin's only act is creating the parent doc.

  The callable's failure envelope mirrors `syncApplyFix`: auth + shape errors throw `HttpsError`; domain misses return `{success:false, error}` so the form maps each code to an inline field error. Soft-fail codes: `name_required`, `email_required`, `invalid_email` (basic shape regex — missing `@`, missing TLD, embedded whitespace), `slug_collision`, `invalid_slug` (slug derivation collapsed to empty), `invalid_timezone` (the value fails an `Intl.DateTimeFormat` round-trip). The web form pre-empts `invalid_email` with zod `.email()` client-side and pre-empts `invalid_timezone` by constraining the user to the curated US-IANA list; the server checks are defense-in-depth for non-SDK callers (extension clients, direct REST POSTs).

The `platformSuperadmins/{canonical}` allow-list itself is **not** managed from the web. Adding or removing a superadmin is a Firestore console write; the `syncSuperadminClaims` trigger picks up the write and mints / revokes the `isPlatformSuperadmin: true` claim. No in-app UI exists for it.

## 6. Request lifecycle

State machine (pending is the only admissible starting state; each terminal state is a one-way flip):

```
              submit
                |
                v
             pending
              / | \
    complete /  |  \ cancel
            /   |   \
           v    v    v
      complete rejected cancelled
```

1. **Submit.** Requester writes a doc to `stakes/{stakeId}/requests/{rid}` with `status='pending'`, `requester_canonical = authedCanonical()`, `requested_at = serverTimestamp()`, and a `lastActor` matching the auth token. Rules enforce: scope is one the requester can submit for (stake-scope iff stake-member; ward-scope iff bishopric for that ward), member_name is non-empty for add types, `building_names` is non-empty for every `add_*` and `edit_*` type regardless of scope, `urgent` is a boolean. The `auditTrigger` Cloud Function fans an `auditLog` row. The `notifyOnRequestWrite` trigger fires the new-request email to active managers. `pushOnRequestSubmit` fans push notifications to active managers' subscribed devices.
2. **Manager action.**
   - **Mark Complete** flips `status='complete'` and writes the matching `seats/{canonical}` doc atomically. Add types: client transaction creates the seat with `granted_by_request = requestId` and the chosen `building_names`. Remove type: the `removeSeatOnRequestComplete` trigger handles the seat deletion via Admin SDK (rules cannot read `request.resource.data` on a delete). Two audit rows fan in (one for the request flip, one for the seat write/delete). The `notifyRequesterCompleted` trigger emails the requester.
   - **Reject** flips `status='rejected'` with a non-empty `rejection_reason`. One audit row; `notifyRequesterRejected` emails the requester.
3. **Cancel.** Only the original requester may cancel a `pending` request (`request.auth.token.canonical == resource.data.requester_canonical`). Flips `status='cancelled'`. One audit row; `notifyManagersCancelled` emails active managers.

Attempting to complete / reject / cancel a non-pending request is rejected by rules (the `update` predicate requires `resource.data.status == 'pending'`). The client surfaces the rejection as a clean error toast.

Remove-requests follow the same lifecycle; the `complete` action triggers `removeSeatOnRequestComplete` to delete the matching `seats/{canonical}` doc instead of inserting one. Two extra rules apply only to remove:

- **R-1 race (seat already gone at completion time).** If the seat is missing when the trigger fires (a duplicate remove already ran, or the daily expiry trigger removed a temp seat between submit and complete), the request still flips to `complete`. A `completion_note = "Seat already removed at completion time (no-op)."` is stamped on the request. Only ONE audit row is fanned (`complete_request` on the request — there is no seat to delete). The completion email body surfaces the note (`Note: ...`) so the requester is not confused that nothing visibly changed.
- **Submit-time guards.** A remove submit is rejected by client transaction (rules cannot do a presence check at create time without a `getAfter` against a non-existent doc) if no active manual/temp seat exists for `(scope, member_canonical)`, or if another `pending` remove request for the same `(scope, member_canonical)` is already open. The UI also gates: the remove control is only rendered on manual/temp rows and is disabled when `removal_pending` is set.

### 6.1 Edit-seat requests

In addition to `add_manual`, `add_temp`, and `remove`, managers can mutate an existing seat in place through three edit request types. All three flow through the same Pending Queue → Mark Complete pipeline as the existing add/remove types: requester submits a `pending` request; manager hits Mark Complete; the `markRequestComplete` callable resolves the seat slot and writes the field replacements in the same transaction. The `auditTrigger` fans audit rows on the request flip and the seat update automatically — no new audit semantics.

| Seat type / scope | Edit allowed? | Editable fields |
| --- | --- | --- |
| **Auto, stake scope** | **No.** Church-granted access to all stake buildings; nothing to remove or constrain. Three-layer defense (see below). | — |
| **Auto, ward scope** | Yes (`edit_auto`) | `building_names` only (all currently-granted buildings pre-checked + disabled — additions only, per Policy B). |
| **Manual (any scope)** | Yes (`edit_manual`) | `reason` (= the calling name for manual seats) and `building_names`. `seat.callings` is **not** touched (manual seats carry `callings: []` by convention). |
| **Temp (any scope)** | Yes (`edit_temp`) | `reason`, `building_names`, `start_date`, `end_date`. |

**Who can submit.** Same `allowedScopesFor(seat.scope)` gate as `remove`: a bishopric for that ward can submit ward-scope edits; stake-scope members can submit stake-scope edits. Manager status alone does not grant submit rights (B-3 / T-36) — the role-for-scope rule applies.

**Policy 1 — stake auto seats are non-editable.** Three layers of defense:

1. **Web UI** hides the Edit button on stake auto rows (All Seats / Roster).
2. **Firestore rule** rejects creation of an `edit_auto` request when `scope == 'stake'` — see `firestore/firestore.rules` §requests.create.
3. **`markRequestComplete` callable** rejects `edit_auto` completion when `scope === 'stake'` with `permission-denied` — see `functions/src/callable/markRequestComplete.ts`.

**Policy B — `edit_auto` building selection.** The auto-primary's current `building_names` (the importer's seed plus any prior `edit_auto`-added extras) are pre-checked AND disabled in the edit modal. Operator can ADD other ward-site buildings beyond them; cannot REMOVE any currently-granted building (the constraint exists because the `edit_auto` callable path REPLACES the auto-primary's `building_names` with the request body — silently dropping a previously-added building would be a destructive edit). The dialog distinguishes two related sets:

- **Visual lock** (`lockedBuildings` in `EditSeatDialog`): the union of the auto-primary's `building_names` and any same-scope non-auto DuplicateGrant's `building_names` (manual or temp). This mirrors what the collapsed AllSeats / roster row displays (PR #166's same-scope collapse) so the user sees the same building set on both surfaces; every locked checkbox carries a tooltip explaining why it cannot be unchecked. Locking the full union is the honest UX — the `edit_auto` request type cannot touch DuplicateGrants, so allowing the operator to uncheck a dup building would no-op silently.
- **Submit-included set** (`autoOwnedBuildings` in `EditSeatDialog`): ONLY the auto-primary's current `building_names`. The wire body is `autoOwnedBuildings ∪ operator-additions`; same-scope DuplicateGrant buildings are deliberately excluded from the submit. The `markRequestComplete` callable's `planEditSeat` for `edit_auto` replaces the auto-primary's `building_names` and does not visit the duplicate-grants array, so absorbing dup buildings into the wire body would double-credit the user on display (still in the dup) and double-provision on Kindoo (now also on the auto-primary's set).

Future work could decompose the submit into multi-request coordination (`edit_auto` plus `edit_manual` / `edit_temp` / `remove` for the dup) so the operator can prune dup buildings from the same modal; until that lands, the conservative lock keeps the data clean. The constraint on the auto-primary's own buildings is resolved from `seat.building_names`; `wardCallingTemplates` has no per-template building list. Stake-scope auto seats never reach this modal (Policy 1).

**`edit_manual` reason semantics.** Manual seats store the operator-typed calling name in `seat.reason` (not `seat.callings`, which stays `[]`). The `edit_manual` request's `reason` field replaces `seat.reason` verbatim. `seat.callings` is left untouched.

**Comment required on edit requests.** All `edit_*` requests require a non-empty `comment` field at creation time. Enforced by (a) the shared `accessRequestSchema` zod refinement (trimmed non-empty) for any parse-side consumer, (b) the Firestore rule predicate on creation (non-empty string), (c) the web form (`EditSeatDialog`) blocks submit with an inline error when the comment is empty or whitespace-only. The rule predicate is intentionally looser than the schema (Firestore rule expressions have no string-trim primitive), so a hand-crafted REST POST with whitespace-only `comment` would pass the rule even though the SDK / form layer rejects it; the SPA's submit path trims before write, so this gap is reachable only by non-SDK clients. Add and remove requests are unaffected — their existing comment behavior is preserved (optional at the wire boundary; the cross-ward-add comment-required rule lives in the web form schema, not the wire schema).

**Slot resolution** (in `planEditSeat`, `functions/src/callable/markRequestComplete.ts`): primary `(scope, type)` match wins; otherwise walk `seat.duplicate_grants[]` for the first `(scope, type)` match. If neither matches, the callable throws `failed-precondition` (no editable slot found). Edits never change scope/type, so per-pool counts are unchanged — the callable skips the over-cap recompute (responsibility split with `removeSeatOnRequestComplete`).

**Edit badge in the Pending Queue.** Edit requests render with a distinct "Edit (auto)" / "Edit (manual)" / "Edit (temp)" type badge so managers can disambiguate them at a glance against add/remove.

**Audit trail.** `markRequestComplete` stamps the manager's email on both the request flip (`lastActor`, `completer_*`) and the seat update (`lastActor`, `last_modified_by`). The `auditTrigger` fans one row per write, same as add/remove. No new audit `action` values needed (existing `update_seat` and `complete_request` cover edits).

**Extension Provision flow — direct-grant awareness.** Before writing AccessSchedules to Kindoo, the extension orchestrator (`provisionAddOrChange` and `provisionEdit` in `extension/src/content/kindoo/provision.ts`) consults the user's actual door grants (via `KindooGetUserAccessRulesLightWithTotalNumberOfRecordsWithEntryPoints`) and the per-rule door sets (via `KindooGetEnvRuleWithEntryPointsFormatted`). Any AccessRule whose door set is fully covered by the user's existing direct door grants (typically Church Access Automation's auto-grants) is skipped — the extension does not write a redundant AccessSchedule for a building the user already has access to via direct door grants. This avoids the duplicate-rule pollution scenario where MERGE semantics on `saveAccessRule` would otherwise create a parallel AccessSchedule for the same building. The strict-subset chain lives in `extension/src/content/kindoo/sync/buildingsFromDoors.ts` (also used by the Sync drift report). On derivation failure (transient Kindoo error during the rule-door / user-door reads) the orchestrator logs a `[sba-ext]` warning and falls back to the legacy `targetRids - currentSchedules` diff — the provision still completes; in the worst case a redundant rule is written rather than blocking the operator.

## 7. Temporary-seat expiry

The `runExpiry` Cloud Function (Phase 8) is invoked hourly by Cloud Scheduler and iterates over stakes whose `expiry_hour` matches the current local hour in their `timezone` (default `America/Denver`, set on the stake doc). For each matching stake it queries `stakes/{stakeId}/seats` for `type='temp' AND end_date < today` (today computed in the stake's timezone), deletes each matching seat doc, and writes per-row audit rows (`auto_expire`, `actor_email='ExpiryTrigger'`). The default `expiry_hour` is `3` (i.e. 03:00 stake-local).

Boundary: a seat with `end_date='2026-04-21'` is alive on 2026-04-21 (`end_date < today` is false) and disappears on the 2026-04-22 03:00 run. No email is sent on auto-expire — the audit row is the trail.

`stake.last_expiry_at` and `stake.last_expiry_summary` are written at the end of every run (including zero-row runs), feeding the manager Dashboard's "Last Operations" card.

## 8. Auto-seat ingestion

Auto seats, calling-change detection, and calling-end removal flow through the companion Chrome extension's Sync feature (see §15 Phase 4 for the active-site resolution and per-site scoping rules; classifier and fix-path live in `extension/src/content/kindoo/sync/`). Sync reads the operator's live Kindoo session — which Kindoo already populates from LCR via Church Access Automation — classifies each Kindoo user's Description against `wardCallingTemplates` / `stakeCallingTemplates`, and applies the resulting fixes through the `syncApplyFix` callable. There is no separate weekly LCR Sheet importer. `wardCallingTemplates` and `stakeCallingTemplates` remain — the classifier matches against them, and `sheet_order` continues to feed roster sort priority.

**Cap interaction.** The over-cap calc lives in `functions/src/lib/overCaps.ts`; today's call sites are `markRequestComplete` and `removeSeatOnRequestComplete`. After the importer's removal, **`syncApplyFix` and the daily expiry trigger do NOT recompute over-caps** — Sync-driven auto-seat additions / removals and expiry-driven temp-seat releases both leave `stake.last_over_caps_json` unchanged until the next request completion picks up the new seat count. For each ward with `seat_cap > 0` an over-cap is flagged when the count exceeds the cap. For the stake an over-cap fires when the **home stake portion-cap** (`stake_seat_cap - sum(home-site ward seats)`) is exceeded by stake-scope seats. Foreign-site ward seats (§15) are excluded from both sides of the home-stake calculation — they come out of a different Kindoo site's pool, not the home stake's — but each foreign-site ward's own over-cap fires normally against its own `seat_cap`. The result array is persisted to `stake.last_over_caps_json`; when it transitions empty → non-empty, `notifyOnOverCap` emails active managers (Phase 9). No audit row is written by the recompute — the importer-era `over_cap_warning` row is preserved on pre-T-45 audit history for filtering, but no new writes produce it; the SPA reads `last_over_caps_json` directly. Accepted regression at v1 scale (12 wards, ~250 seats, 1–2 requests/week — the next request completion catches up within days). Wiring `computeOverCaps` into `syncApplyFix` or the expiry trigger is a follow-up if the lag becomes visible in practice.

**Cadence.** Sync runs on-demand, when the operator opens the extension's Sync panel on Kindoo and triggers a run. No scheduled cadence. The system-clock interval between LCR-side changes and SBA-side auto-seat existence is therefore bounded only by how often the operator runs Sync, not by a server-side schedule. Accepted at v1 scale (csnorth, ~250 seats, 1–2 requests/week). If the lag becomes operationally visible the next-step fix is either a scheduled Sync trigger or a Cloud Function that polls Kindoo on the same cadence the old importer ran.

**Bishopric lag.** New bishopric members can't sign into the app until Sync runs against the latest Kindoo data (which itself reflects Church Access Automation's LCR pull). Lag is unbounded by clock; bounded only by Sync-run cadence (see "Cadence" above).

## 9. Email notifications

Five notification types ship via Resend (Phase 9), fired by Firestore triggers on the relevant entity changes.

| Trigger | Recipients | Subject | Link back |
| --- | --- | --- | --- |
| Request submitted | active Kindoo Managers | `[Kindoo Access] New request from <requester> (<scope label>)` | `<WEB_BASE_URL>/manager/queue` |
| Request completed | original requester | `[Kindoo Access] Your request for <member_email> has been completed` | `<WEB_BASE_URL>/my` |
| Request rejected | original requester | `[Kindoo Access] Your request was rejected` | `<WEB_BASE_URL>/my` |
| Request cancelled | active Kindoo Managers | `[Kindoo Access] Request cancelled by <requester>` | `<WEB_BASE_URL>/manager/queue` |
| Over-cap detected | active Kindoo Managers | `[Kindoo Access] Over-cap warning` | `<WEB_BASE_URL>/manager/seats` |

Bodies are plain text; every email includes a link back to the relevant page (`WEB_BASE_URL` is set per project via `functions/.env.<project>`). The R-1 completion email surfaces a `Note:` line carrying `request.completion_note` so the requester knows nothing visibly changed. The over-cap email lists every flagged pool with its current count / cap and a deep-link to the filtered All Seats page.

**From address.** Fixed envelope `noreply@mail.stakebuildingaccess.org` (verified Resend subdomain per F17 / T-04). Display name interpolates the stake name: `<stake.stake_name> — Stake Building Access <noreply@mail.stakebuildingaccess.org>`. Optional `Reply-To` from `stake.notifications_reply_to` when set; otherwise the header is omitted (replies bounce off `noreply@`).

**Best-effort discipline.** Every notification trigger catches Resend errors, writes one `email_send_failed` audit row via Admin SDK with a deterministic `auditId(writeTime, suffix)`, logs, and returns. The underlying entity-write trigger never re-throws on a mail failure — the Sheet write is atomic, the email is best-effort. See [`architecture.md`](architecture.md) §9.5 (preserved verbatim from the legacy doc) for the full rationale on why the email lives outside the lock.

**Email kill-switch.** `stake.notifications_enabled` (boolean; default `true`) gates every Resend send. Flipping it to `false` short-circuits before the API call; one log line emitted. Editable from the manager Configuration page.

**Push notifications** (Phase 10.5) ship the new-request notification only. Independent kill-switch per user per device per category at `userIndex/{canonical}.notificationPrefs.push`. The remaining four notification categories (completion / rejection / cancel / over-cap) on push are Phase 10.6, deferred.

## 10. Bootstrap flow

`stake.bootstrap_admin_email` (lowercased on save by the `createStake` callable; dots and `+suffix` preserved — see `firebase-schema.md` §4.1) is seeded by the operator at stake creation, alongside `setup_complete=false`. Until `setup_complete` flips to `true`, every page load first routes through the **setup-complete gate** in `apps/web` (runs **before** role resolution):

- If the signed-in email matches `bootstrap_admin_email` (plain string compare against `auth.token.email`, which Firebase Auth always emits lowercased) and `setup_complete === false` → render the bootstrap wizard, ignoring deep-link route params.
- If `setup_complete === false` and the email does NOT match → render a "Setup in progress" page (distinct from "Not authorized" — the user isn't unauthorised, the app isn't ready).
- If `setup_complete === true` → normal role resolution.

The wizard is multi-step and writes directly into the live collections (`stakes/{stakeId}` parent doc, `buildings/`, `wards/`, `kindooManagers/`). Each step persists immediately, so closing and reopening mid-setup resumes where the data says it should. Rules carve out a bootstrap-admin escape hatch (`firebase-schema.md` §6.1) — the predicate `isBootstrapAdmin(stakeId)` is OR'd into the read+write rules of the four wizard-managed collections, gated on `stake.setup_complete === false`. Once the wizard's final write flips `setup_complete=true`, the predicate goes silent and the manager claim (already minted by `syncManagersClaims` after the auto-add) takes over.

Steps:

1. Stake name, stake seat cap (writes to `stakes/{stakeId}` parent doc).
2. At least one Building (writes to `buildings/`).
3. At least one Ward with `ward_code`, `ward_name`, `building_name` slug, `seat_cap` (writes to `wards/`).
4. Additional Kindoo Managers (optional; writes to `kindooManagers/`). The bootstrap admin is **auto-added** as an active manager on first wizard load (one-shot idempotent write keyed on canonical email) — they cannot delete themselves and won't be locked out after setup.

**Complete Setup** (enabled when steps 1-3 are complete) flips `stake.setup_complete=true`, calls `installScheduledJobs` (the expiry Scheduler job), writes a `setup_complete` audit row, and redirects the admin to the manager default page. `installScheduledJobs` is a callable function pinned to `kindoo-app@`; idempotently creates / updates Cloud Scheduler jobs for this stake.

**One-shot wizard.** The bootstrap-admin gate's `setup_complete === false` clause is what makes this strictly time-bounded. Post-setup edits go through the normal manager Configuration page.

**Operator pre-step.** The stake doc must exist with `setup_complete=false` and `bootstrap_admin_email=<lowercased email>` BEFORE the bootstrap admin signs in. The `createStake` callable handles the lowercase transform; any out-of-band seed path (direct-console write, future CLI) must do the same — see `firebase-schema.md` §4.1 for the rationale. The gate's `get()` short-circuits if the stake doc is missing — operator seed is mandatory. See `infra/runbooks/provision-firebase-projects.md`.

## 11. Concurrency

All multi-doc writes wrap in `db.runTransaction(...)` (Cloud Functions side, Admin SDK) or `runTransaction` from the Firestore JS SDK (client side). Firestore's optimistic-concurrency model handles contention — a transaction that observes a write race retries up to its internal limit before throwing. The client surfaces the throw as a clean error toast.

Reads do not need any lock. Live `onSnapshot` subscriptions on shared-attention pages (Queue, Roster, MyRequests, Dashboard, Audit Log) refresh automatically as state changes; request-response queries (filtered All Seats, etc.) re-run on filter changes.

Audit log writes are server-only and fan in via the `auditTrigger` Cloud Function (F8). The trigger uses a deterministic `auditId(writeTime, suffix)` so retries collapse onto one row. Eventually consistent (~<1s); the nightly `reconcileAuditGaps` job (deferred wiring; mocked in v1) is the safety net.

## 12. Custom domain

Firebase Hosting on `kindoo-prod` serves the SPA at two hostnames:

- **`stakebuildingaccess.org`** — the F17 brand apex. DNS pointed at Firebase Hosting 2026-05-13.
- **`kindoo.csnorth.org`** — the legacy hostname, retained for backwards compatibility. DNS flipped 2026-05-03 at Phase 11 cutover.

Both have auto-provisioned Let's Encrypt certs via the Firebase Hosting console. Procedure documented in `infra/runbooks/custom-domain.md`. Dual-hosting is the chosen final state — no redirect from the legacy hostname to the brand apex, no takedown. Both URLs remain addressable indefinitely.

The pre-cutover setup on `kindoo.csnorth.org` (a static GitHub Pages page wrapping the Apps Script `/exec` URL in a full-viewport iframe) was bypassed at the Phase 11 cutover and the GitHub Pages workflow + `website/` directory were retired in the post-cutover cleanup (PRs #78 and the 2026-05-11 cleanup PR).

The Resend `mail.stakebuildingaccess.org` subdomain is verified and in active use for the email envelope.

## 13. Out of scope for v1

- Per-stake "From" address or verified email subdomain (the Phase A shared envelope continues under Phase 12) — see `firebase-migration.md` Phase 12 "Out of scope".
- Web UI for `platformSuperadmins` management — console-only by operator decision (`firebase-migration.md` Phase 12 / `firebase-schema.md` §3.2).
- Kindoo API integration (they don't have one).
- Native mobile app (the PWA is enough; installable on iOS, Android, desktop).
- Building permissions UI on bishopric requests (the `building_names` defaulting + manager pre-tick on the complete dialog covers it; the comment field handles exceptions).
- Per-stake tz handling beyond `America/Denver` for v1 (each stake doc carries `timezone` but only one value is in use).
- Push notifications for completion / rejection / cancel / over-cap — Phase 10.6 (deferred).

## 14. Build history

The Apps Script implementation shipped in 11 chunks (chunks 1-11 in `docs/changelog/chunk-N-*.md`). The Firebase migration shipped in phases 1-11 plus four interleaved sub-phases (10.2 / 10.3 / 10.4 / 10.5); see `docs/changelog/phase-N-*.md`. Phase 11 cutover (2026-05-03) closed Phase A. Phase 12 (multi-stake) was promoted from deferred to active on 2026-05-18 and ships as five sub-deliverables (12.1 → 12.5); see `docs/firebase-migration.md` Phase 12.

## 15. Kindoo Sites (multi-site Kindoo management)

The operator manages a single SBA stake (`csnorth`) but is a Kindoo Manager on multiple Kindoo sites — two wards in csnorth live in buildings whose access doors are physically governed by a different stake's Kindoo environment than the SBA stake's own home site. "Kindoo Sites" tracks those N Kindoo environments the operator's managers can write to (home + 0..N foreign), so the SPA, the companion Chrome extension, and the weekly sync can route Kindoo-side operations to the correct environment without misprovisioning.

This is **not** multi-stake on the SBA side. Kindoo Sites is local per stake — the existing `kindooManagers` allow-list governs all Kindoo writes regardless of which Kindoo site they target, and Kindoo Sites does NOT introduce a new role or principal shape. **Phase 12 (multi-stake) interaction.** The data layer is unaffected: each stake's `kindooSites/{kindooSiteId}` sub-collection is local to that stake, and a foreign Kindoo site configured under stake A is not visible from stake B. The extension's multi-stake behaviour is described in the next paragraph; the rest of the Kindoo-Sites spec assumes a single stake context resolved by it.

**Extension EID-to-stake resolution (Phase 12.5).** When the slide-over panel mounts on a Kindoo session, the extension's service worker reads the operator's `managerStakes` off their auth-token claims and queries each managed stake's parent doc + `kindooSites/*` to find every stake that has the active session's EID configured (`stake.kindoo_config.site_id === eid` for home, or some `kindooSites/<id>.kindoo_eid === eid` for foreign). The candidate set drives the panel's behaviour:

- **Zero candidates.** Recovery copy: "This Kindoo site (EID N) is not configured under any SBA stake you manage." No picker; no panel content beyond the error + retry.
- **Single candidate.** Auto-resolved — the panel proceeds straight into the tabbed shell against that stake. No storage write (the resolution is structural, not a remembered choice).
- **Multiple candidates (rare; reachable when a foreign-site grant from stake A and a home grant from stake B both target the same Kindoo environment).** The slide-over surfaces a full-takeover stake picker listing each candidate by `stake_name` with a home / foreign hint. The operator's click persists the choice to `chrome.storage.local` under a single canonical key `sba.eidStakeChoice` shaped as `Record<eidString, stakeId>`. Subsequent panel mounts against the same EID short-circuit straight to the resolved stake.

**Partial-failure banner.** When the EID resolver succeeds on a subset of managed stakes but at least one per-stake read caught (rules denial, Firestore hiccup), the panel renders a non-modal warning banner ("Couldn't read N of your stakes — partial results shown") above the picker or auto-picked view with a Retry button. The auto-pick behaviour for a single surviving candidate is preserved (the picker is NOT forced open on partial failure); the banner is the operator's signal that they may be working in the wrong queue.

**Stale-choice invalidation.** Every panel mount re-runs the EID resolver and validates any stored choice against the live candidate set. If the stored stake is no longer a candidate (manager role revoked between sessions, or the EID was un-configured from that stake's `kindooSites/`), the stored entry is dropped and the picker re-asserts. The whole `sba.eidStakeChoice` map is wiped on sign-out alongside the principal snapshot and the cached Google access token.

**Storage scope.** `chrome.storage.local` only (not `sync`), so the choice does not propagate across the operator's Chrome profiles. The single-key-per-map shape keeps sign-out cleanup atomic. Shared-laptop scenarios (two operators on the same Chrome profile) inherit each other's choices between sign-ins; sign-out's wipe covers the practical case.

All extension callables (`getMyPendingRequests`, `markRequestComplete`, `syncApplyFix`) and Firestore reads / writes propagate the resolved `stakeId`. There is no single-stake constant in the extension. See `firebase-migration.md` Phase 12 sub-deliverable 12.5 + `docs/changelog/phase-12.5-extension-stake-mapping.md`.

### Data model

- **Home site is implicit.** It lives on the parent stake doc (`stake.kindoo_config.site_id` / `kindoo_config.site_name`, plus the optional `kindoo_expected_site_name` override). There is no `KindooSite` document representing the home site.
- **Foreign sites live as documents** under `stakes/{stakeId}/kindooSites/{kindooSiteId}`. The doc ID is a manager-chosen slug. See [`firebase-schema.md`](firebase-schema.md) §4.11. The Kindoo environment ID (`kindoo_eid`) is NOT a manager-supplied field — the extension discovers it via the active-site DOM-scrape resolver (`readActiveEidFromDom` in the extension's `content/kindoo/auth.ts`) and writes it on first use (Phase 3). The Configuration UI captures only the display name and the Kindoo site-name string.
- **Each `Ward` and `Building`** carries an optional `kindoo_site_id: string | null`. `null` (or field absent) means the home site; a string value points at a doc ID under `stakes/{stakeId}/kindooSites/`. Wards and buildings carry the field independently — a foreign-site building hosts foreign-site wards, and the building's value is the load-bearing one for door access, while the ward's value flags Kindoo-side roster placement.

### Home-stake utilization

Foreign-site wards (those with `kindoo_site_id !== null`) do not contribute to home-stake utilization on either side of the calculation. Their `seat_cap` is excluded from the home stake portion-cap, and their seats are excluded from home-stake used counts. Per-ward over-cap and per-ward utilization are unaffected — each ward's bar reflects what its own Kindoo site allotted it. See §244 for the cap-interaction rule and §135 / §137 for the manager surfaces that render the home-stake bars.

### Phase plan

Kindoo Sites lands in five phases. **Phase 1 ships the data model + the Configuration UI only — no behavioural changes elsewhere.** Defaults treat everything as home site (`kindoo_site_id: null` on every existing ward and building). No backfill is required.

- **Phase 1 (data model + Configuration UI).** Shipped. Adds the `kindooSites` collection, the `kindoo_site_id` field on `wards` / `buildings`, security rules, and a Configure-tab UI for managers to add / edit foreign sites and assign them to wards / buildings.
- **Phase 2 (form filtering + roster labels).** Shipped. Both the New Request form and the Edit Seat dialog filter their building checklists to the current scope's Kindoo site — stake-scope shows home-site buildings only (per operator decision 2 below), ward-scope shows the buildings whose `kindoo_site_id` matches the ward's own `kindoo_site_id`. Pre-checked buildings outside the visible set (legacy data where `ward.building_name` and `ward.kindoo_site_id` disagree, or seat building_names left over from a prior site assignment) are dropped silently from the form's defaults so the user can only check / uncheck what they can see; the form's submit is gated on at least one visible building remaining checked. Legacy buildings / wards without the field are treated as home. When the site filter narrows the catalogue to zero (e.g. a foreign-site ward whose foreign building has not yet been configured) both surfaces render an explicit empty-state directing the manager to Configuration rather than presenting an empty checklist. Roster pages (bishopric roster, stake ward rosters, manager All Seats) render a small foreign-site badge alongside each ward seat whose ward sits on a non-home Kindoo site; home and stake-scope seats carry no badge.
- **Phase 3 (extension orchestrator enforcement).** Shipped. The companion Chrome extension's Provision & Complete flow validates that the active Kindoo session's EID matches the request's target site (`stake.kindoo_config.site_id` for stake-scope and home-ward requests; `kindooSites/<id>.kindoo_eid` for foreign-ward requests) before writing to Kindoo. On mismatch the extension refuses with the explicit error `"This request needs to be provisioned on '<expected site name>'. Switch Kindoo sites and try again."` — no silent fallback. Foreign-site docs whose `kindoo_eid` hasn't been recorded yet get auto-populated on the first provision against a session whose site name matches the doc's `kindoo_expected_site_name`; the EID write completes before any Kindoo write fires. Auto-populate additionally refuses when the active session's EID equals the home `kindoo_config.site_id` — even on a name match — so a foreign doc whose `kindoo_expected_site_name` collides with the home name (typo, blank-then-copy, Kindoo-side rename) can never trap HOME_EID on the foreign doc and silently bypass the guard. The operator must be inside a specific Kindoo site (not the "My Sites" listing page) for the extension to identify the active site.
- **Phase 4 (sync filtering).** Shipped. The Sync feature scopes its diff to the Kindoo site the operator's active session is pointed at, so a home-site session does not flag foreign-site grants as drift (and vice versa). The active site's EID is recovered by DOM-scrape: `readActiveEidFromDom` (in the extension's `content/kindoo/auth.ts`) matches the visible Kindoo header text (rendered as `[dir="auto"]`) against the `EnvironmentName` values in `localStorage.state.sites.entities`, and returns the matched EID iff exactly one entity name is visible. `localStorage` itself does NOT carry the active-site signal — `state.sites.ids[0]` is the access-list head (not the active site), `user.object.EnvironmentID` is always `null`, and there is no URL or DOM-data-attribute discriminator. Kindoo tracks the active site only in React in-memory state; the rendered header is the only observable surface. The resolved EID is then classified against `stake.kindoo_config.site_id` (home) and each `KindooSite.kindoo_eid` (foreign). On `home`, only seats whose `ward.kindoo_site_id` is null / absent (plus stake-scope seats) and Kindoo users whose Description resolves to those wards or the stake are compared; on `foreign(siteId)`, only seats / users whose ward's `kindoo_site_id === siteId` are compared (stake-scope seats are excluded — home-only per the Phase 1 policy). The rule-fetch + door-grant enrichment also restrict to buildings owned by the active site, so foreign rule_ids are never issued against the home EID (or vice-versa) — that mis-targeting was the original `HTTP 303 ObjectNotFound` regression for multi-site managers. When the active site can't be identified (the listing page is open, the operator hasn't picked a site yet, or a Kindoo redesign broke the scrape selector), the panel surfaces the `no-eid` recovery state directing the operator to open a specific Kindoo site and retry. When the live EID matches neither home nor any configured `KindooSite`, the panel suppresses the report and surfaces an empty-state recovery message directing the operator to Configuration → Kindoo Sites (or to switch to a known site). The operator must be inside a specific Kindoo site (not the "My Sites" listing page) for the extension to identify the active site.
- **Phase 5 (re-runnable configure wizard, per active Kindoo site).** Shipped. The extension's configure wizard detects the active Kindoo session's site (via the same resolution `siteCheck.ts` uses for the Phase 3 orchestrator entry guard) and scopes rule-mapping to that site's buildings only. Home active → home buildings + `stake.kindoo_config` write; foreign active → only that foreign site's buildings + `kindooSites/<id>.kindoo_eid` auto-populate (on first encounter) + per-building `kindoo_rule` writes. The wizard never overwrites `stake.kindoo_config` on a foreign run. The wizard's home-by-name resolution refuses when the active session's EID matches a known foreign `kindoo_eid`, or when the active name is ambiguous between home and a foreign site — preventing the symmetric FOREIGN_EID → home-doc leak. Active Kindoo session whose site is not configured in SBA → wizard refuses with `"This Kindoo site (<active site name>) isn't configured in SBA. Add it in Configuration → Kindoo Sites first."` — operator switches sites in Kindoo's own UI and reopens the panel; there is no "switch sites" button in SBA. First-run gate also relaxes: only home buildings must carry `kindoo_rule` for the panel to leave the wizard takeover and show the tabs; foreign buildings get mapped on a subsequent wizard run while the operator's Kindoo session is on that foreign site. The operator must be inside a specific Kindoo site (not the "My Sites" listing page) for the extension to identify the active site.

### Multi-site grants — data model

A Kindoo user whose callings straddle home + foreign sites (e.g. `'Cordera Ward (Bishop) | Foothills Ward (Stake Clerk)'` with Cordera on the home site and Foothills foreign; or the stake-clerk-plus-foreign-ward shape `'<StakeName> (Stake Clerk) | Foothills Ward (Elders Quorum President)'`) surfaces on every site that owns one of those callings. The seat doc carries one primary grant at top level and zero-or-more `duplicate_grants[]` entries that capture every additional grant — both within-site priority losers and parallel grants on other Kindoo sites.

**`duplicate_grants[]` semantics.** The array records "additional grants" of two kinds, distinguished by a per-entry `kindoo_site_id`:

- **Within-site priority loser.** Same `kindoo_site_id` as the seat's primary grant. Informational; the primary's write already covers the access.
- **Parallel-site grant.** Different `kindoo_site_id` from the primary. A legitimate independent grant on another Kindoo site that needs its own write to that site's Kindoo environment.

The distinguishing test is field equality on `kindoo_site_id`; no separate flag.

**`Seat.kindoo_site_id` field.** Mirrors the ward / building convention: `null` (or field absent) means the home site; a string value points at a doc ID under `stakes/{stakeId}/kindooSites/`. The top-level value reflects the primary grant only; each `duplicate_grants[]` entry carries its own `kindoo_site_id`. Stake-scope primary grants resolve to home (per Phase 1 policy, decision 2). Ward-scope primary grants take the ward's own `kindoo_site_id`.

**`Seat.duplicate_scopes: string[]` field.** Denormalised mirror of `duplicate_grants[].scope` — Firestore CEL has no `[*].field` projection over an array of objects, so rules that need to ask "does this seat carry a duplicate grant under this scope" use `scope in duplicate_scopes` against the primitive-string array. Server-maintained on every seat writer (`syncApplyFix`, `markRequestComplete`, `removeSeatOnRequestComplete`, migration); rules reject client writes. T-42 / T-43.

**Sync auto-seat fan-out.** When Sync creates an auto-seat for a person whose callings span multiple Kindoo sites:

- Primary selected by `stake > ward (alphabetical)` per `firebase-schema.md` §4.6 Invariants. Multi-calling within a scope continues to collapse into `callings[]` (with `sort_order` as MIN of `sheet_order` across the array). The `syncApplyFix` writer stamps `scope`, `building_names`, and the derived `kindoo_site_id` at top level.
- For every **(scope, kindoo_site_id)** combo that isn't the primary, `syncApplyFix` emits one entry in `duplicate_grants[]` carrying that site's `kindoo_site_id`, the scope, the calling list for that scope, and the buildings derived from that scope. Two foreign wards on the same foreign site produce two `duplicate_grants[]` entries, both with that site's `kindoo_site_id` but distinct `scope` values; the sync detector unions their `building_names` per-site when computing expected buildings.
- Sync-written parallel-site duplicates always set `building_names` (derived from the duplicate's `scope` → ward → `building_name`, or the stake-scope home-buildings list for stake duplicates). Within-site Sync duplicates leave the field unset and inherit from the primary's ward.
- Within-site priority losers land in `duplicate_grants[]` with `kindoo_site_id === primary.kindoo_site_id`.

**Sync detector.** `pickPrimarySegment`'s collapse-to-one-segment is gone for the per-site path. For each Kindoo site under inspection the detector takes the union of the seat's primary (when its `kindoo_site_id` matches) and each `duplicate_grants[]` entry whose `kindoo_site_id` matches; expected buildings are the union of those grants' `building_names`. The home/foreign mismatch detector still routes off `kindoo_site_id`.

**Provision orchestrator — per-site writes.** When a request or auto-seat needs provisioning, the orchestrator emits one Kindoo write per distinct `kindoo_site_id` across (primary + parallel duplicates), each using the matching Kindoo session. Within-site priority losers (same `kindoo_site_id` as primary) do not get a separate write — the primary's write already covers them. The EID check keys off each grant's `kindoo_site_id`.

**Within-site union.** The per-site write includes the union of `building_names` across the primary (when it sits on that site) and every same-site `duplicate_grants[]` entry. `unionSeatBuildings` in `extension/src/content/kindoo/sync-provision.ts` implements this; the per-site fan-out applies the same union within each site bucket so that no within-site duplicate's buildings are silently dropped.

**Multi-site provision — sequential per-site walk.** Multi-site provisioning walks the plan sequentially. The orchestrator iterates over the distinct `kindoo_site_id` values required by the write, in a stable order. For each step, the Phase 3 EID check (see §15 Phase 3) validates that the active Kindoo session's EID matches the step's `kindoo_site_id`; if it doesn't, the orchestrator refuses with the existing "switch to site X" error and the operator switches sites in the Kindoo UI before retrying. Each per-site Kindoo write is atomic at the Kindoo level, so a half-progressed plan (operator completes step 1 then walks away) is recoverable — re-running the request from scratch produces the same end state. There is no session-registry or upfront-reachability machinery; the per-step EID check is the gate.

**Utilization.** Foreign-site ward seats stay excluded from home-stake utilization. The calculation reads `Seat.kindoo_site_id` directly when populated (`syncApplyFix`, `markRequestComplete`, and the migration stamp it) and falls back to the seat's `scope` → ward `kindoo_site_id` for legacy seats still in the migration window. Externally observable behaviour is unchanged — the field is a denormalisation.

**Request completion auto-merge.** `markRequestComplete`'s server-side `planAddMerge` (in `functions/src/callable/markRequestComplete.ts`) stamps `kindoo_site_id` on a newly-appended `duplicate_grants[]` entry, derived from the request's scope and ward lookup. `building_names` is already recorded on the duplicate; this adds the site. The extension's deprecated v2.2 auto-merge path (referenced in the `DuplicateGrant.building_names` comment in `packages/shared/src/types/seat.ts`) is not affected — that code path is separate.

**One-shot migration.** A separate migration step backfills `kindoo_site_id` on every existing primary seat and every existing `duplicate_grants[]` entry by looking up the entry's `scope` → ward → `kindoo_site_id` (stake-scope ⇒ home). Decisions locked in:

- **Skip-if-equal.** The migration reads the existing `kindoo_site_id` on each seat and each `duplicate_grants[]` entry; it writes only when the derived value differs from what's already stored. First run produces ~500-750 audit rows (one per write); re-runs over an already-migrated stake produce 0.
- **Missing-ward fallback.** When a `duplicate_grants[]` entry's `scope` points at a ward that no longer exists, the migration skips the entry with a logged warning. It does not error out the whole migration and does not fall back to "home" (which could silently miscategorize a foreign-site grant).
- **Audit-row churn.** Migration writes stamp `lastActor.canonical = 'Migration'`; the `auditTrigger` recognises that sentinel and emits each row under `action='migration_backfill_kindoo_site_id'` rather than generic `update_seat`. First run: ~250 seats × ~1-2 duplicates each → ~500-750 rows, one-time. Re-runs: 0 audit rows (skip-if-equal).
- **Scope.** Per-stake. The migration callable (`backfillKindooSiteId`) takes a `stakeId` parameter, matching the rest of the architecture's stake-parameterization (F15).

### Phase B — roster surfaces for parallel grants

Phase A (above) makes the data model and the Kindoo-side writes correct per-site. Phase B closes the visibility gap on the Manager-facing roster surfaces: AllSeats renders one row per grant; Bishopric / Stake / Ward Rosters and the Manager Dashboard's per-scope rollups broaden inclusion so a seat appears under any scope its primary or any `duplicate_grants[]` entry matches; the per-row foreign-site badge keys off the rendered grant's `kindoo_site_id`; and the Remove path on duplicate rows splices only the matching `(scope, kindoo_site_id)` entry. Implementation landed in T-43.

**Prerequisite.** Phase B assumes the T-42 Phase A migration callable (`migration_backfill_kindoo_site_id`) has run on every target stake so that `Seat.kindoo_site_id` and each `duplicate_grants[]` entry's `kindoo_site_id` are populated. The Phase B `isParallelSite = grant.kindoo_site_id !== primary.kindoo_site_id` predicate is meaningless on un-migrated seats where both sides are `undefined`. Deploying Phase B against an un-migrated stake renders every duplicate as `isParallelSite === false` (same-site) and the broadened-inclusion / per-grant badge work degrades to a no-op rather than misclassifying — but the operator-visible behaviour is undefined and Phase B does not roll out until the migration has run.

**AllSeats — one row per (member, scope) per seat.** `apps/web/src/features/manager/allSeats/AllSeatsPage.tsx` renders one row per **scope** on each seat: the primary plus one row per `duplicate_grants[]` entry whose scope differs from every earlier grant on that seat. Same-scope duplicates (a primary plus one or more DuplicateGrants sharing the primary's `scope`) collapse into the row that owns that scope (primary if it matches, else the first duplicate at that scope) — the collapsed row's `building_names` is the union of every same-scope grant's buildings in stable primary-first order. Cross-scope duplicates render unchanged (their own row). Each row's columns — scope, callings, type, building_names, foreign-site badge, reason / dates for manual / temp — reflect the grant being rendered. The pending-removal badge query (`partitionPendingForRoster` in `apps/web/src/features/requests/rosterPending.ts`) discriminates by `(member_canonical, scope, kindoo_site_id)` via the exported `pendingRemoveKey` helper, so a pending remove on one row doesn't light up another row with the same scope but a different `kindoo_site_id`. Two same-scope rows on the same `kindoo_site_id` no longer exist post-collapse on a single seat.

**Reconcile button removed.** The Reconcile button + `ReconcileDialog` + `useReconcileSeatMutation` are gone. Phase B's multi-row rendering surfaces every grant visually, making Reconcile redundant.

**Per-row data shape.** The helper `grantsForDisplay(seat: Seat): GrantView[]` in `apps/web/src/lib/grants.ts` returns one `GrantView` per grant: `{scope, callings, type, building_names, kindoo_site_id, reason?, start_date?, end_date?, isPrimary, isParallelSite, duplicateIndex, hasSameScopeDuplicates}`. The first entry corresponds to the primary; each subsequent entry to a `duplicate_grants[]` entry in array order. `isParallelSite` is `kindoo_site_id !== primary.kindoo_site_id` per the Phase A distinguishing test. `hasSameScopeDuplicates` is always `false` on a raw `grantsForDisplay` view; it is set to `true` by the same-scope collapse helpers (`collapseSameScopeGrants` for AllSeats; `pickGrantForScope` for per-scope roster pages) when the chosen view absorbed building_names from one or more other same-scope grants. AllSeats pipes every seat's views through `collapseSameScopeGrants(views)`, which folds same-scope DuplicateGrants into the row that owns each scope and unions their `building_names`. Per-scope roster pages use `pickGrantForScope(seat, scope)` to pull just the grant that matched the page's scope; if other grants share that scope on the same seat, their `building_names` are unioned into the returned view and `hasSameScopeDuplicates` is set.

**Bishopric Roster / Stake Roster / Ward Rosters — broadened inclusion, single row.** `apps/web/src/features/bishopric/RosterPage.tsx`, `apps/web/src/features/stake/RosterPage.tsx`, and `apps/web/src/features/stake/WardRostersPage.tsx` include a seat on a scope's roster page when **any grant** (primary OR any `duplicate_grants[]` entry) matches the page's scope. One row per person; the row renders the fields of the grant that matched the scope (calling list, type, building_names, foreign-site badge), not the primary's fields. When a seat carries more than one grant at the page's scope (primary + one or more same-scope DuplicateGrants), `pickGrantForScope` returns a single view whose `building_names` is the union of every same-scope grant's buildings (primary-first stable order) and whose `hasSameScopeDuplicates` flag drives a "Duplicate" badge on the row (see "Duplicate badge — operator-facing tooltip" below). The hooks (`useBishopricRoster`, `useStakeRoster`, `useWardSeats`) implement the wider read as a two-query union per KS-10 Option (b): `where('scope', '==', X)` plus `where('duplicate_scopes', 'array-contains', X)`, merged client-side by `member_canonical`. The presentation extracts to a shared `apps/web/src/components/roster/PerGrantRosterCard.tsx` primitive. Auto-band rows matched on a duplicate grant sort using the seat's top-level `sort_order` (the primary's calling rank). `DuplicateGrant` carries no `sort_order` field; in the rare case where a duplicate's calling rank differs from the primary's, the row sorts at the primary's slot. Acceptable at target scale — fix only if it becomes visible in production rosters.

**Manager Dashboard — broadened inclusion on per-scope rollups.** `DashboardPage.tsx`'s `countSeatsForScope` helper counts a seat on a scope's bar when its primary OR any duplicate's scope matches. Same-scope within-site duplicates collapse — one count per `(member_canonical, scope)` — so a seat with two `scope='CO'` grants doesn't double-count on the Cordera bar.

**Same-scope DuplicateGrants — collapsed everywhere.** A DuplicateGrant whose `scope` matches the primary's (whether a within-site Sync-written priority loser, a `planAddMerge` same-scope manual addition like a manager-added grant naming extra buildings, or anything else with `dup.scope === primary.scope`) does NOT render as its own row on any manager surface. AllSeats and per-scope roster pages collapse it into the (member, scope) row owned by the primary (or the first same-scope grant when no primary matches); the collapsed row's `building_names` is the union of every same-scope grant's buildings. A "Duplicate" badge with the operator-facing tooltip (see below) marks any collapsed row whose union absorbed buildings from at least one same-scope DuplicateGrant. No separate Kindoo write happens for same-`kindoo_site_id` same-scope grants — the primary's write covers them per §454.

**Duplicate badge — operator-facing tooltip.** Both AllSeats (`GrantRowCard` in `AllSeatsPage.tsx`) and per-scope roster pages (`PerGrantRosterCard.tsx`) render a "Duplicate" badge on any collapsed row whose `grant.hasSameScopeDuplicates` is `true`. The badge tooltip is **"This user was manually granted access to additional buildings."** — operator-facing copy that explains the row's `building_names` was widened beyond the primary grant's explicit set. AllSeats also continues to render the "Duplicate" badge on cross-scope DuplicateGrant rows (`!isPrimary && !hasSameScopeDuplicates`) with the older parallel-site / within-site tooltips kept on §491's Edit-disabled rule for those still-standalone rows.

**Foreign-site badge — per-row / per-grant.** The new `siteLabelForGrant(grant, wards, sites)` helper in `apps/web/src/lib/kindooSites.ts` resolves the badge from the grant's own `kindoo_site_id`, falling back to the ward catalogue when the grant's site is null (legacy / pre-migration). A Cordera bishopric row showing a stake-primary person whose Cordera duplicate is being rendered shows the badge based on Cordera's site (home → no badge; foreign → that site's display name), not on the seat's primary site. The legacy `siteLabelForSeat` sibling remains for non-grant-aware callers.

**Edit Seat dialog — unchanged.** Phase B does not modify the Edit Seat dialog. Edits continue to operate on the primary grant only. Parallel-site changes require a new request.

**Edit button on duplicate rows in AllSeats — disabled with tooltip.** The Edit button renders on every row to preserve the action-column rhythm but is disabled on **standalone duplicate rows** — rows backed by a `duplicate_grants[]` entry whose scope differs from the primary's. (Same-scope DuplicateGrants no longer produce their own row; they fold into the primary's row per §485, and the primary row's Edit button is enabled in the usual way.) The tooltip on a disabled duplicate row is rendered per case:

- **Parallel-site duplicate row** (`isParallelSite === true`): *"Edit the primary grant to modify this person's seat — parallel-site changes require a new request."*
- **Within-site duplicate row** (`isParallelSite === false`): *"Edit the primary grant to modify this person's seat — this row is informational and is covered by the primary's write."* (Now only reachable for a cross-scope DuplicateGrant on the same `kindoo_site_id` as the primary — the same-scope subset of within-site duplicates collapses away.)

The Edit button on the primary row is unchanged. Per-scope roster pages don't render an Edit button on grant-matched duplicate rows (the `canEditSeat` gate keys off `seat.scope`, which is the primary's, and a bishopric viewing a stake-primary duplicate row has no authority over the primary scope).

**Remove button on duplicate rows in AllSeats — functional when the duplicate's (scope, kindoo_site_id) differs from the primary's.** Clicking Remove on a duplicate row generates a `remove` request whose `scope` and `kindoo_site_id` field reflect the duplicate's grant, not the seat's primary. `kindoo_site_id` is always present on `remove` requests, mirroring the (scope, kindoo_site_id) discriminator pair. For a primary-row remove, the value equals the seat's top-level `kindoo_site_id`; for a duplicate-row remove, it equals that duplicate's `kindoo_site_id`. The `planRemove` trigger discriminates on the (scope, kindoo_site_id) pair against the seat's grants. The `<RemovalAffordance>` component requires a `grant` prop carrying both fields; every caller passes it.

Same-`(scope, kindoo_site_id)` collisions on a single seat no longer produce a standalone duplicate row at all — they collapse into the primary's row per §485, so the Remove discriminator never has to disambiguate a same-`(scope, kindoo_site_id)` pair from a duplicate row. The `planRemove` trigger's KS-9 auto-primary disambiguation in `functions/src/triggers/removeSeatOnRequestComplete.ts` remains in place as defense-in-depth for the path where a Remove on the (collapsed) primary row of an `auto` primary that absorbed a manual same-scope DuplicateGrant resolves to the non-auto duplicate (per `planAddMerge` semantics). Cross-scope (`scope`-different) duplicates and parallel-site (`kindoo_site_id`-different) duplicates always render their own row and always render Remove; the (scope, kindoo_site_id) discriminator targets that row's grant unambiguously.

**Mark Complete dialog — unchanged.** Phase A's `markRequestComplete` merge logic already stamps the new duplicate's `kindoo_site_id` correctly.

**Audit Log — unchanged.** Phase A's roughly 2× audit-row volume on multi-site provisions is accepted as-is.

**Sort and filter on AllSeats.** Each row sorts independently by its own grant's fields. There is no grouping by seat — a person's two rows can interleave with other people's rows when sorted by calling, type, or any other column.

**Server-side surface.** Phase B requires three server-side changes:

- **`Seat.duplicate_scopes: string[]` denormalized field (OWNED BY PHASE A).** Firestore-rules CEL cannot project a field across an array of objects (no `array[*].field` projection; only primitive-array operations like `in` / `hasAny` / `hasAll`), so the bishopric `seats.read` widening reads against this primitive mirror. Phase A maintains it on every seat-write path: `syncApplyFix.ts`, `markRequestComplete.ts` (fresh-seat create + `planAddMerge` merge branches), `removeSeatOnRequestComplete.ts` (both promote and drop_duplicate paths), the web-side queue-completion seat write, and the T-42 migration backfill.
- **`firestore/firestore.rules` — bishopric `seats.read` widened.** The bishopric clause now reads `resource.data.scope in bishopricWardOf(stakeId) || ('duplicate_scopes' in resource.data && resource.data.duplicate_scopes.hasAny(bishopricWardOf(stakeId)))`. The presence guard is defense-in-depth: if any seat-write path lands a doc without `duplicate_scopes`, `hasAny(...)` on the missing field would throw and the bishopric read would explode; the presence check degrades that case to "no duplicate matches" rather than a hard rule error. The stake-presidency clause needs no widening — `isStakeMember(stakeId)` already grants unrestricted seat reads in the stake.
- **Optional `kindoo_site_id` on remove requests.** `packages/shared/src/schemas/request.ts` + `packages/shared/src/types/request.ts` add `kindoo_site_id?: string | null`. The Phase B SPA always stamps the field on `remove` requests (primary row → seat's top-level `kindoo_site_id`; duplicate row → that duplicate's). The field stays typed optional only so legacy pre-Phase-B `remove` requests on disk (with no `kindoo_site_id`) still round-trip — see the trigger's scope-only fallback below. The `requests.create` rule predicate accepts arbitrary additional fields, so no rules change is required for the new field.
- **`planRemove` in `functions/src/triggers/removeSeatOnRequestComplete.ts`.** Keys on the `(scope, kindoo_site_id)` pair when the request carries `kindoo_site_id`; falls back to scope-only matching when the field is absent (legacy pre-Phase-B requests on disk). Primary-row remove with `(scope, kindoo_site_id)` matching the primary's: today's delete-or-promote path applies. Duplicate-row remove: only the matching `duplicate_grants[]` entry is spliced; primary + remaining duplicates stay intact, and the Kindoo removal write fires against the correct foreign site via the Phase A per-site orchestrator.
- **Provision orchestrator — unchanged.** Phase A already routes the remove write to the correct Kindoo site via per-grant `kindoo_site_id`.

**Acceptance criteria.**

1. **AllSeats multi-row across distinct scopes.** A seat with one primary + two `duplicate_grants[]` entries at three different scopes renders 3 rows. Each row's columns reflect the grant. Verified by RTL test.
2. **AllSeats — same-scope DuplicateGrant collapses into the primary row.** A seat with primary `scope='Cordera'` (`building_names: ['Primary Building']`) and a duplicate with `scope='Cordera'` (`building_names: ['Extra Building']`) renders **one row** whose `building_names` is the union (`['Primary Building', 'Extra Building']`) and which carries the "Duplicate" badge with tooltip *"This user was manually granted access to additional buildings."*. The Edit button on that collapsed row is enabled (it's the primary's). Cross-scope DuplicateGrants on the same seat still render their own rows. Verified by RTL tests (`AllSeatsPage.test.tsx` collapse cases including the operator-reported Corry Macfarlane repro).
3. **Bishopric Roster — broadened inclusion.** A seat with primary `scope='stake'` and a `duplicate_grants[]` entry with `scope='Cordera'` appears on Cordera's bishopric roster (was invisible pre-Phase-B). Single row. Row's columns reflect the Cordera duplicate.
4. **Stake Roster — broadened inclusion.** A seat with primary `scope='Cordera'` and a stake-scope duplicate appears on the stake-scope view. Single row.
5. **Manager Roster / Dashboard rollups — broadened inclusion.** Whichever manager-side per-scope summaries exist similarly widen inclusion.
6. **Foreign-site badge** renders per-row based on the rendered grant's `kindoo_site_id`, not the seat's primary `kindoo_site_id`.
7. **Edit Seat dialog unchanged behavior.** Still edits primary only. Edit button on a standalone (cross-scope) duplicate row is disabled with the per-case tooltip from §493. A collapsed primary row that absorbed same-scope DuplicateGrants has its Edit button enabled.
8. **Remove on duplicate row — functional when the discriminator differs from the primary.** Clicking Remove on a parallel-site or cross-scope duplicate row generates a `remove` request scoped to **that duplicate's (scope, kindoo_site_id)**. When marked complete, only that `duplicate_grants[]` entry is removed; primary + remaining duplicates stay intact; the Kindoo removal write goes to the correct foreign site. Same-`(scope, kindoo_site_id)` collisions on a single seat no longer produce a standalone duplicate row (collapsed per §485), so the "Remove hidden on same-`(scope, kindoo_site_id)` priority loser" rule is moot in the UI. The `planRemove` trigger's KS-9 auto-primary disambiguation is retained for the path where a Remove on a collapsed primary row of an `auto` primary that absorbed a non-auto same-scope DuplicateGrant routes the splice to the non-auto duplicate. Verified by Cloud Functions integration test + RTL tests on the surviving cross-scope and parallel-site cases.
9. **Sort/filter** on AllSeats: each row sorts independently by its own grant's fields (no special grouping by seat). Per operator: "if users hit issues, fix then." No acceptance test needed beyond not breaking today's sort logic.
10. **`seats.read` rule widened on the bishopric clause for any-grant scope match.** A bishopric member of ward X can read a seat whose primary is `scope='stake'` (or some other ward) and whose `duplicate_grants[]` includes an entry with `scope='X'` (mirrored on `duplicate_scopes`). Stake-presidency reads need no widening: `isStakeMember(stakeId)` already grants unrestricted seat-reads. Verified by `firestore/tests/` rules unit tests covering the bishopric-via-duplicate read path, plus a negative test that a non-matching outside-stake reader is still denied.
11. **`Seat.duplicate_scopes` denormalized field present on every seat-write path.** Every Seat doc carries `duplicate_scopes: string[]` mirroring `duplicate_grants[].scope`. Written by every seat-write path: (i) `syncApplyFix.ts:239` (auto-seat fan-out, replacing the removed importer path), (ii) `markRequestComplete.ts:381` (fresh-seat create branch), (iii) `markRequestComplete.planAddMerge` (line 113+, merge branch), (iv) `removeSeatOnRequestComplete.ts:planRemove`, (v) `apps/web/src/features/manager/queue/hooks.ts:131` (web-side queue-completion seat write), and (vi) the T-42 migration backfill. Owned by Phase A; Phase B will not ship until Phase A's PR covers all six paths. Verified by integration tests asserting `duplicate_scopes` is populated post-write on every path, plus a migration test asserting the field is populated on every seat after a one-shot run.
12. **Reconcile removed.** The Reconcile button on AllSeats, `ReconcileDialog`, `useReconcileSeatMutation`, and the related tests are deleted from the codebase. Phase B's multi-row rendering subsumes the surface. No server callable exists for `reconcileSeat` (the mutation was client-only), so no Cloud-Functions deletion is required.
13. **Pending-removal badge discriminates by `(member_canonical, scope, kindoo_site_id)`.** A pending `remove` request for grant `(memberX, scope='Cordera', kindoo_site_id=<foreign-east>)` lights up the badge ONLY on the East-Stake-Cordera row, not on the home-Cordera row. Same-`(scope, kindoo_site_id)` collisions on a single seat collapse per §485 and surface as one row; that row lights up when the pending `remove` matches its `(scope, kindoo_site_id)`. Verified by RTL test against `partitionPendingForRoster` (or its replacement) and against the AllSeats / Roster surfaces that render the badge.

**Out of scope for Phase B (explicit).**

- Edit Seat multi-grant editing.
- Mark Complete callout / hint about parallel-grant creation.
- Dashboard hint that the same person appears on two ward bars.
- Audit Log grouping across rows.
- Any layout change to per-scope roster pages beyond inclusion-logic widening.

### Operator decisions locked in (2026-05-16)

1. **Schema naming: "Kindoo sites".** Collection `kindooSites`, field `kindoo_site_id`. Picks the Kindoo-side noun over the stake-side noun precisely because this is not multi-stake.
2. **Stake-scope auto seats grant access to home-site buildings only.** Foreign-site buildings are excluded from the stake-wide auto-seat pool. Cross-Kindoo-site presidency-wide door grants are not in scope; an explicit per-foreign-site manual grant covers the rare case.
3. **Extension refuses provision on EID mismatch with an explicit error** when the active Kindoo session's EID does not match the request's target site. Phase 3 work; no silent fallback.
4. **Small scale; no pagination.** Operator expects 1-2 foreign sites total. Configuration UI lists them inline alongside wards and buildings.
5. **Authority gating unchanged.** The csnorth `kindooManagers` allow-list governs all Kindoo writes regardless of which Kindoo site they target. Kindoo Sites does NOT introduce a new role.
