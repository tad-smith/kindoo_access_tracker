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
| **Automatic** | Tied to callings (church roles) assigned in LCR (the church's membership system). | Managed via a weekly import from an existing callings spreadsheet. |
| **Manual** | Assigned to an individual. | Held until explicitly removed. |
| **Temporary** | Assigned with a start and end date. | Auto-expires on the end date. |

Bishoprics (Bishop + two counselors; one bishopric per ward) submit requests for manual/temp seats in their ward. The Stake Presidency does the same against the stake pool. One or more **Kindoo Managers** process those requests by manually mirroring changes into Kindoo (which has no API), then marking the requests complete.

## 2. Stack

- **Identity:** Firebase Authentication, Google sign-in only. The auth token (refreshed automatically by the Firebase JS SDK) carries custom claims that drive role resolution; see §4.
- **Authorization:** Firestore Security Rules consult `request.auth.token.stakes[stakeId]` for role checks. Custom claims are the only authoritative role source — there are no per-request Firestore lookups for role resolution from rules. See `firebase-schema.md` §6.
- **Database:** Firestore in Native mode (`us-central1`), single-stake project at `kindoo-prod`. All collections are parameterized under `stakes/{stakeId}/...` with three top-level collections (`userIndex`, `platformSuperadmins`, `platformAuditLog`) for cross-stake plumbing. Schema authoritative in `firebase-schema.md`.
- **Client:** React 19 + TypeScript + Vite SPA, served from Firebase Hosting. Reads Firestore directly through the JS SDK; writes go through Firestore transactions or `setDoc`/`updateDoc` with rules enforcing field-level invariants. TanStack Router for routing, TanStack Query as the cache substrate, with a small DIY hooks layer at `apps/web/src/lib/data/` (per architecture D11) that pushes `onSnapshot` results into the query cache.
- **Server compute:** Cloud Functions (2nd gen, Node 22) only — no Cloud Run, no Express, no per-request server-side path. Functions cover: weekly importer (Sheets API), daily temp-seat expiry, email send (Resend), audit-log fan-in, custom-claims sync, FCM push fanout, callable endpoints for the bootstrap wizard's manager-triggered actions, and a nightly audit-gap reconciliation. Function inventory: `firebase-schema.md` §7.
- **Email:** [Resend](https://resend.com) on the free tier (100/day, 3000/month). Domain verification on `mail.stakebuildingaccess.org` per F17. Wrapper at `functions/src/lib/resend.ts`; typed sender per notification type at `functions/src/services/EmailService.ts`. See §9.
- **Push notifications:** FCM Web Push, additive-opt-in on a per-device basis. Per-user `notificationPrefs` and per-device `fcmTokens` live on `userIndex/{canonical}`. Service worker at `apps/web/public/firebase-messaging-sw.js` handles background pushes. Phase 10.5 ships only "new request → managers"; the four-other-types expansion is Phase 10.6, deferred.
- **Scheduling:** Cloud Scheduler invokes the importer and expiry callable wrappers on schedule. Per-stake scheduling is single-loop (one Scheduler job calls one Function which iterates over stakes whose schedule matches).
- **Hosting / domain:** Firebase Hosting on `kindoo-prod` serves the SPA build at both `stakebuildingaccess.org` (the F17 brand apex, live 2026-05-13) and the legacy `kindoo.csnorth.org` (live since Phase 11 cutover 2026-05-03). Both hostnames have auto-provisioned Let's Encrypt certs. Dual-hosting is the chosen final state — no redirect, no takedown of the legacy hostname.
- **PWA:** `vite-plugin-pwa` configures the service worker (cache-first for static assets, network-first for `index.html`, never cache Firestore traffic) and manifest. App is installable on iOS, Android, and desktop.
- **Local dev:** Firebase emulator suite (Firestore, Auth, Functions, Hosting). `pnpm dev` runs emulators + Vite + Functions in parallel.

## 3. Data model

The authoritative schema reference is [`firebase-schema.md`](firebase-schema.md). This section names the collections and gives the role-resolution invariants; field-by-field shapes live in the schema doc.

### 3.1 Top-level collections

- **`userIndex/{canonicalEmail}`** — bridge between canonical-email-keyed role data and Firebase Auth's uid. Carries the FCM device-token map and per-category notification preferences. Written by `onAuthUserCreate` and by the user themselves (subscribing to push); claim-sync triggers translate canonical email → uid through this. See `firebase-schema.md` §3.1.
- **`platformSuperadmins/{canonicalEmail}`** — empty in single-stake v1; populates if/when a platform-superadmin role becomes meaningful.
- **`platformAuditLog/{auditId}`** — empty in single-stake v1; reserved for cross-stake operations.

### 3.2 Per-stake collections

All under `stakes/{stakeId}/`. Schema authoritative in `firebase-schema.md` §4.

- **`stakes/{stakeId}` (parent doc)** — collapses what was the legacy `Config` tab: stake_name, callings_sheet_id, bootstrap_admin_email, setup_complete, stake_seat_cap, expiry_hour / import_day / import_hour, timezone, notifications_enabled, last_over_caps_json, last_import_at, last_expiry_at, etc.
- **`stakes/{stakeId}/wards/{wardCode}`** — 2-letter PK matching the LCR tab name and the `scope` value used elsewhere. Carries an optional `kindoo_site_id: string | null` (Kindoo Sites — §15); `null` / absent means the home site.
- **`stakes/{stakeId}/buildings/{buildingId}`** — slug-keyed (`Cordera Building` → `cordera-building`). Also carries `kindoo_site_id: string | null` with the same semantics.
- **`stakes/{stakeId}/kindooSites/{kindooSiteId}`** — foreign-Kindoo-site directory (§15). Manager-chosen slug as doc ID. Empty when the stake operates only its home Kindoo site.
- **`stakes/{stakeId}/kindooManagers/{canonicalEmail}`** — the manager allow-list. Doc existence + `active=true` defines the manager set.
- **`stakes/{stakeId}/access/{canonicalEmail}`** — per-user role-grant doc. Splits `importer_callings` (Cloud-Function-managed; Admin SDK only) and `manual_grants` (manager-managed, via the manager Access page). Composite-key uniqueness on (canonical_email, scope, calling) is *structurally absent* — the two maps cannot collide. F7. Doc-level `sort_order` (Phase 10.3) denormalizes the lowest `sheet_order` across `importer_callings`.
- **`stakes/{stakeId}/seats/{canonicalEmail}`** — one doc per (stake, member). Multi-calling people get `callings: [...]`; the rare cross-scope collision lands the secondary grant in `duplicate_grants[]` and is informational, not counted in utilization. F5, F6. `sort_order` denormalizes the MIN of `sheet_order` across `callings[]`.
- **`stakes/{stakeId}/requests/{requestId}`** — UUID-keyed because a member can submit many requests over time. Carries the `urgent` flag (Phase 10.3) and the denormalized `seat_member_canonical` for remove-request completion. F19.
- **`stakes/{stakeId}/wardCallingTemplates/{callingName}`** — URL-encoded calling name as doc ID; carries `give_app_access`, `auto_kindoo_access` (Phase 10.4 — gates whether the importer creates a seat), and `sheet_order` for wildcard tie-breaking.
- **`stakes/{stakeId}/stakeCallingTemplates/{callingName}`** — same shape, applied to the LCR Stake tab.
- **`stakes/{stakeId}/auditLog/{auditId}`** — flat, server-written audit collection. One row per write to seats, requests, access, kindooManagers, or the stake parent doc, fanned by the `auditTrigger` Cloud Function (F8). Doc IDs are deterministic from `(collection, docId, writeTime)` so retries are idempotent. 365-day Firestore TTL.

### 3.3 Naming and key conventions

- **Canonical email** is `lowercase + Gmail dot/+suffix strip + googlemail.com → gmail.com`. Computed in `packages/shared/canonicalEmail.ts` and applied at every input boundary. The canonical form is the doc-ID for `userIndex`, `kindooManagers`, `access`, and `seats` — there is no separate canonical column.
- **Typed-form email** (preserve case, dots, `+suffix`) is stored alongside in `member_email` / `typedEmail` for display and any future mail surface. The audit log carries both `actor_email` (typed) and `actor_canonical`.
- **Automated actors** use literal strings: `"Importer"` for the weekly import, `"ExpiryTrigger"` for the daily temp-seat expiry job. These are also written into both `actor_email` and `actor_canonical` on audit rows.
- **Building** doc IDs are slugs of `building_name`; the display name is preserved in the `building_name` field. Cross-collection references (e.g. `seats.building_names: string[]`) carry the slug.
- **Ward** doc IDs are the 2-letter `ward_code` (matches the LCR tab name); also the value used in `seats.scope`, `access.importer_callings` keys, and `requests.scope`.

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
- None of the above and not a superadmin → "not authorized".

A user can hold multiple roles per stake; the UI shows the union.

The web app reads the principal via `usePrincipal()` from `apps/web/src/lib/principal.ts`, which derives the principal shape from the Firebase Auth token's custom claims. Rules read the same claims via `request.auth.token.stakes[stakeId]`. There is no second source of truth.

**Claim staleness.** When underlying role data changes (a manager toggles `active`, the importer adjusts `access.importer_callings`, etc.), the relevant sync trigger calls `setCustomUserClaims` then `revokeRefreshTokens` so the next request from that user picks up fresh claims. Worst-case staleness on revocation: ~1 hour for an idle session, <2 seconds for an active one (the SDK auto-refreshes on any 401).

**Bishopric lag.** A newly-called bishopric member can't sign in until the next weekly import populates `access.importer_callings`. Accepted for v1, same as the legacy spec.

## 5. Page map

The SPA is built on TanStack Router with file-based routes under `apps/web/src/routes/`. Page components live under `apps/web/src/features/{feature}/pages/`. Navigation is the Phase-10.1 left-rail + sectioned-nav design (hamburger drawer on phone, icon-only rail on tablet, full rail on desktop); components live under `apps/web/src/components/layout/`. Spec in [`navigation-redesign.md`](navigation-redesign.md).

**Route gating.** Each route declares its role requirement; non-managers deep-linking to a manager page is currently inconsistently gated (T-31 — most manager routes rely on the nav not exposing them; only `/notifications` has an explicit redirect). Server-side enforcement is via Firestore rules regardless of client-side gating.

**Default landing rule.** Multi-role principals resolve via priority — manager > stake > bishopric — and land on the most-privileged role's default page.

### 5.0 Public pages

Two routes render without an auth gate; neither participates in role resolution or `gateDecision()`.

- **`/` (signed-out homepage)** — rendered by `apps/web/src/features/auth/SignInPage.tsx` whenever no Firebase Auth user is present. Audience is ward and stake leadership (bishopric, stake presidency, executive secretaries, clerks) — not Kindoo Managers, who are a downstream role. Layout: a sticky top bar (brand + secondary "Sign in" button), a centred hero (headline + sub-line + primary "Sign in with Google" button), two short feature bullets (request access, auto-expiring temporary grants), a one-paragraph explainer, and a footer linking to `/privacy`, the Chrome Web Store listing, and a contact `mailto:`. Both sign-in buttons call the same `signIn()` flow; the duplicated CTA is intentional (topbar remains reachable after scroll). Once authenticated the route re-renders and falls through to the existing `gateDecision()` in `apps/web/src/routes/index.tsx`, unchanged.
- **`/privacy`** — TanStack Router file route at `apps/web/src/routes/privacy.tsx`. Public; no auth gate; renders identically for reviewers, signed-out visitors, and signed-in users. Hosts the privacy policy for both the web app and the companion "Stake Building Access — Kindoo Helper" Chrome MV3 extension, and is the privacy URL declared on the Chrome Web Store listing. Sections cover: operator identity, what the extension does, data accessed and why, storage and processing (Firestore + Cloud Functions, US region), authentication via `chrome.identity` + Firebase, per-permission justifications for the extension's MV3 manifest, user rights, and a change log keyed on `LAST_UPDATED`. When the extension manifest changes (permissions, host_permissions, OAuth scopes) the corresponding section is updated in the same commit.

`/privacy` carries zero `[PLACEHOLDER]` tokens. The homepage carries one remaining placeholder: `CHROME_WEB_STORE_URL` points at the Web Store root pending the actual extension listing. `CONTACT_MAILTO` is `mailto:support@stakebuildingaccess.org`. See §13.

### 5.1 Bishopric (scoped to own ward)

- **Roster** — active ward seats. All rows show calling + person (auto rows included). Manual/temp rows show reason; temp rows show dates. Each manual/temp row has a remove affordance; clicking opens "Remove access for [person]?" with a required reason field and submits a `remove` request via the shared submit flow. The row's remove control flips to a "removal pending" badge once submitted, so the requester cannot double-submit. Auto rows render no remove control — auto seats track LCR callings and are removed by the next import after the calling change in LCR. Utilization bar shows `current / cap`. Principals holding more than one bishopric role see a "Ward:" dropdown above the utilization bar; rules and the read-side query both validate the requested `wardCode` against the principal's claims so a bishopric for ward CO cannot read ward GE.
- **New Kindoo Request** — shared form (same page for bishopric and stake principals; scope is derived from the principal's claims, not the route). Form: `add_manual` / `add_temp`. Fields: request type, dates (only for `add_temp`, positioned directly under the type selector), member email (required, canonicalized at submit), member name (required for add types; not required for `remove`), reason (required), comment, urgent flag (Phase 10.3 — surfaces a red top-bar marker on the manager queue card), buildings (stake scope only — at least one required client-side and rule-side). Bishopric submits leave `building_names` empty and let the ward default kick in at completion time. Client-side duplicate check warns when the member already has a seat in the selected scope; warns, does not block. Principals holding more than one request-capable role see a "Requesting for:" scope dropdown.
- **My Requests** — the current user's submitted requests with status; Cancel button on pending rows; rejection reason surfaced on rejected rows; completion note (when set) surfaced on complete rows. Multi-role principals see a scope filter dropdown.

### 5.2 Stake Presidency

Same three pages as Bishopric, scoped to the stake pool — uses the same shared form / list components. Plus:

- **Ward Rosters** — read-only dropdown to view any ward's roster.

### 5.3 Kindoo Manager

- **Dashboard** — manager default landing. Five cards: pending request counts grouped by type (deep-link to Requests Queue), recent activity (last 10 audit rows, deep-link to Audit Log filtered by `entity_id`), utilization per scope (one bar per ward + stake; colour-coded ok / warn ≥ 90% / over; deep-link to All Seats filtered by ward), warnings (over-cap pools from `stake.last_over_caps_json` with a deep-link per pool), and last operations (timestamps for the last import, last expiry, and triggers reinstall). Reads are per-card live subscriptions through the DIY Firestore hooks.
- **Requests Queue** — sectioned (Phase 10.3) into Urgent / Outstanding / Future by computed `comparison_date` (start_date for `add_temp`, requested_at otherwise) with a today+7 cutoff at user-local midnight. Each section heading shows the open-request count in parentheses, e.g., `Outstanding Requests (9)`. Sections with zero open requests are hidden. Filter by state (Pending / Complete) — the "Complete" view groups complete, rejected, and cancelled. Filter by ward and type. Pending sorts oldest-first (FIFO); Complete sorts newest-first. Pending cards render metadata + a duplicate-warning block when the member already has a seat in the scope, plus Mark Complete / Reject actions. **Mark Complete opens a confirmation dialog** with a Buildings checkbox group. Pre-tick behaviour: the requester's own selection wins when present (stake scope); otherwise the ward's default building is pre-ticked (bishopric scope); stake requests with no requester selection start with no buildings ticked. **At least one building must be ticked** — enforced both client-side and rule-side. The manager adjusts the selection if needed, clicks Confirm, and the resulting seat doc carries that `building_names` selection exactly. Self-approval policy: a manager who is also a bishopric/stake member may complete or reject requests they themselves submitted; the audit trail records both who submitted and who completed.
- **All Seats** — full roster across every scope; filter by scope/building/type. When the scope filter is "All" and `stake.stake_seat_cap` is set, a full-width "Seat utilization" bar renders between the filters and the per-scope summary cards (Phase 10.3 — contextual `<UtilizationBar>` follows the current scope filter). Inline edit (Edit button on manual/temp rows only — auto rows are importer-owned) of `member_name`, `reason`, `building_names`, plus `start_date` / `end_date` on temp rows. `scope`, `type`, `member_email`, and the canonical-email doc-ID are immutable; rules enforce.
- **Configuration** — edit Wards, Buildings, KindooManagers, Auto Ward Callings (Phase 10.4 — table view of `wardCallingTemplates` with three columns: Calling Name, Auto Kindoo Access, Can Request Access — the latter is the `give_app_access` field), Auto Stake Callings (same shape for `stakeCallingTemplates`), and the Config keys (`stake_seat_cap`, `expiry_hour`, `import_day`, `import_hour`, `notifications_enabled`, etc.). Drag-to-reorder on the calling-template tables (mouse) / tap-and-hold + arrow buttons (touch) sets `sheet_order` for wildcard tie-breaking.
- **App Access** — view over the `access/{canonical}` collection. Importer-managed grants (`importer_callings`) are read-only; the manager cannot edit them because the next import run would just recreate them. Manual grants (`manual_grants`) have a themed Delete confirmation, and an "Add manual access" modal lets the manager grant app access to someone whose calling isn't in a template. On desktop the page renders a table; at narrow viewports it swaps to a card stack. The card view sorts by the doc-level `sort_order` (Phase 10.4); the table view's per-row sort is T-29 (open).
- **Import** — "Import Now" button (calls the `runImportNow` Cloud Function); shows last import time and summary; renders the over-cap banner from `stake.last_over_caps_json` when non-empty.
- **Audit Log** — filterable view over the `auditLog` subcollection (Phase 8 / Phase 10.3). Cursor-paginated against Firestore; max 100 rows per page. Filters combine as AND: `actor_canonical` (canonical-email compare; literal match against `"Importer"` / `"ExpiryTrigger"`), `action` (exact match from the `firebase-schema.md` §4.10 enum), `entity_type` (enum), `entity_id` (exact, case-sensitive), `member_canonical` (cross-collection per-user view), `date_from` / `date_to` (ISO dates, inclusive on both ends in stake timezone). Default window when neither date is supplied is the last 7 days. Deep-linkable via search params. Per-row rendering: a coloured action badge, a one-line summary (with `complete_request.completion_note` surfaced inline for the R-1 no-op case), and a `<details>` block that expands to a Field / Before / After diff table sourced from `computeFieldDiff(before, after)` (T-21).
- **Notifications** (under Settings) — push-subscription panel. Five render branches keyed by device state (`push-unsupported`, `push-requires-install`, `push-vapid-missing`, `push-denied`, `push-enable-button`, `push-subscribed-with-toggle`). Per-device subscription via stable `crypto.randomUUID()` persisted in localStorage; subscribe writes the deviceId-keyed token slot to `userIndex/{canonical}.fcmTokens`. Disable on one device leaves other devices' tokens intact. Manager-only for now; the route gate widens for bishopric/stake users in Phase 10.6 (deferred).

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

1. **Submit.** Requester writes a doc to `stakes/{stakeId}/requests/{rid}` with `status='pending'`, `requester_canonical = authedCanonical()`, `requested_at = serverTimestamp()`, and a `lastActor` matching the auth token. Rules enforce: scope is one the requester can submit for (stake-scope iff stake-member; ward-scope iff bishopric for that ward), member_name is non-empty for add types, building_names is non-empty for stake-scope add types, `urgent` is a boolean. The `auditTrigger` Cloud Function fans an `auditLog` row. The `notifyOnRequestWrite` trigger fires the new-request email to active managers. `pushOnRequestSubmit` fans push notifications to active managers' subscribed devices.
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
| **Auto, ward scope** | Yes (`edit_auto`) | `building_names` only (ward's own `building_name` pre-checked + disabled — extras only, per Policy B). |
| **Manual (any scope)** | Yes (`edit_manual`) | `reason` (= the calling name for manual seats) and `building_names`. `seat.callings` is **not** touched (manual seats carry `callings: []` by convention). |
| **Temp (any scope)** | Yes (`edit_temp`) | `reason`, `building_names`, `start_date`, `end_date`. |

**Who can submit.** Same `allowedScopesFor(seat.scope)` gate as `remove`: a bishopric for that ward can submit ward-scope edits; stake-scope members can submit stake-scope edits. Manager status alone does not grant submit rights (B-3 / T-36) — the role-for-scope rule applies.

**Policy 1 — stake auto seats are non-editable.** Three layers of defense:

1. **Web UI** hides the Edit button on stake auto rows (All Seats / Roster).
2. **Firestore rule** rejects creation of an `edit_auto` request when `scope == 'stake'` — see `firestore/firestore.rules` §requests.create.
3. **`markRequestComplete` callable** rejects `edit_auto` completion when `scope === 'stake'` with `permission-denied` — see `functions/src/callable/markRequestComplete.ts`.

**Policy B — `edit_auto` building selection.** The ward's `building_name` (the building Church Access Automation grants by default for any ward calling at that ward) is pre-checked AND disabled in the edit modal. Operator can ADD other stake buildings beyond it; cannot REMOVE the ward's own building (Church automation owns that grant). `wardCallingTemplates` has no per-template building list — the constraint is the ward's single building, resolved from `wards.{ward_code}.building_name` (see `firebase-schema.md` §4.4). The orchestrator does not need to re-enforce this server-side because the modal already locks the checkbox; the request payload carries the ward's building plus any extras. Stake auto seats never reach this modal (Policy 1).

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

## 8. Weekly import

The `runImporter` Cloud Function (Phase 8) is invoked hourly by Cloud Scheduler and iterates over stakes whose `import_day` + `import_hour` matches the current local day/hour. Manager-triggered runs go through the `runImportNow` callable. Both paths share the same code path; they differ only in the `triggeredBy` label written into the `import_start` / `import_end` audit rows (`triggeredBy: 'weekly-trigger'` for the scheduled invocation, `triggeredBy: <manager canonical>` for the manual button). Per-row audit rows always carry `actor_email='Importer'`. The importer also stamps `stake.last_import_triggered_by = 'weekly' | 'manual'` for the over-cap email's subject attribution (Phase 9).

Default schedule: `import_day='SUNDAY'`, `import_hour=4` (i.e. 04:00 Sunday in the stake's `timezone`).

**Source.** Google Sheet ID stored in `stake.callings_sheet_id`. One tab per ward, named to match the ward's `ward_code` (2-letter code). Plus one tab named `Stake`. The importer service account (`kindoo-app@<project>`) needs Viewer access on the sheet; runbook in `infra/runbooks/granting-importer-sheet-access.md`.

**Tab layout** (matches the LCR-exported callings sheet format):

- Col A: `Organization` (ignored).
- Col B: `Forwarding Email` (ignored).
- Col C: `Position` — column found by header name in the top 5 rows (a title / instructions block may live above the real headers, common in LCR exports).
- Col D: `Name` (literal header text, case-insensitive). On multi-person callings the cell holds a comma-delimited list. `names[i]` pairs with `emails[i]`; overflow emails fall back to an empty `member_name`. Populates `seats.member_name`.
- Col E: the personal-email column. Header text varies by export (`Personal Email`, `Personal Email(s)`, `Personal Emails`); the importer requires the column-E header to contain `personal email` (case-insensitive).
- Col F and rightward: additional email cells for multi-person callings. Header text is free-form and ignored.

**`Position` format.** Ward tabs: 2-letter prefix (matching the `ward_code`), a space, then the calling name. The importer strips the prefix before matching against `wardCallingTemplates`. Stake tab: no prefix; `Position` is treated verbatim and matched against `stakeCallingTemplates`.

**Per tab.** Find the header row (top 5 rows). On ward tabs strip the prefix. Split the Name cell on `,` into an ordered list; collect Col E + any non-blank cells to its right. Pair `names[i]` with `emails[i]` by position.

For each `(calling, email, name)` triple where the calling matches a row in the appropriate template:

- **Calling-template lookup.** Templates' `calling_name` may contain `*` as a wildcard. Importer builds an index that keeps exact entries on a fast-path map and compiles wildcards into anchored regexes; exact wins over wildcard, and Sheet order (`sheet_order`) wins among wildcards.
- **Auto-seat creation gate** (Phase 10.4). The importer creates / preserves a seat doc only if the matched template has BOTH `auto_kindoo_access === true` AND `give_app_access === true` is implied by the seat-creation gate. The earlier behaviour (any template match → seat) was decoupled in Phase 10.4. Templates without `auto_kindoo_access=true` still surface the calling on the manager UI but do NOT create an auto seat.
- **Seat doc shape.** One seat doc per (stake, canonical_email). Multi-calling people get `callings: [...]` with the lowest `sheet_order` denormalized into `sort_order`. Cross-scope people: stake-scope wins primary; ward-scope grants land in `duplicate_grants[]` and are not counted in utilization (F6).
- **Access doc.** If the matched template has `give_app_access === true`, write the calling into `access/{canonical}.importer_callings[scope]`. The `manual_grants` map is untouched — split-ownership at the field level (F7). `sort_order` on the access doc is denormalized as the MIN of `sheet_order` across `importer_callings`.

After processing each tab the importer **fully replaces** that scope's `importer_callings` entries (per access doc) and fully reconstructs auto-seat membership for that scope. Rows no longer present in the LCR source disappear; rows newly present appear; no `source_row_hash` is needed because the doc-ID is the natural key. The same write batch fans audit rows.

**Cap interaction.** Imports always apply — LCR truth wins. After every run the importer computes per-scope utilization (counting every seat doc whose `scope` matches, regardless of `type` — `duplicate_grants[]` does not count). For each ward with `seat_cap > 0` it flags a ward over-cap when the count exceeds the cap. For the stake it flags an over-cap when the stake-portion (`stake_seat_cap - sum(ward seats)`) is exceeded by stake-scope seats. The result array is persisted to `stake.last_over_caps_json` on every run (empty on clean runs, so a resolved over-cap clears the manager Import-page banner). When the array transitions empty → non-empty, `notifyOnOverCap` emails active managers (Phase 9). `over_cap_warning` audit row written on every flagged run.

**Bishopric lag.** New bishopric members can't sign into the app until the next import runs. Same as legacy.

## 9. Email notifications

Five notification types ship via Resend (Phase 9), fired by Firestore triggers on the relevant entity changes.

| Trigger | Recipients | Subject | Link back |
| --- | --- | --- | --- |
| Request submitted | active Kindoo Managers | `[Kindoo Access] New request from <requester> (<scope label>)` | `<WEB_BASE_URL>/manager/queue` |
| Request completed | original requester | `[Kindoo Access] Your request for <member_email> has been completed` | `<WEB_BASE_URL>/my` |
| Request rejected | original requester | `[Kindoo Access] Your request was rejected` | `<WEB_BASE_URL>/my` |
| Request cancelled | active Kindoo Managers | `[Kindoo Access] Request cancelled by <requester>` | `<WEB_BASE_URL>/manager/queue` |
| Over-cap after import | active Kindoo Managers | `[Kindoo Access] Over-cap warning after <manual\|weekly> import` | `<WEB_BASE_URL>/manager/seats` |

Bodies are plain text; every email includes a link back to the relevant page (`WEB_BASE_URL` is set per project via `functions/.env.<project>`). The R-1 completion email surfaces a `Note:` line carrying `request.completion_note` so the requester knows nothing visibly changed. The over-cap email lists every flagged pool with its current count / cap and a deep-link to the filtered All Seats page.

**From address.** Fixed envelope `noreply@mail.stakebuildingaccess.org` (verified Resend subdomain per F17 / T-04). Display name interpolates the stake name: `<stake.stake_name> — Stake Building Access <noreply@mail.stakebuildingaccess.org>`. Optional `Reply-To` from `stake.notifications_reply_to` when set; otherwise the header is omitted (replies bounce off `noreply@`).

**Best-effort discipline.** Every notification trigger catches Resend errors, writes one `email_send_failed` audit row via Admin SDK with a deterministic `auditId(writeTime, suffix)`, logs, and returns. The underlying entity-write trigger never re-throws on a mail failure — the Sheet write is atomic, the email is best-effort. See [`architecture.md`](architecture.md) §9.5 (preserved verbatim from the legacy doc) for the full rationale on why the email lives outside the lock.

**Email kill-switch.** `stake.notifications_enabled` (boolean; default `true`) gates every Resend send. Flipping it to `false` short-circuits before the API call; one log line emitted. Editable from the manager Configuration page.

**Push notifications** (Phase 10.5) ship the new-request notification only. Independent kill-switch per user per device per category at `userIndex/{canonical}.notificationPrefs.push`. The remaining four notification categories (completion / rejection / cancel / over-cap) on push are Phase 10.6, deferred.

## 10. Bootstrap flow

`stake.bootstrap_admin_email` (typed form) is seeded by the operator at stake creation, alongside `setup_complete=false`. Until `setup_complete` flips to `true`, every page load first routes through the **setup-complete gate** in `apps/web` (runs **before** role resolution):

- If the signed-in email matches `bootstrap_admin_email` (typed-form compare) and `setup_complete === false` → render the bootstrap wizard, ignoring deep-link route params.
- If `setup_complete === false` and the email does NOT match → render a "Setup in progress" page (distinct from "Not authorized" — the user isn't unauthorised, the app isn't ready).
- If `setup_complete === true` → normal role resolution.

The wizard is multi-step and writes directly into the live collections (`stakes/{stakeId}` parent doc, `buildings/`, `wards/`, `kindooManagers/`). Each step persists immediately, so closing and reopening mid-setup resumes where the data says it should. Rules carve out a bootstrap-admin escape hatch (`firebase-schema.md` §6.1) — the predicate `isBootstrapAdmin(stakeId)` is OR'd into the read+write rules of the four wizard-managed collections, gated on `stake.setup_complete === false`. Once the wizard's final write flips `setup_complete=true`, the predicate goes silent and the manager claim (already minted by `syncManagersClaims` after the auto-add) takes over.

Steps:

1. Stake name, callings-sheet ID, stake seat cap (writes to `stakes/{stakeId}` parent doc).
2. At least one Building (writes to `buildings/`).
3. At least one Ward with `ward_code`, `ward_name`, `building_name` slug, `seat_cap` (writes to `wards/`).
4. Additional Kindoo Managers (optional; writes to `kindooManagers/`). The bootstrap admin is **auto-added** as an active manager on first wizard load (one-shot idempotent write keyed on canonical email) — they cannot delete themselves and won't be locked out after setup.

**Complete Setup** (enabled when steps 1-3 are complete) flips `stake.setup_complete=true`, calls `installScheduledJobs` (the importer + expiry Scheduler jobs), writes a `setup_complete` audit row, and redirects the admin to the manager default page. `installScheduledJobs` is a callable function pinned to `kindoo-app@`; idempotently creates / updates Cloud Scheduler jobs for this stake.

**One-shot wizard.** The bootstrap-admin gate's `setup_complete === false` clause is what makes this strictly time-bounded. Post-setup edits go through the normal manager Configuration page.

**Operator pre-step.** The stake doc must exist with `setup_complete=false` and `bootstrap_admin_email=<typed email>` BEFORE the bootstrap admin signs in. The gate's `get()` short-circuits if the stake doc is missing — operator seed is mandatory. See `infra/runbooks/provision-firebase-projects.md`.

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

- Multi-tenant (other stakes) — Phase 12 / Phase B work.
- Kindoo API integration (they don't have one).
- Native mobile app (the PWA is enough; installable on iOS, Android, desktop).
- Direct LCR sync (the importer reads the existing callings sheet, which is already a derived source).
- Building permissions UI on bishopric requests (the `building_names` defaulting + manager pre-tick on the complete dialog covers it; the comment field handles exceptions).
- Per-stake tz handling beyond `America/Denver` for v1 (each stake doc carries `timezone` but only one value is in use).
- Push notifications for completion / rejection / cancel / over-cap — Phase 10.6 (deferred).
- Pointing `CHROME_WEB_STORE_URL` on the homepage at the actual Chrome Web Store listing once the extension is published — currently the Web Store root.

## 14. Build history

The Apps Script implementation shipped in 11 chunks (chunks 1-11 in `docs/changelog/chunk-N-*.md`). The Firebase migration shipped in phases 1-11 plus four interleaved sub-phases (10.2 / 10.3 / 10.4 / 10.5); see `docs/changelog/phase-N-*.md`. Phase 11 cutover (2026-05-03) closed Phase A. Phase 12 (multi-stake) is deferred.

## 15. Kindoo Sites (multi-site Kindoo management)

The operator manages a single SBA stake (`csnorth`) but is a Kindoo Manager on multiple Kindoo sites — two wards in csnorth live in buildings whose access doors are physically governed by a different stake's Kindoo environment than the SBA stake's own home site. "Kindoo Sites" tracks those N Kindoo environments the operator's managers can write to (home + 0..N foreign), so the SPA, the companion Chrome extension, and the weekly sync can route Kindoo-side operations to the correct environment without misprovisioning.

This is **not** multi-stake on the SBA side. The SBA stake remains a single SBA stake; only the Kindoo-side cardinality changes. The existing `kindooManagers` allow-list governs all Kindoo writes regardless of which Kindoo site they target — Kindoo Sites does NOT introduce a new role or principal shape. Phase B (multi-stake) is unaffected by this work.

### Data model

- **Home site is implicit.** It lives on the parent stake doc (`stake.kindoo_config.site_id` / `kindoo_config.site_name`, plus the optional `kindoo_expected_site_name` override). There is no `KindooSite` document representing the home site.
- **Foreign sites live as documents** under `stakes/{stakeId}/kindooSites/{kindooSiteId}`. The doc ID is a manager-chosen slug. See [`firebase-schema.md`](firebase-schema.md) §4.11. The Kindoo environment ID (`kindoo_eid`) is NOT a manager-supplied field — the extension discovers it from `localStorage.state.sites.ids[0]` on a session logged into the site and writes it on first use (Phase 3). The Configuration UI captures only the display name and the Kindoo site-name string.
- **Each `Ward` and `Building`** carries an optional `kindoo_site_id: string | null`. `null` (or field absent) means the home site; a string value points at a doc ID under `stakes/{stakeId}/kindooSites/`. Wards and buildings carry the field independently — a foreign-site building hosts foreign-site wards, and the building's value is the load-bearing one for door access, while the ward's value flags Kindoo-side roster placement.

### Phase plan

Kindoo Sites lands in four phases. **Phase 1 ships the data model + the Configuration UI only — no behavioural changes elsewhere.** Defaults treat everything as home site (`kindoo_site_id: null` on every existing ward and building). No backfill is required.

- **Phase 1 (data model + Configuration UI).** Shipped. Adds the `kindooSites` collection, the `kindoo_site_id` field on `wards` / `buildings`, security rules, and a Configure-tab UI for managers to add / edit foreign sites and assign them to wards / buildings.
- **Phase 2 (form filtering + roster labels).** Shipped. The New Request form filters its building checklist to the current scope's Kindoo site — stake-scope shows home-site buildings only (per operator decision 2 below), ward-scope shows the buildings whose `kindoo_site_id` matches the ward's own `kindoo_site_id`. Legacy buildings / wards without the field are treated as home. When the site filter narrows the catalogue to zero (e.g. a foreign-site ward whose foreign building has not yet been configured) the form renders an explicit empty-state directing the manager to Configuration rather than presenting an empty checklist. Roster pages (bishopric roster, stake ward rosters, manager All Seats) render a small foreign-site badge alongside each ward seat whose ward sits on a non-home Kindoo site; home and stake-scope seats carry no badge.
- **Phase 3 (extension orchestrator enforcement).** The companion Chrome extension's Provision & Complete flow validates that the active Kindoo session's EID matches the request's ward's `kindoo_site_id` (resolved through the building) before writing to Kindoo. On mismatch the extension refuses to provision with an explicit error directing the manager to switch Kindoo sites first; no silent fallback.
- **Phase 4 (sync filtering).** The weekly Kindoo↔SBA sync run scopes its diff to one Kindoo site at a time, so a session pointed at the home site does not flag foreign-site grants as drift (and vice versa).

### Operator decisions locked in (2026-05-16)

1. **Schema naming: "Kindoo sites".** Collection `kindooSites`, field `kindoo_site_id`. Picks the Kindoo-side noun over the stake-side noun precisely because this is not multi-stake.
2. **Stake-scope auto seats grant access to home-site buildings only.** Foreign-site buildings are excluded from the stake-wide auto-seat pool. Cross-Kindoo-site presidency-wide door grants are not in scope; an explicit per-foreign-site manual grant covers the rare case.
3. **Extension refuses provision on EID mismatch with an explicit error** when the active Kindoo session's EID does not match the request's target site. Phase 3 work; no silent fallback.
4. **Small scale; no pagination.** Operator expects 1-2 foreign sites total. Configuration UI lists them inline alongside wards and buildings.
5. **Authority gating unchanged.** The csnorth `kindooManagers` allow-list governs all Kindoo writes regardless of which Kindoo site they target. Kindoo Sites does NOT introduce a new role.
