# Firebase data model + security rules

> **Status: LIVE.** Authoritative schema, rules, and indexes reference. The migration committed on 2026-04-27 closed Phase A on 2026-05-03 (see [`docs/changelog/phase-11-cutover.md`](changelog/phase-11-cutover.md)); Firebase is now in production at `kindoo-prod`. See [`docs/firebase-migration.md`](firebase-migration.md) for phase history and [`docs/spec.md`](spec.md) for runtime behaviour.

## 1. Architecture overview

- **Identity:** Firebase Authentication (Google sign-in only).
- **Authorization:** Custom claims on the auth token, set by Cloud Function triggers on role-data writes.
- **Data path (reads):** Client uses Firestore JS SDK directly. Firestore Security Rules enforce per-document access using claims from the auth token.
- **Data path (writes):** Same — client writes via Firestore SDK; rules enforce field-level invariants and cross-doc invariants via `getAfter()`.
- **Server-side compute:** Cloud Functions only, for: email send (Resend), audit-log fan-in, custom-claims sync, FCM push fanout, callable wrappers (request-completion, `syncApplyFix`), and a nightly audit-gap reconciliation. Mirror inventory in §7. Auto-seat ingestion runs through the Chrome extension's Sync feature (see `spec.md` §8), not a server-side importer.
- **Hosting:** Firebase Hosting serves the static SPA build.

No Cloud Run. No Express. No persistent server-side process for the request path.

## 2. Custom claims

Set by Cloud Function triggers on `userIndex`, `access`, and `kindooManagers` writes. The auth token carries:

```typescript
{
  // Standard Firebase claims
  email: string;              // typed form
  email_verified: boolean;
  uid: string;

  // Custom claims set by sync triggers
  canonical: string;          // canonical email; trusted for in-rules comparisons
  isPlatformSuperadmin?: boolean;
  stakes?: {
    [stakeId: string]: {
      manager: boolean;       // in stakes/{stakeId}/kindooManagers/{canonical} with active=true
      stake: boolean;         // has any non-empty grant in stakes/{stakeId}/access/{canonical} with scope='stake'
      wards: string[];        // ward_codes for which the user has any non-empty grant in scopes != 'stake'
      limited?: boolean;      // present-and-true => LIMITED app access in this stake. ABSENT => FULL.
                              // Never written `false`. See below.
      bootstrap?: boolean;    // present-and-true => user is this stake's bootstrap_admin_email
                              // AND setup_complete === false. NOT a role — grants no access.
                              // Never written `false`. See below.
    };
  };
}
```

`limited` (D25) is written by `computeStakeClaims` (`functions/src/lib/seedClaims.ts`) only when all three hold: the user has ≥1 non-empty grant in `access/{canonical}`, **every** grant in that doc is limited-tier, and the user has **no** active `kindooManagers` row. It is emitted present-and-true or omitted entirely — never `false` — because `applyClaims`'s `claimsEqual` is a canonical-JSON compare, so writing `limited: false` for every full user would read as a claim change on the next sync and revoke their refresh token for nothing. A grant is limited only on positive evidence: `manual_grants[scope][].level === 'limited'`, or an importer calling listed in the same doc's `importer_limited_callings[scope]` (§4.5, D26 — a stored field, never derived from the calling's name). Anything else — absent `level`, `'full'`, a non-object array entry, a missing or malformed `importer_limited_callings` — is full. `limited` is not part of the block's emptiness test: it can only be true when some non-empty grant array exists, which already sets `stake` or a ward. Rules read it through an `isLimited(stakeId)` helper whose `'limited' in …` presence guard is load-bearing — a bare field read errors on every full user's write.

`bootstrap` (D28) is written by the `syncBootstrapClaims` trigger (Firestore write on `stakes/{stakeId}`) and, as a first-sign-in catch-up, by `seedClaimsFromRoleData`. It matches `stake.bootstrap_admin_email` against the **plain lowercased** email — never `canonicalEmail()`'d, matching `firestore.rules`' `isBootstrapAdmin` and `createStake`'s storage convention (§4.1) — and requires `setup_complete === false` exactly. It is present-and-true or omitted entirely, same no-token-churn convention as `limited`. Unlike `limited`, it IS part of the block's emptiness test (`isNonEmptyStakeClaims`): a block whose only content is `bootstrap: true` must survive as a real per-stake entry rather than being pruned as "no roles." It is NOT a role: excluded from `hasAnyRole` / `isAuthenticated` in `principalFromClaims`, and excluded from the `stakes` map's role-derived meaning everywhere else — it exists solely so the SPA's active-stake resolver can discover a not-yet-set-up stake before any real role claim is minted (`spec.md` §2.1, §10). A role-data write for the same stake (e.g. `syncManagersClaims` firing when the wizard auto-adds the admin as manager) recomputes that stake's whole block from role data via `applyStakeClaims` — but `mergeStake` (`functions/src/lib/applyClaims.ts`) deliberately carries a prior `bootstrap: true` forward across that replace. `newStakeClaims` never carries `bootstrap` itself (a different owner's field), so without preserving it, whichever trigger fired last would silently erase whatever the other had set. This is what prevents a mid-setup lockout: the wizard mints `bootstrap: true`, then auto-adds the admin to `kindooManagers` (firing `syncManagersClaims`, which replaces the block but keeps `bootstrap` alongside the new `manager: true`); if that manager row is later deactivated while `setup_complete` is still `false`, the block would reduce to `{ manager: false, stake: false, wards: [] }` on role data alone — losing `bootstrap` too would drop the admin out of `accessibleStakes` with nothing left to route them back to their own in-progress wizard, and nothing self-heals it, since `syncBootstrapClaims` only fires on stake-doc writes and the stake doc never changed. Covered by `functions/tests/applyClaims.test.ts`'s `'stays discoverable through mint -> manager auto-add -> manager deactivated, all before setup completes'` case.

Claims are refreshed when underlying data changes (sync triggers call `setCustomUserClaims` + `revokeRefreshTokens`); the client picks them up on its next request via the SDK's automatic 401-and-refresh path. Worst-case staleness for revocation: ~1 hour for an idle session, <2 seconds for an active one.

## 3. Top-level collections

Cross-stake; not under any `stakes/{stakeId}/` prefix.

### 3.1 `userIndex/{canonicalEmail}`

Bridge between canonical-email-keyed role data and Firebase Auth's uid-keyed user records.

**Doc ID:** canonical email (lowercased + Gmail dot-strip + `+suffix`-strip + `googlemail.com` → `gmail.com`).

**Fields:**

```typescript
{
  uid: string;             // Firebase Auth uid
  typedEmail: string;      // exactly as Google returned it
  lastSignIn: Timestamp;   // bumped on each authenticated request, debounced to ~1/hour
}
```

**Written by:** `onAuthUserCreate` Cloud Function on first sign-in; `bumpLastSignIn` callable function (or implicit on first authenticated request per session).

**Read by:** `syncAccessClaims`, `syncManagersClaims` Cloud Function triggers (translate canonical email → uid).

**Rules:** read by the user themselves (typed-email match against auth token); writes server-only.

### 3.2 `platformSuperadmins/{canonicalEmail}`

Active source of truth for the platform-superadmin role (Phase 12 / F19). The `syncSuperadminClaims` trigger reads writes here and mints / revokes the `isPlatformSuperadmin: true` claim. Writes remain console-only per Phase 12 operator decision #2 — there is no in-app UI for adding or removing superadmins, by design (the chicken-and-egg of "who creates the first superadmin?" plus the operator's preference to keep this surface small).

**Doc ID:** canonical email.

**Fields:**

```typescript
{
  email: string;           // typed
  addedAt: Timestamp;
  addedBy: string;         // canonical email of the superadmin who added this entry
  notes?: string;
}
```

**Written by:** Firestore console (chicken-and-egg — no in-app management; see Phase 12 in `firebase-migration.md`).

**Read by:** `syncSuperadminClaims` trigger (sets `isPlatformSuperadmin` claim).

**Rules:** read by superadmins; writes forbidden (console-only).

### 3.3 `platformAuditLog/{auditId}`

Audit trail for cross-stake operations (stake creation, superadmin changes) that don't belong to any stake's `auditLog`.

**Doc ID:** `<ISO-timestamp>_<uuid-suffix>` — sortable by ID for newest-first reads.

**Fields:**

```typescript
{
  timestamp: Timestamp;
  actor_email: string;
  actor_canonical: string;
  action: 'create_stake' | 'add_superadmin' | 'remove_superadmin';
  entity_type: 'stake' | 'platformSuperadmin';
  entity_id: string;
  before: object | null;
  after: object | null;
  ttl: Timestamp;          // 365 days from write time
}
```

**Written by:** the `createStake` Cloud Function callable (Phase 12 / F19) emits `action='create_stake'` rows on every successful stake-doc write. Future superadmin-management triggers (if added) write `add_superadmin` / `remove_superadmin` rows here; for now those actions are reserved enum values with no writer.

**Read by:** Platform admin / Stake List page (`spec.md` §5.4) for cross-stake audit views.

**Rules:** read by superadmins; writes server-only.

### 3.4 `remoteApply/{canonicalEmail}` — remote-apply mailbox

The transport for **remote apply** (`architecture.md` D27, `spec.md` §16): a Kindoo Manager taps a pending request on their phone and their own desktop Chrome extension provisions it in Kindoo.

**Three levels, split by lifetime.** The parent doc carries the profile-wide opt-in and nothing else. `desktops/{siteKey}` carries liveness — one doc per Kindoo site the manager has a live tab on. `jobs/{jobId}` carries one doc per tap.

```
remoteApply/{canonicalEmail}                    the opt-in, one per Chrome profile
remoteApply/{canonicalEmail}/desktops/{siteKey} one live Kindoo tab, one Kindoo site
remoteApply/{canonicalEmail}/jobs/{jobId}       one tap
```

The split exists because the two facts have different lifetimes and different scopes. The opt-in comes from `chrome.storage.local`, so it is profile-wide by construction: ticking the box in one Kindoo tab enables every tab in that profile. Liveness is per site, because a tab can only provision for the site it is currently inside. One presence doc per manager meant two tabs on two sites of one stake overwrote each other's `kindoo_eid` every 60 seconds, and — worse — the claim filter was stake-only, so the foreground tab (10s poll) hoovered up the backgrounded tab's work (60s poll) and failed it with "switch Kindoo sites", advice that is nonsense when the right site is open in the next tab.

**Top-level, not per-stake.** The doc key is the manager's canonical email and the stake is a **field**, because the desktop resolves its own stake from whichever Kindoo site its active session is in — there is no stake in the path to scope by. The phone compares each desktop doc's `stake_id` against its active stake (§2.1 of `spec.md`) and treats "fresh, but all in another stake" as its own presence state.

**Doc ID:** canonical email — the same canonicalization used for `userIndex`, `access`, and `seats` (§3.1). The extension never sends it across the content-script → service-worker boundary; `background/data.ts` derives it from the service worker's own Firebase Auth token, so a compromised page context cannot address another manager's mailbox.

**Fields (opt-in):**

```typescript
{
  remote_apply_enabled?: boolean;  // the extension-side opt-in; ABSENT ⇒ OFF
  ext_version: string;             // manifest version, for diagnosing version skew
  lastActor: { email: string; canonical: string };
}
```

`remote_apply_enabled` is the only optional key and reads **absent ⇒ off**, the same defaulting direction as `ManualGrant.level` and `stake.eq_president_app_access` (§2, §4.5): the flag grants a second device authority to provision building access, so a doc predating the toggle must not read as consent. Turning the toggle off rewrites the doc with `remote_apply_enabled: false` rather than deleting it, so the phone can tell "opted out" from "never installed the extension".

**Written by:** the extension only — `writeRemotePresence` in `extension/src/background/data.ts`. A **whole-document `setDoc`, not `{ merge: true }`**: rules enforce an exact three-key set and they see the *merged* result, so merging onto a doc a previous extension version left carrying `stake_id` / `last_seen_at` / `kindoo_eid` / `kindoo_site_name` would produce a seven-key document and a `permission-denied`. Overwriting is also the migration — the first heartbeat from the current version drops the fields that moved down to `desktops`.

**Read by:** the manager's own phone — `useRemoteApplyPresence()` (`apps/web/src/features/manager/queue/hooks.ts`), a live subscription alongside the `desktops` collection.

**Rules:** read / create / update if `isAuthed() && authedCanonical() == memberCanonical` **and** an exact three-key shape **and** `ext_version.size() <= 32` **and** `lastActorMatchesAuth`. `delete: false`.

**There is deliberately no `isManager` gate on this doc, unlike its two subcollections.** The gate used to read `stake_id` here; that field moved to `desktops`, and every way of re-anchoring it is worse. Rules cannot ask "is this user a manager of *any* stake" — the `stakes` claim is a map and there is no way to test a predicate across its values — and keeping a `stake_id` here purely as a gate anchor would reintroduce exactly the field that flapped between sites on every heartbeat. Dropping it is safe because the doc grants nothing on its own: it is one bool, one version string, and a `lastActor`. The phone requires a fresh `desktops` doc before it offers any button, and both subcollections still carry `stake_id` and still gate on it, so a non-manager who writes here has published consent to use a desktop they cannot register for a stake they cannot queue work under. **What the gate was really guarding — free storage under any signed-in user's own canonical email — is instead bounded by the exact key set plus the `ext_version` length cap, which is load-bearing for exactly that reason and must not be dropped as cosmetic.** It caps the doc at a couple of hundred bytes; one such doc per Google account that has signed into the app is not a storage surface worth a per-heartbeat document read to close.

#### `remoteApply/{canonicalEmail}/desktops/{siteKey}`

One live Kindoo tab, on one Kindoo site.

**Doc ID:** the **site key** — `remoteApplySiteKey(kindooSiteId)` from `@kindoo/shared`. A foreign site keeps its `kindooSites` doc id (§4.10); the home site has no such doc (home lives on `stake.kindoo_config`) and a Firestore doc id cannot be null, so home is spelled with the reserved key **`'home'`**. Every surface derives the key through that one function rather than hand-rolling `?? 'home'`, so if a manager-chosen foreign slug of `'home'` ever needs handling it is one function to change. This is the same value a job carries as `target_site_key`, which is what makes routing an exact match rather than a fallback.

```typescript
{
  stake_id: string;                // stake this site belongs to; gated by isManager
  kindoo_site_id: string | null;   // foreign kindooSites doc id, or null for home
  last_seen_at: Timestamp;         // heartbeat, every 60s while a usable Kindoo tab is open
  kindoo_eid: number | null;       // Kindoo-side environment id this tab is inside
  kindoo_site_name: string | null; // Kindoo's own display name, shown on the phone
  ext_version: string;             // manifest version of the tab publishing this
  lastActor: { email: string; canonical: string };
}
```

Every key is required; three are nullable. `kindoo_site_id` and the doc id encode the same site two ways because a doc id can't be null and the phone wants the nullable form back without re-deriving it; both come from one `resolveTabSite` result. The rule deliberately does **not** check that they agree — the relation is `remoteApplySiteKey`, which rules can't express without hardcoding `'home'` in a second place, and a mismatched pair misroutes only this manager's own jobs.

**Written by:** the extension only, same `writeRemotePresence` call, again a whole-document `setDoc`. Published **only while the Kindoo session is usable** (the loop resolves the site name via Kindoo's `getEnvironments` each heartbeat and skips the write on rejection) **and only when the active EID maps to a site this stake has configured** — a tab in an unconfigured Kindoo site publishes nothing and claims nothing.

**Deleted by:** the extension, on opt-out. Aging out is the fallback, not the goal: a closed or navigated-away tab leaves a doc that stays fresh for `REMOTE_APPLY_STALE_MS`, and during that window the phone names a site as covered when it isn't — precisely the "open a site you already have open" failure the per-site model exists to remove. The delete is gated on ownership alone, deliberately **not** on `isManager`: a manager whose claim was just revoked must still be able to retract presence they published while they held it. A tab that *moves* to another site does not delete the doc it is leaving; the delete is only safe because the profile-wide flag is off by then, so no sibling tab is serving that site either.

**Read by:** the manager's own phone — `useRemoteApplyPresence()` subscribes to the whole collection and reduces it with `freshRemoteApplyDesktops` (opted in **and** `stake_id` matches the active stake **and** `now - last_seen_at < REMOTE_APPLY_STALE_MS`), re-evaluated on a 30s UI tick because presence goes stale by the clock, not by a write. `remoteApplyDesktopForRequest` then picks the desktop whose `site_key` matches a given request's target site — an exact match with no "any tab will do" fallback, since home is a site like any other here.

**Rules:** read if owner. Create / update if owner **and** `isManager(request.resource.data.stake_id)` **and** the exact seven-key shape **and** `lastActorMatchesAuth`. Delete if owner. This is the doc that makes the phone's button appear, so it is the one that has to prove the writer manages the stake it claims to cover. The doc id is not constrained — proving it names a real `kindooSites` doc would cost a read on every heartbeat, home has no such doc at all, and an id naming nothing is inert because no job targets it.

#### `remoteApply/{canonicalEmail}/jobs/{jobId}`

One doc per tap. **Doc ID:** Firestore auto-id (`addDoc`).

```typescript
{
  request_id: string;              // the pending request to apply
  stake_id: string;                // active stake at tap time
  target_site_key: string;         // REQUIRED — the site this must be provisioned on
  status: 'queued' | 'running' | 'applied' | 'partial' | 'failed' | 'cancelled';
  created_at: Timestamp;
  created_by_device: string;       // getDeviceId() — the same per-device UUID push uses
  claimed_at?: Timestamp;
  claimed_by?: { ext_version: string; kindoo_eid: number | null };
  finished_at?: Timestamp;
  outcome?: {
    code: 'applied' | 'sba_incomplete' | 'site_mismatch' | 'kindoo_session_lost'
        | 'building_rule_missing' | 'request_not_pending' | 'error';
    message: string;               // operator-facing sentence, authored on the desktop
    kindoo_uid?: string;
    provisioning_note?: string;
    over_caps?: OverCapEntry[];    // pools this completion pushed over cap; `applied` only
  };
  lastActor: { email: string; canonical: string };
}
```

**`over_caps` exists so the phone shows the warning the desktop always has.** `markRequestComplete` returns the pools the completion pushed past their seat cap and the extension's own `ResultDialog` renders them; before this field the remote path had nowhere to put them and dropped them, so a manager applying from their phone never learned a cap was breached. Same `OverCapEntry` shape the stake doc's `last_over_caps_json` carries (§4.1) — `{ pool, count, cap, over_by }`, where `pool` is `'stake'` or a ward code. Written **only on `applied`** — on `partial` the completion call is precisely what failed, so there is no answer to carry and an empty array would read as "all clear" rather than "never asked" — and omitted rather than written as `[]` when nothing is over cap, matching `kindoo_uid`.

**`target_site_key` is what routes the job.** It is a site key in the `desktops/{siteKey}` vocabulary above, and only a tab inside that site may claim the job — `canClaimRemoteApplyJob` in `@kindoo/shared` is the single expression of that rule, consulted by the poller to pick work and by the stranded sweep to pick a threshold. Required, never null, never empty: there is deliberately no "any site" value, because a phone that can't resolve the target site must not offer the button at all — it cannot know which desktop could serve it. The field is also immutable, and that matters more than the other four immutable fields: a mutable one would let a tab retarget work to itself and run a provision on the wrong Kindoo site.

**The value is derived at tap time, not read off the request.** `remoteApplyTargetSiteKey(request, wards, buildings)` in `@kindoo/shared` mirrors the extension's `checkRequestSite`: `scope === 'stake'` → home unconditionally (a stake-scope request's `building_names` may span sites and is still provisioned on home, so buildings never enter it), a ward scope → `resolveWardSite(ward, buildings)` with null meaning home, and a ward absent from the catalogue → home. **`AccessRequest.kindoo_site_id` is NOT this site.** That field records the Kindoo site of the grant a `remove` targets (§4.7, T-43) and is absent on every add and edit; reading it as the target resolves to "no site" on almost every request. It has misled three readers now and carries a warning comment in `packages/shared/src/types/request.ts` for that reason.

**Status lifecycle.** Only these transitions exist; each is a separate rule branch pinned on the before-status.

```
                    phone taps Apply
                           |
                           v
                        queued
                       /       \
   extension claims   /         \   90s pickup timeout (phone or desktop)
      (queued→running)           (queued→cancelled)
                     /             \
                    v               v
                 running         cancelled
                /   |   \
   applied ◄───┘    |    └───► failed
                    v
                 partial
```

- **`queued`** — created by the phone. The create rule admits **no other status** and no pre-baked `claimed_*` / `finished_at` / `outcome`.
- **`running`** — the extension's claim. This is the lock (see below).
- **`applied`** — Kindoo write succeeded and `markRequestComplete` succeeded.
- **`partial`** — Kindoo write succeeded, `markRequestComplete` did **not**. A distinct terminal status, not a failure: access has been granted or revoked and only the SBA bookkeeping is missing. The phone says so and offers no Retry (a retry would consume a second Kindoo licence).
- **`failed`** — the desktop reported a wall it hit (`outcome.code` says which, and nothing landed in Kindoo), **or** the job was swept as stranded, in which case whether anything landed in Kindoo is unknown. The two are distinguishable only by `outcome.message`; the phone's headline ("Your desktop didn't finish this.") is worded to be true of both.
- **`cancelled`** — nobody picked the job up within `REMOTE_APPLY_PICKUP_TIMEOUT_MS` of the create. **Two writers, one transition.** The phone's own timer is the happy path and the only transition it may write besides the create; the desktop's poller is the backstop, because that timer is a React effect in a phone browser tab — a screen lock suspends it, a close kills it — so leaving it as the only expirer means a pocketed phone's tap gets provisioned unattended hours later. The poller therefore checks age before claiming and writes `queued → cancelled` for anything already past the window, **regardless of site**: staleness is a fact about the job, and the tab that could have served it is the one most likely to have been closed. It cancels rather than skipping because a `queued` job blocks the phone's Apply button for that request, so skipping would swap an unattended provision for a silent lockout. Its write carries an `outcome.message` recording that nothing was changed in Kindoo; the phone renders fixed copy for `cancelled` and never shows it, so the two writers are indistinguishable on screen and differ only in the trail.

**`running → failed` has a second writer: the stranded-job sweep.** A job strands when the tab that claimed it disappears between the claim and the terminal write — browser quit, tab closed, or the terminal write exhausting its three attempts. Nothing else would ever move it: the poller queries only `queued`, and the phone's cancel path is `queued → cancelled`. Every one of the manager's Kindoo tabs therefore runs `findRunningRemoteApplyJobs` on loop start and every 60s and finalises anything whose `claimed_at` (falling back to `created_at`) is older than its threshold. There are **two thresholds, not a site filter**: `REMOTE_APPLY_STRANDED_MS` (5 minutes) for a job whose `target_site_key` this tab could itself have served, `REMOTE_APPLY_STRANDED_OTHER_SITE_MS` (10 minutes) for anything else. Both live in `extension/src/content/remoteApply/loop.ts`, not in `@kindoo/shared`, because only the extension consumes them. A filter would be worse than no filter in both directions: gate absolutely and a job stranded on site B is only cleaned up by a tab on site B, when the likeliest reason it stranded is that the manager closed that very tab; gate not at all and the foreground tab finalises another site's genuinely in-flight work. A swept job takes the ordinary `running → failed` branch with `outcome.code: 'error'`; no rule change and no new code was needed. A tab never sweeps a job it is running itself, and a job with no readable claim time is never swept — age is the only thing distinguishing a dead tab's leftovers from a live sibling's work, since `claimed_by` is not tab-unique. See `architecture.md` D27 (k) / (t) and `spec.md` §16.

Terminal statuses (`applied` / `partial` / `failed` / `cancelled`) are frozen — no rule branch admits a terminal before-status. Jobs are never deleted; at 1–2 requests/week the collection stays trivially small and the trail is useful when a provision misbehaves.

**Written by:** the phone (`useQueueRemoteApplyJob` creates at `queued`; `useCancelRemoteApplyJob` writes `cancelled`) and the extension's service worker (`claimRemoteApplyJob` writes `running`; `finishRemoteApplyJob` writes the terminal status + outcome, retried up to three times but never on `permission-denied`, which means the job already left `running`). Two paths in `content/remoteApply/loop.ts` reach `finishRemoteApplyJob` without having run anything: the stranded sweep's `failed` write, and the poller's `cancelled` write for a job it finds past the pickup window. Neither is retried in place — the next tick still sees the job — so the retry budget stays on the report the desktop actually owes.

**Read by:** the extension — `findQueuedRemoteApplyJobs` (`where('status','==','queued')` + `limit(20)`, one `getDocs` per poll tick) and `findRunningRemoteApplyJobs` (`where('status','==','running')` + `limit(20)`, one `getDocs` a minute per open Kindoo tab). The limit is a ceiling on one read, not a page size — nothing pages past it. The queued query needs the headroom because it is a filter-then-claim: jobs this tab cannot serve sit ahead of ones it can, and a limit that only covered the unservable ones would deadlock the tab that could do the work. The backlog is bounded anyway, since the phone cancels anything nobody claims within 90 seconds. Both queries return `created_at` as epoch ms rather than a `Timestamp` (and `findRunningRemoteApplyJobs` its `claimed_at` likewise, falling back to `created_at`), because the value has to survive `chrome.runtime.sendMessage`'s structured serialisation, which strips the class. **The queued query is deliberately unbounded by age as well as by site.** The poller does not skip a job past the pickup window, it cancels it, so a `where('created_at', '>', …)` bound would hide exactly the documents that need finalising — and would cost a composite index to express.

**Both extension queries drop a job with no `target_site_key`, with a warning.** Such a doc is **frozen, not merely unlabelled**: the update rule's `jobCoreUnchanged` reads `before.target_site_key` bare, a missing-key read errors, and an erroring condition denies — and that helper gates `allow update` ahead of all three transition branches. So the job cannot be claimed, cannot be cancelled by the phone's pickup timeout, and cannot be reported terminal; `allow delete: if false` means no client can clear it either. Console or Admin SDK only. The extension refuses to guess a site for one: a guess buys a doomed claim every poll that `claimRemoteApplyJob` misreports as "already claimed elsewhere", and would provision against the guessed site if the freeze were ever lifted. **Operational consequence: any job doc queued before `target_site_key` existed must be cleared with admin credentials before the current build runs against that environment** — this is real for staging, which ran earlier builds of `feat/remote-apply`. See T-79 for the server-side-writer hazard this creates.

And by the phone — `useRemoteApplyJobsByRequest`, a live subscription to the **whole** subcollection with no `where`, no `orderBy`, and no `limit`, reduced client-side to one job per `request_id`. Both constraints it used to carry are gone deliberately: a status filter would hide the terminal orphan of a duplicate and leave the card reporting a failure on a request that applied, and any `orderBy` / `limit` would drop a just-written job out of the window during exactly the seconds the duplicate guard needs it (an unresolved `serverTimestamp()` reads as null locally and sorts last). One manager's own mailbox at 1–2 requests/week is cheaper to read whole than to filter. See `architecture.md` D27 (n).

**Rules:**

- `read` — owner only, same predicate as the opt-in doc.
- `create` — owner + `isManager(stake_id)` + `status == 'queued'` + **an exact key set** (`request_id`, `stake_id`, `target_site_key`, `status`, `created_at`, `created_by_device`, `lastActor` — `hasOnly` AND `hasAll`, so adding a field to the job doc later requires widening this rule first) + non-empty `request_id` + non-empty `target_site_key` + `lastActorMatchesAuth`. Empty string is rejected for the same reason null would be: it names a site no tab can be inside, so the job would sit unclaimable until the phone timed it out.
- `update` — owner + `lastActorMatchesAuth` + the **five** core fields unchanged (`request_id`, `stake_id`, `target_site_key`, `created_at`, `created_by_device`) + exactly one of the three transition branches above, each with its own `affectedKeys()` allowlist.
- `delete: false`.

**The transitions are the lock.** There is no transaction available on the consuming side — the extension's MV3 service worker can't run `runTransaction` (WebChannel needs `XMLHttpRequest`) — so the compare-and-set lives in the rules, the same technique the request reject / complete rules use. Two Kindoo tabs polling the same mailbox both see `queued` and both fire the claim; the first commits, the second now finds `running` where its branch required `queued` and is denied. `claimRemoteApplyJob` maps that single `permission-denied` to `claimed: false` and the tab skips silently; every other error still throws. The same mechanism settles the timeout-versus-claim race in the other direction — the phone's `cancelled` write swallows `permission-denied` because it means the desktop picked the job up after all.

**Three deliberate gaps in the terminal-write rule, all load-bearing.** `finished_at` / `outcome` / `claimed_at` / `claimed_by` are **typed when present but never required** — a denial on the extension's report-back would strand the job in `running` with the phone spinning forever, a worse failure than a terminal row missing a timestamp. `outcome.code` is checked as `is string`, **not** against the code union above — the union is the desktop's vocabulary and must be able to grow without a rules deploy. And `outcome.over_caps` is checked as a **list of at most 64 entries and no deeper**. Do not tighten any of the three; the governing property is that a conjunct here which can only ever deny buys a stranded job.

Two things about that `over_caps` bound are worth stating so nobody reads it as sloppiness. **The per-entry shape is not expressible at any depth** — rules' CEL has no list iteration, no `all` / `exists`, so there is no way to say "every element is an `OverCapEntry`", and typing `over_caps[0]` alone would error on an empty list while proving nothing about the rest. Entry contents are the desktop's to get right for the same reason `outcome.code` is: a malformed entry renders wrong in the writer's own result dialog and reaches nobody else. **And 64 is a render bound, not a storage one** — `message` sits beside it as an unbounded string, so bytes were never what this block defended; `over_caps` is simply the one field the phone draws a row per element from. Reachable entries are the wards over cap plus the stake pool, so a 12-ward stake tops out at 13, which is what keeps the bound from ever denying a real completion. Not enforced at all: that `over_caps` appears only on `applied`. That is an authoring rule for the single writer rather than a security property — a stray warning on a `partial` misinforms the manager about their own completion and reaches no one else — and pinning it would mean threading the target status into a helper the `queued → cancelled` branch also calls, to gain a conjunct that can only deny. It is documented on `RemoteApplyOutcome` in `packages/shared` instead.

## 4. Per-stake collections

All under `stakes/{stakeId}/`. The parent stake doc holds what was the `Config` tab in the Apps Script app.

### 4.1 `stakes/{stakeId}` — parent doc (Config collapsed in)

**Doc ID:** human-readable slug (`csnorth`, `someother`). Written by `createStake` (`spec.md` §5.4) as `buildingSlug()` of the **Stake ID** the Create Stake form submitted, else of `stake_name` — one rule over whichever source won, so `CS North` lands at `stakes/cs-north` whether it arrived as the ID or as the name. The form's Stake ID field auto-fills from the name and the operator may overwrite it, so an ID rides in the payload on essentially every submit; the two branches agree by construction, since the submitted value is already canonical and `buildingSlug` is idempotent. A supplied value that slugifies to empty soft-fails `invalid_slug` rather than falling back to the name. Fixed at create; `stake_name` is the mutable display name and nothing re-slugs the doc.

**Fields:**

```typescript
{
  // Identity is the doc id (the slug); there is no stored id field.
  stake_name: string;                  // display name
  created_at: Timestamp;
  created_by: string;                  // superadmin canonical email

  // Identity / setup
  bootstrap_admin_email: string;       // stored with case lowercased; dots and `+suffix` preserved (NOT `canonicalEmail()`). The `isBootstrapAdmin` rule below compares against `request.auth.token.email` (Firebase Auth always emits lowercased), so case must match what Auth will hand the rule. Dots and `+suffix` survive because Google itself dedupes those at sign-in to the same identity — preserving them keeps the Gmail escape hatch (dotted local-parts, `+suffix` aliases) usable by operators who actually rely on those address variants.
  setup_complete: boolean;

  // Capacity
  stake_seat_cap: number;              // license total

  // Schedules
  timezone: string;                    // IANA tz, e.g. 'America/Denver'. Consumed only by stake-local time rendering: the Audit Log timestamp display + date-range filter boundaries, and the superadmin stake-list `created_at`. Not a scheduler input — the daily expiry scheduler was retired (`architecture.md` D19).

  // Deprecated (LCR Sheet importer removed — see `architecture.md` D14,
  // `spec.md` §8). New stake docs do not set these fields; existing
  // csnorth values may persist as vestigial state until manually cleared.
  // The implementation PR for the removal strips them from the zod
  // schema; this comment block is the canonical reference for what they
  // meant.
  callings_sheet_id?: string;          // deprecated: Google Sheet ID
  import_day?: 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY' | 'SUNDAY';  // deprecated
  import_hour?: number;                // deprecated: 0–23

  // App access (see `spec.md` §8, `architecture.md` D23, D32)
  // Opt-in. `true` adds Elders Quorum President (exact title only — not the quorum's
  // counselors or secretary) to the WARD *and* BRANCH app-access calling sets for this
  // stake, on identical terms (D32(g)); the STAKE set is never affected. The calling
  // carries the LIMITED tier into either unit kind — `LIMITED_TIER_CALLINGS` is keyed
  // on the name, not the scope. ABSENT ⇒ OFF, so every reader tests `=== true` —
  // deliberately the OPPOSITE defaulting from `notifications_enabled` below (`?? true`).
  // `createStake` writes `false` explicitly on new stakes so the field shows up in the
  // config form and the audit snapshot from day one; stake docs that predate the field
  // read as off. Flipping it is not retroactive — reconciling existing `access` docs is
  // the separate `backfillEqPresidentAccess` callable (§7).
  eq_president_app_access?: boolean;

  // Kindoo Sites — wards to ignore (`spec.md` §15, "Wards to ignore in Kindoo")
  // Ward names that appear in one of this stake's Kindoo sites but belong to a
  // DIFFERENT SBA stake — the reciprocal of the `kindooSites` sub-collection (§4.11):
  // that one records wards of ours living in someone else's Kindoo site, this one
  // records wards of theirs living in one of ours. The extension's Sync strips the
  // description segments naming them, so another stake's members never surface here
  // as `kindoo-only` drift. Operator-typed on Configuration → Kindoo Config; matched
  // case-insensitively against the scope-name portion of a Kindoo description segment,
  // and only ever against segments that did NOT resolve to one of this stake's own
  // wards. ABSENT or empty ⇒ nothing is ignored. Read by the extension only (it
  // already loads the stake doc on every Sync run, which is why this is a field here
  // and not a sub-collection).
  kindoo_ignored_wards?: string[];

  // Notifications
  notifications_enabled: boolean;
  notifications_reply_to?: string;     // optional reply-to address; when unset, EmailService omits the Reply-To header

  // Hidden operator-only escape hatch — there is NO UI for it anywhere; the operator
  // sets it by hand in the Firestore console, and `createStake` never writes it. When
  // it trims to a non-empty value starting `http://` or `https://` it is the base URL
  // for ALL of this stake's email links (all six templates — `spec.md` §9), replacing
  // the `WEB_BASE_URL` function param. Absent, empty, or missing the scheme ⇒ ignored
  // (a rejected value emits a `logger.warn` from `EmailService.resolveBaseUrl`) and the
  // param applies. Exists because the app is dual-hosted, so a stake whose members live
  // on the legacy host can get email links on that host. Email links ONLY — never
  // routing, hosting, or auth domains.
  web_base_url_override?: string;

  // Operational state (`last_over_caps_json` written by request-completion over-cap recomputes; read by manager UI)
  // The `pool: 'stake'` entry's `count` is the home stake count: stake-primary seats
  // plus one per foreign-ward-primary seat carrying a parallel-site `scope:'stake'`
  // duplicate grant (those consume a home Kindoo license). See spec §244 for the
  // full computation; `cap` is the home stake portion-cap (`stake_seat_cap - home-site ward seats`).
  last_over_caps_json: Array<{
    pool: 'stake' | string;            // string = ward_code
    count: number;
    cap: number;
    over_by: number;
  }>;

  // Deprecated (LCR Sheet importer removed — see notes above)
  last_import_at?: Timestamp;          // deprecated
  last_import_summary?: string;        // deprecated
  last_import_triggered_by?: 'manual' | 'weekly';  // deprecated

  // Bookkeeping
  last_modified_at: Timestamp;
  last_modified_by: { email: string; canonical: string };
  lastActor: { email: string; canonical: string };
}
```

**Written by:** `createStake` (doc creation, including `eq_president_app_access: false`); bootstrap wizard (initial); manager via Configuration page (Config tab keys, plus `kindoo_ignored_wards` from the Kindoo Config tab); manager who is also a platform superadmin, via Configuration → Kindoo Config → Home Kindoo Site (`kindoo_expected_site_name` + `kindoo_config`, by dotted path so the wizard's captured `site_name` survives — `spec.md` §15; the superadmin gate there is UI-only, and the superadmin-without-a-manager-role case is T-91); extension configure wizard (`kindoo_config`); `markRequestComplete` / `removeSeatOnRequestComplete` (`last_over_caps_json` after over-cap recompute); operator by hand in the Firestore console (`web_base_url_override` only — it has no writer in the codebase).

**Read by:** every page (stake metadata is in the bootstrap response).

### 4.2 `stakes/{stakeId}/wards/{wardCode}`

**Doc ID:** immutable `ward_code`. On create it is derived from `ward_name` via `buildingSlug()` (`'Maple Ward'` → `'maple-ward'`: lowercase, ASCII alnum + internal hyphens), pinned for the doc's life, and never shown or typed. The slug follows `ward_name` **verbatim** — it is not run through `kindooScopeName()` first — so the same ward stored as `'Maple'` lands at `'maple'` instead. That is deliberate: the code is a foreign key by value and re-deriving it would orphan references. It is never rendered and never matched against Kindoo, so the two forms diverging there costs nothing. Legacy wards retain their original 2-letter codes (e.g. `CO`, matching the old LCR tab name) as immutable doc IDs — those are not regenerated.

**Fields:**

```typescript
{
  ward_code: string;       // = doc.id; buildingSlug(ward_name) at create (legacy 2-letter codes retained), immutable
  ward_name: string;       // The only visible unit identifier; unique by variant set across the stake (see below). Ward OR branch — see below
  building_id?: string;    // Preferred FK to buildings/{building_id} (immutable slug). Optional during the additive transition; new writes always populate it.
  building_name: string;   // Legacy display-name FK + display snapshot. Still required + populated.
  seat_cap: number;
  created_at: Timestamp;
  last_modified_at: Timestamp;
  lastActor: { email: string; canonical: string };
}
```

**Written by:** Bootstrap wizard; manager via Configuration page.
**Read by:** Roster pages (utilization); Sync's `syncApplyFix` (scope resolution); `EmailService` on every notification send (see below).

**`ward_name` → Kindoo scope name.** This collection holds every unit of the stake, ward or **branch**; there is no `unit_type` field and none is planned. The unit's kind, and the scope name Kindoo displays for it, are derived from `ward_name` alone by `packages/shared/src/unitName.ts` (`unitType`, `kindooScopeName`, `kindooScopeNameVariants`) — `architecture.md` D31.

| `ward_name` | `unitType` | Kindoo scope name | resolves from |
|---|---|---|---|
| `Maple` | `ward` | `Maple Ward` | `maple`, `maple ward` |
| `Maple Ward` | `ward` | `Maple Ward` | `maple`, `maple ward` |
| `Peterson Branch` | `branch` | `Peterson Branch` | `peterson branch` |

A ward's trailing `" Ward"` is **optional** and equivalent in both directions: it is appended when writing a Description if absent, and both forms are registered as lookup keys when reading one back. A branch is identified **solely** by its name ending in `" Branch"`; its scope name is verbatim and nothing is appended, because Kindoo never renders `"Peterson Branch Ward"` and the provisioner's strict `!==` description comparison would rewrite the Description on every pass if it did. Suffix matching requires preceding whitespace, so a unit literally named `Ward` or `Branch` is an ordinary name. **Uniqueness is enforced on the variant set, not on the raw `ward_name` and not on the derived scope name:** a create or edit is rejected when `kindooScopeNameVariants(name)` shares any member with an existing unit's (`findUnitNameCollision` / `unitNameCollisionMessage`, `packages/shared/src/unitNameCollision.ts`). That blocks `Maple` against a stored `Maple Ward` — one unit, suffix optional — and also a branch `Olive Branch` against a ward `Olive Branch Ward`, whose canonical names differ but which both claim the key `olive branch`. Intersection is exactly the invariant the lookup map needs, since a contested key makes one of the two units unresolvable. B-20.

**Every email send reads this collection.** All six notification emails (`spec.md` §9) render ward display names, never raw ward codes, so each send issues one `stakes/{stakeId}/wards` collection read through `loadScopeLabeller` in `functions/src/services/EmailService.ts`, which returns a `scopeLabel(scope, wards)` resolver. One read labels any number of scopes — the over-cap email labels every flagged pool from it. That is one read per send for `notifyOnRequestWrite` (submit / complete / reject / cancel), `notifyOnOverCap`, and `notifyOnAccessGranted`; the two manager-bound request emails batch it concurrently with their `resolveRequesterLabel` reads. Unresolved codes fall back to the raw code, so a ward deleted out from under a pending request degrades to the code rather than failing the send.

**Ward → building FK is id-first.** A ward references its building two ways during the additive transition. `building_id` — the immutable building slug — is the **preferred** FK; `building_name` is the **legacy** display-name FK, still required and kept populated. Resolution is **id-first with a name fallback**: `resolveWardBuilding(ward, buildings)` in `packages/shared` matches `building.building_id` when `ward.building_id` is set, and falls back to matching `building.building_name` otherwise (a stale slug that matches nothing also falls through to the name path). Un-migrated wards (id absent) keep resolving via the name fallback, so the change is safe against stale browser bundles and the migration window. `buildingNameById(buildings, building_id)` renders a slug FK as the building's current display name. A one-time operator-run backfill populated `building_id` from `building_name` (since completed; the script has been removed); `building_name` stays for now and dropping it from wards is a deliberate later follow-up.

**No `kindoo_site_id` on the ward.** A ward does **not** store its Kindoo site. The site is **derived from the ward's assigned building** (`null` / absent on the building = home — §4.11), via `resolveWardSite(ward, buildings)` in `packages/shared` — id-first, layered on `resolveWardBuilding` (and the `wardSiteMap` helper in `functions/src/lib/wardSites.ts` for the server consumers — `syncApplyFix`, `markRequestComplete`, over-cap calc). Both helpers take the `buildings` array directly; the old pre-built `buildingsByName` Map form is gone. The building is the single source of a ward's site; an unknown building resolves to home.

### 4.3 `stakes/{stakeId}/buildings/{buildingId}`

**Doc ID:** URL-safe slug derived from `building_name` (e.g. `Maple Building` → `maple-building`). **Immutable post-create.** The slug (`= building_id = doc.id`) is derived once on create and is the doc ID every ward / seat reference is keyed on. Building **edit** carries the original `building_id` through unchanged and writes the same doc — it never re-derives the slug from a renamed building. (Re-slugging on rename was the core defect: it wrote a new doc and orphaned the old one plus every reference keyed on the original slug.) The display name, address, and `kindoo_site_id` are mutable on the frozen slug; only the slug is locked.

**Fields:**

```typescript
{
  building_id: string;     // = doc.id (slug) — immutable post-create
  building_name: string;   // display form — mutable; unique across the stake (enforced by the Buildings UI)
  address: string;
  kindoo_site_id?: string | null;  // §4.11 — `null` / absent = home site
  created_at: Timestamp;
  last_modified_at: Timestamp;
  lastActor: { email: string; canonical: string };
}
```

**Written by:** Bootstrap wizard; manager via Configuration page.
**Read by:** Wards (FK), seat building_names defaults.

**Unique display name.** The Buildings UI enforces a unique, case-insensitive, trimmed `building_name` across the stake (`duplicateBuildingNameBlocker` in `apps/web/src/features/manager/configuration/hooks.ts`, with the live buildings snapshot passed by the caller). Since the display name decoupled from the slug on edit, two buildings could otherwise share a name and make the wards' legacy `building_name` FK (and every grant-array display name) ambiguous. This is a client-side guard only — Firestore rules can't iterate the sibling collection.

**`kindoo_site_id`** identifies the Kindoo site that physically governs this building. `null` / absent means home site; a string value points at a doc ID under `stakes/{stakeId}/kindooSites/`. A foreign-site building is one whose physical access doors are managed by a different stake's Kindoo environment than the SBA stake's home site, even though the building hosts SBA-stake wards. The building is also the **source of a ward's site**: a ward inherits this value from its assigned building (referenced id-first by `ward.building_id`, name-fallback by `ward.building_name`; §4.2). Phase 1 of the Kindoo Sites feature stored the value only; downstream phases (request-form filters, extension orchestrator enforcement, sync filtering) consume it.

### 4.4 `stakes/{stakeId}/kindooManagers/{canonicalEmail}`

Manager allow-list. Doc existence + `active=true` defines the manager set.

**Doc ID:** canonical email.

**Fields:**

```typescript
{
  member_canonical: string;    // = doc.id
  member_email: string;        // typed form
  name: string;
  active: boolean;
  added_at: Timestamp;
  added_by: { email: string; canonical: string };
  lastActor: { email: string; canonical: string };
}
```

**Written by:** Bootstrap wizard (auto-adds bootstrap admin); manager via Configuration page.
**Read by:** `syncManagersClaims` trigger; manager list reads; the requester-label derivation on the manager Queue, the extension card, and `EmailService.resolveRequesterLabel` (§4.7 — a manager-submitted request has no `access` row to name its requester).

### 4.5 `stakes/{stakeId}/access/{canonicalEmail}`

Per-user role-grant doc. Doc exists iff the user has *any* Sync-managed or manual access. The split between `importer_callings` and `manual_grants` is the field-level split-ownership boundary that rules enforce. The `importer_callings` field name is historical (predates the LCR Sheet importer removal — see `architecture.md` D14, `spec.md` §3); rename is out of scope.

**Doc ID:** canonical email.

**Fields:**

```typescript
{
  member_canonical: string;    // = doc.id
  member_email: string;        // typed form
  member_name: string;

  // Sync-managed (Admin SDK via `syncApplyFix`; field name is historical — see
  // `architecture.md` D14). Keys = scope ('stake' or ward_code). Values = the
  // subset of that scope's callings that are on the churchwide app-access list
  // (`filterAppAccessCallings(scope, callings)` — D17). THREE lists, not two: which
  // one a non-stake scope is measured against depends on whether the unit is a ward
  // or a BRANCH, passed as `AppAccessOptions.unitType` and derived from the unit's
  // `ward_name` — never from the scope key, which is a slug (D31(e), D32(c)). Absent
  // ⇒ ward. A branch scope's array therefore holds branch titles (Branch President,
  // Branch Presidency First / Second Counselor, Branch Clerk) and never a ward one.
  // A ward or branch scope's array may also carry 'Elders Quorum President' when the
  // stake's `eq_president_app_access` is on (§4.1, D23) — written either by a Sync fix
  // or by the `backfillEqPresidentAccess` callable (§7). The stake scope never does.
  importer_callings: {
    [scope: string]: string[];
  };

  // Access tier for the calling-derived grants above (D26). Same scope keys;
  // each value is the SUBSET of `importer_callings[scope]` that confers
  // LIMITED access, stored verbatim in the casing of the entries it names.
  // ABSENT field / absent scope key / empty array => every importer calling in
  // that scope is FULL. Server-only, stamped in the same write as
  // `importer_callings`; rules block every client write path.
  importer_limited_callings?: {
    [scope: string]: string[];
  };

  // Manager-managed. Keys = scope. Values = explicit manual grants.
  manual_grants: {
    [scope: string]: Array<{
      grant_id: string;        // uuid; lets a manager unambiguously delete one entry
      reason: string;          // free-text; the "calling" column on today's manual rows
      level?: 'limited';       // access tier (D25). ABSENT => full. Never written 'full'.
      granted_by: { email: string; canonical: string };
      granted_at: Timestamp;
    }>;
  };

  // Doc-level sort key. MIN canonical `callingSortOrder` priority across every
  // (scope, calling) pair in `importer_callings`. `null` for manual-only access
  // docs (no `importer_callings`).
  sort_order: number | null;

  created_at: Timestamp;
  last_modified_at: Timestamp;
  last_modified_by: { email: string; canonical: string };
  lastActor: { email: string; canonical: string };
}
```

**Written by:** Sync's `syncApplyFix` callable (writes / updates `importer_callings` entries from `filterAppAccessCallings(scope, callings)` — the subset of the seat's callings on the churchwide app-access list for the scope's unit kind, D17 / D32, plus the stake-gated Elders Quorum President unit calling when `stake.eq_president_app_access` is on, D23; on `sba-only` Remove From SBA and `type-mismatch` demote, *reaps* the removed scope's `importer_callings[scope]` via `clearImporterCallingsForScope`, preserving `manual_grants` and deleting the doc only when both maps go empty — Admin SDK, bypasses rules); manager Access page (`manual_grants` only). The `callings-mismatch` fix REPLACES the auto seat's `callings[]` with Kindoo's full parsed set and reconciles the scope's `importer_callings` in **either direction** — `writeAccessForAutoScope` when `filterAppAccessCallings(scope, newCallings)` still yields a grant, else `clearImporterCallingsForScope` (a replace can REMOVE access, not just add it). The `kindoo-unparseable` fix (auto seat forced to stake scope) reaps the OLD scope's `importer_callings[scope]` and then writes a fresh `importer_callings['stake'] = [calling]` **iff** `calling` is on the hard-coded **stake** app-access list — so a bare app-access calling (e.g. `Stake Clerk`) keeps stake-scope app access rather than silently losing it; a calling off the list earns no new entry (old scope still reaped). It does this in one coherent write (`writeStakeScopeAccessForUnparseable`, `tx.update` not `set merge` so the cleared old scope can't linger), deleting the doc only when the final `importer_callings` and `manual_grants` are both empty. Every one of those paths also stamps `importer_limited_callings[scope]` from `filterLimitedTierCallings(callings)` in the same write (D26, below), so a scope's callings and its tiers can never be written out of step. That forced `writeAccessForAutoScope`'s existing-doc branch from `tx.set(…, {merge: true})` to `tx.update`: a merge deep-merges nested maps key by key, so a scope that lost its last limited-tier calling would have kept the old stamp and left the member reading limited on the strength of a calling they no longer hold. The two sibling helpers already used `update`.

**Each of those write paths must know the scope's unit kind before it picks a calling set (D32(d)).** `applyKindooOnly` gets it from the same snapshot it already reads to resolve the seat's Kindoo site, so site and kind can never disagree; `applyCallingsMismatch` and `applyTypeMismatch`'s promote branch each take one extra `tx.get` on `stakes/{stakeId}/wards/{scope}`, unit scopes only, because `seat.scope` does not exist until the in-transaction seat read. **A unit doc that is missing or carries no usable `ward_name` is treated as a ward**, with a structured warning — per D31(f), a branch is a ward in every respect but the scope string and a handful of calling names, so ward is right for nearly every unit and matches the behaviour that predates branch support. `applyKindooUnparseable` is stake-literal (`filterAppAccessCallings('stake', …)`), where `unitType` is ignored, so it reads no unit doc. Manual and temp seats derive no app access and keep the pre-existing missing-unit tolerance.

The `backfillEqPresidentAccess` callable (§7, D23) is the second Admin-SDK writer. It reconciles existing docs after a stake flips `eq_president_app_access`, adding or removing **only** the Elders Quorum President entry inside `importer_callings[scope]` for auto ward-scope seats holding that calling — a merge, never `writeAccessForAutoScope`'s wholesale replace, so unrelated entries in the same scope survive. `manual_grants` is never read-modified, and revoke deletes the doc only when `importer_callings` empties **and** no manual grants remain (a manual-grants-only doc is never deleted). Grant stamps `importer_limited_callings[scope]` for the entry it inserts and skips a scope that already carries the calling (so it re-tiers nobody — see D26); revoke removes the calling from both maps. `sort_order` is handled asymmetrically, deliberately: grant keeps the lower of the doc's prior value and the Elders Quorum President order (`pickMin`), following `writeAccessForAutoScope`'s precedent, while revoke re-derives from `seatCallingOrder()` over everything left in `importer_callings` — a removal can strand the stored value on a calling the member no longer holds. That is stricter than `clearImporterCallingsForScope`, which leaves the prior value in place.

**Access tier — `manual_grants[].level` (D25).** The tier marker is **manager-written and manual-grants-only**. The App Access page's "Add manual access" modal offers a Full / Limited `<select>`; Limited writes `level: 'limited'`, Full writes **no key at all**. Never `'full'` — grant deletion is an `arrayRemove` on the stored object, which matches by deep equality, so a grant carrying a stray `level: 'full'` would not match what the UI hands back and would be undeletable. There is no edit-level affordance: re-tiering a person means deleting the grant and re-adding it. The page **displays** the tier on every row regardless — Full as a subtle `info` badge, Limited as a loud red uppercase one — in the Scope column of the table and beside each grant in the card view, so an absent marker can never be confused with a failure to render (`spec.md` §5.3).

**Access tier — `importer_limited_callings` (D26).** Calling-derived grants carry their tier as **stored data**, written when the record is written. `importer_limited_callings[scope]` names the subset of `importer_callings[scope]` that confers limited access; absent field, absent scope key, or empty array all mean every importer calling in that scope is full. **Elders Quorum President is the only calling in the writer-side set** (`LIMITED_TIER_CALLINGS` / `filterLimitedTierCallings`, `packages/shared/src/appAccessCallings.ts`), and it only reaches an access doc at all when the stake's `eq_president_app_access` is on (§4.1, D23) — at a ward or a branch scope alike, since the set is keyed on the calling name rather than the scope (D32(g)). The constant is consulted **only on write paths** — `syncApplyFix`'s three access helpers stamp the field in the same write as `importer_callings` so the two cannot drift, and `backfillEqPresidentAccess` stamps an entry it inserts. Nothing classifies a calling by name at read time: `scopesFromAccessDoc` and the App Access page both read the stored field, and `isLimitedAccessCalling()` / `LIMITED_ACCESS_CALLINGS` are gone. That is the point of storing it — `syncAccessClaims` fires only on access-doc writes, so a name-based classifier would let the page label someone LIMITED while their minted claim still said full.

Malformed stamp data reads as **full**, the same fail-toward-more-access rule `manual_grants[].level` follows: a non-array value, a non-string entry, or a name that does not appear in the scope's `importer_callings` all leave the calling full-tier. A stale stamp can never keep a doc alive either — the doc-existence test in both the rules' delete predicate and the server helpers still reads only `importer_callings` and `manual_grants`.

**Rules.** D25's marker needed no rules change — `manual_grants` already sits in the access-update `affectedKeys()` allowlist, so a grant with an extra `level` key rides the existing predicate. D26's stamp did: `importer_limited_callings` must be **absent** on a manager create, **byte-equal** on a manager update (compared via `.get(…, {})` on both sides so records predating the field compare cleanly), and it is **not** in the `affectedKeys()` allowlist. A manager who could write the field could clear their own stamp and promote themselves from limited to full at the next claim mint. See §6.

**Read by:** `syncAccessClaims` trigger and `notifyOnAccessGranted` trigger (both via `scopesFromAccessDoc`, which folds the two grant maps into `{hasStake, wards, limited}`, taking each importer calling's tier from `importer_limited_callings`); manager Access page.

**Triggers on this path.** Three Cloud Functions watch `stakes/{stakeId}/access/{memberCanonical}` (§7): `syncAccessClaims` re-mints the member's custom claims, `auditAccessWrites` (the parameterized `auditTrigger`'s access binding) fans the audit row, and `notifyOnAccessGranted` sends the app-access welcome email (`spec.md` §9) on the **no-scopes → at-least-one-scope** transition, computed by `scopesFromAccessDoc` over `importer_callings` and `manual_grants` together. The welcome email hangs off the document rather than off `syncApplyFix` / `backfillEqPresidentAccess` because the document is the only hook that sees every grant path — including the manager Access page's raw client write to `manual_grants`, which goes through no callable. The email's **fire condition** reads only `hasStake` / `wards`, so a **limited** grant (D25) is a grant like any other: a first limited grant welcomes the member exactly as a full one does. The **copy** does read `limited`. Having decided to send, the trigger folds `scopesFromAccessDoc(after).limited` with a direct read of `stakes/{stakeId}/kindooManagers/{memberCanonical}` (batched into its stake-doc read) through the shared `isLimitedTier` / `isActiveManagerDoc` — the same helpers `computeStakeClaims` uses (§2) — and a limited recipient's subject and opening sentence read "temporary building access" where a full recipient's read "building access". That one word is the whole difference; the links are the same for both tiers (`spec.md` §9).

**Invariants:**
- Sync's `syncApplyFix` never mutates `manual_grants` (rules enforce on client side; the callable enforces on Admin SDK side).
- `manual_grants[].level` is either absent or the literal `'limited'`. Every other value — including `'full'` — reads as full access, by design: malformed data must fail toward more access, not less.
- Manager never mutates `importer_callings` or `importer_limited_callings` (rules enforce).
- `importer_limited_callings[scope]` is always a subset of `importer_callings[scope]`, written in the same transaction. A name in the tier map with no matching calling reads as nothing at all.
- Doc deletion only when the two **grant** maps are empty. `importer_limited_callings` is never part of that test.
- Composite-key uniqueness on (canonical_email, scope, calling) is *structurally absent* — the Sync-managed side's scope is `importer_callings[scope]: string[]`; the manual side's scope is `manual_grants[scope]: Array`. No path for them to collide.

### 4.6 `stakes/{stakeId}/seats/{canonicalEmail}`

Per-user Kindoo seat. One doc per user per stake.

The `duplicate_grants[]` field captures both within-site priority losers (informational; not counted in utilization) and parallel-site grants — legitimate independent grants on other Kindoo sites that need their own per-site write. The two kinds are distinguished by `kindoo_site_id` equality with the primary grant: same site → within-site; different site → parallel-site. See spec §15 "Multi-site grants — data model" for the full semantics.

`duplicate_scopes: string[]` is a server-maintained primitive mirror of `duplicate_grants[].scope` — Firestore CEL has no `[*].field` projection over an array of objects, so rules that need to ask "is this scope in the seat's duplicate set" use `scope in duplicate_scopes`. Clients never write this field; every server-side seat writer (Sync's `syncApplyFix`, `markRequestComplete`, `removeSeatOnRequestComplete`, migration) keeps it in sync with `duplicate_grants[]`. T-42 / T-43.

**Doc ID:** canonical email.

**Fields:**

```typescript
{
  // Identity
  member_canonical: string;    // = doc.id
  member_email: string;
  member_name: string;

  // Primary grant — the "real" seat that counts in utilization
  scope: string;               // 'stake' or ward_code
  type: 'auto' | 'manual' | 'temp';
  callings: string[];          // auto only; ≥1 entry. Empty array for manual/temp.
  reason?: string;             // manual/temp
  start_date?: string;         // temp only, ISO date (YYYY-MM-DD)
  end_date?: string;           // temp only, ISO date
  building_names: string[];
  kindoo_site_id?: string | null; // T-42. null / absent ⇒ home site; otherwise doc ID under kindooSites/. Mirrors the building convention. Derived from primary scope + ward → BUILDING → kindoo_site_id (resolveWardSite / wardSiteMap); stake-scope ⇒ home. Every server seat-writer stamps it per this convention (syncApplyFix kindoo-only / scope-mismatch, markRequestComplete new-seat). A write-time invariant (assertSeatSiteStamped, functions/src/lib/wardSites.ts) refuses to persist a known foreign-ward seat field-absent — it throws rather than mis-classifying as home; it does not fire for stake-scope / home-ward / unknown-ward. Pre-migration seats may have the field absent — the ward-fallback resolver handles classification at read time.
  organization_id?: string | null; // Org slug FK for the PRIMARY grant (§4.12). Meaningful only on stake-scope grants; null / absent ⇒ "No Organization". Set by the inline roster chip (direct client write — the sole client seat-update path; see §6 seats.update) and by markRequestComplete on stake-scope add/edit completion. Cleared by syncApplyFix when a seat moves off stake scope (applyScopeMismatch → ward).
  sort_order: number | null;   // vestigial — still stamped by syncApplyFix, NOT read by the web (render-time calling-order sort). See "Sort order" below.

  // Manual/temp linkage
  granted_by_request?: string; // request_id; absent for auto seats

  // Within-site priority losers (informational; never counted in utilization) and
  // parallel-site grants (legitimate independent grants on other Kindoo sites that
  // need their own per-site write). Distinguished by kindoo_site_id equality with
  // the primary grant — no separate flag. T-42.
  duplicate_grants: Array<{
    scope: string;
    type: 'auto' | 'manual' | 'temp';
    callings?: string[];
    reason?: string;
    start_date?: string;
    end_date?: string;
    building_names?: string[];      // Within-site Sync-written duplicates may leave this unset and inherit from the primary's ward. Sync-written PARALLEL-SITE duplicates (different kindoo_site_id from the primary) MUST set this — the per-site Kindoo write needs the buildings explicitly. Manual/temp duplicates set this via the request-completion auto-merge.
    kindoo_site_id?: string | null; // T-42. Same convention as the top-level field.
    organization_id?: string | null; // Org slug FK for THIS duplicate grant (§4.12). Meaningful only on stake-scope grants; null / absent ⇒ "No Organization". Set by markRequestComplete's auto-merge / edit path when the merge target is a duplicate. The roster chip on a parallel-site stake duplicate is read-only — its org is set via the request form, not inline.
    detected_at: Timestamp;
  }>;
  // T-42 / T-43: denormalised mirror of `duplicate_grants[].scope` for Firestore
  // CEL rules predicates. Server-maintained; clients never write it. Always set
  // by every server seat writer, even when empty.
  duplicate_scopes?: string[];

  created_at: Timestamp;
  last_modified_at: Timestamp;
  last_modified_by: { email: string; canonical: string };
  lastActor: { email: string; canonical: string };
}
```

**Written by:** Sync's `syncApplyFix` callable (auto seats — Admin SDK, bypasses rules; also removes orphaned temp seats via its `sba-only` path once Kindoo expires them); manager via request completion (manual/temp). The **one** client direct-write path is the inline organization edit on the Stake Roster (`useSetSeatOrganization`) — any stake member may set / clear `organization_id` on a `scope == 'stake'` seat, gated by the `seats.update` rule's 4-key allowlist (§6, §4.12, `architecture.md` D21). Every other seat field is request-only — All Seats is view-only for edits; seat edits flow through the `edit_*` request → completion path. See `spec.md` §6.

**Read by:** All roster pages (bishopric, stake, all-seats), manager dashboard, manager queue (for duplicate-warning), audit log entity-history view.

**Invariants:**
- Doc ID = `member_canonical`.
- Sync applies priority `stake > ward (alphabetical)` deterministically; first-seen wins among manager-driven writes.
- `scopes_with_access` is **not** stored — `scope` (singular) is what utilization reads.
- Auto seats have `callings.length >= 1` and `type='auto'`. Removing the last calling deletes the seat (or promotes a manual/temp duplicate to primary, see Sync's `syncApplyFix` logic).
- Manual/temp seats have `granted_by_request` set; auto seats do not.

**Sort order:** The denormalized `sort_order` field is **no longer read by the web** (Sync Stage 1a — see `extension/docs/sync-design.md` "Grant-derived seat type" part (a)). Roster / All Seats sort is computed **at render time** from a compiled churchwide `calling → order` table (`packages/shared/src/callingSortOrder.ts`; 85 entries — stake callings 1–42, ward 43–85; exact trimmed case-insensitive match, no wildcards):
- **Auto seats:** order = **MIN** of the table order across the seat's `callings[]`.
- **Manual seats:** order = the table order of the free-text `seat.reason` (manual seats carry `callings: []` and store the calling in `reason` — see §6.1/spec). No match ⇒ unknown.
- **Temp seats:** not calling-ordered — sorted by `end_date` descending (soonest-expiring at the band bottom).
- **Unknown** (no calling/reason match) within the auto / manual bands ⇒ band bottom, then `created_at` ascending (oldest first), then `member_name`.

The `sort_order` field itself is retained on the doc and is still stamped by `syncApplyFix` from the **same** canonical table — `seatCallingOrder(callings)` (the MIN priority across `callings[]`) for auto; `null` for manual / temp / orphaned auto — vestigial; the client ignores it. There is no longer any `sheet_order` template field: the access-doc `sort_order` (§4.5) is also derived from `callingSortOrder`, and the Access page sorts by that doc-level value.

### 4.7 `stakes/{stakeId}/requests/{requestId}`

Request lifecycle docs. Still UUID-keyed because a member can have many requests over time.

**Doc ID:** UUID (Firestore-auto-generated).

**Fields:**

```typescript
{
  request_id: string;          // = doc.id
  type: 'add_manual' | 'add_temp' | 'remove' | 'edit_auto' | 'edit_manual' | 'edit_temp';
  scope: string;               // 'stake' or ward_code

  member_email: string;
  member_canonical: string;
  member_name: string;

  reason: string;              // free-text on submit; edit_manual / edit_temp carry the replacement reason
  comment: string;
  urgent: boolean;             // requester flag; defaults false. Renders to the user as the "Emergency" label/badge (field name unchanged). Client gates the comment-required UX on it.
  start_date?: string;         // add_temp / edit_temp
  end_date?: string;           // add_temp / edit_temp
  building_names: string[];    // requester's selection: stake-scope add types AND every edit type (carries the post-edit set)
  organization_id?: string | null; // Org slug FK (§4.12). Optional; the stake-scope-only org selector on add_manual / add_temp / edit_manual / edit_temp supplies it. null / absent ⇒ "No Organization". Carried onto the seat on completion (markRequestComplete). The submit hook writes it only for stake-scope add/edit types — ward-scope and remove / edit_auto never carry one.

  status: 'pending' | 'complete' | 'rejected' | 'cancelled';

  requester_email: string;
  requester_canonical: string;
  requested_at: Timestamp;

  completer_email?: string;
  completer_canonical?: string;
  completed_at?: Timestamp;
  rejection_reason?: string;
  completion_note?: string;    // R-1 race: "Seat already removed at completion time (no-op)."

  // For remove requests, denormalized at submit time so completion can find the seat
  // without a query (Firestore client transactions can't run queries).
  seat_member_canonical?: string;  // remove only — same as member_canonical, kept for clarity

  lastActor: { email: string; canonical: string };
}
```

**Written by:** Requester (submit, cancel); manager (complete, reject).
**Read by:** Manager queue, MyRequests, dashboard pending counts, audit log entity-history view.

**Invariants:**
- `pending` is the only legal starting status; terminal statuses (`complete`, `rejected`, `cancelled`) are one-way flips.
- Only the original requester can cancel; only managers can complete or reject.
- For `remove`, server-side guards (rules + client tx): no pending-pending duplicate for same (scope, member); no remove against a non-existent manual/temp seat (the latter caught by client tx, not rules).
- `urgent` is set at create time (rules validate `urgent is bool`) and immutable thereafter — the cancel/complete/reject `affectedKeys()` allowlists exclude it.
- Edit types (`edit_auto`, `edit_manual`, `edit_temp`) — see [`spec.md`](spec.md) §6.1. `edit_auto` is forbidden at `scope == 'stake'` (Policy 1) at three layers: web UI, rules, and the `markRequestComplete` callable. `edit_temp` carries `start_date` + `end_date` with the same ISO YYYY-MM-DD + start <= end shape as `add_temp`. All three edit types require a non-empty `comment` at creation time, enforced by the shared zod schema, the Firestore rule, and the web form.
- A Kindoo Manager may create a request in **any** scope — the stake and every ward — for every type, with no `access` row of their own (§6 create rule, [`spec.md`](spec.md) §6.1, `architecture.md` D24, PR #240). Manager authority is blanket, not an intersection with claim-derived scopes: a manager who also holds a Bishopric claim may submit for wards outside that claim. Platform superadmin status alone grants nothing. Policy 1 (`edit_auto` forbidden at `scope == 'stake'`) is an independent conjunct and binds managers too.
- The manager queue, extension card, and manager notification emails display the requester as `{Name} ({Calling})`, **live-derived** from the requester's `access/{requester_canonical}` doc (§4.5) for the request's `scope`, with the requester's `kindooManagers/{requester_canonical}` doc (§4.4) as backstop for both fields — name when `access` has none, and the literal calling `"Kindoo Manager"` when no calling resolves for the scope. Only an `active === true` manager doc contributes; `access` wins on each field independently. The request stores only `requester_email` / `requester_canonical` — no requester name or calling is captured on this doc. See [`spec.md`](spec.md) §5.3 / §9 / §15.

### 4.8 `wardCallingTemplates` / `stakeCallingTemplates` — REMOVED

These two per-stake calling-template collections, their Configuration tabs, and the `give_app_access` / `auto_kindoo_access` / `sheet_order` template fields were removed (PR #192, D17). App access is now granted from a churchwide calling list (`packages/shared/src/appAccessCallings.ts`), not from per-stake template rows — see §4.5, `spec.md` §8, and D17. The one per-stake app-access control that survives is the boolean `stake.eq_president_app_access` (§4.1, D23), which gates a single unit calling at ward and branch scopes alike; it is a gate on the fixed lists, not a return of per-stake calling rows. The lists themselves are three — stake, ward, branch — chosen by `AppAccessOptions.unitType` (D32), which is churchwide and not per-stake config. Seat / access `sort_order` and roster ordering use the canonical churchwide `callingSortOrder` table, not template `sheet_order`. The `callingTemplate` shared type + zod schemas, `functions/src/lib/parser.ts`, the template audit triggers, and the extension's template classifier are deleted. No collection occupies §4.8 / §4.9 any more; the numbering is preserved so §4.10 / §4.11 cross-references stay stable. Orphaned template docs left in existing stakes are a post-merge cleanup (T-65).

### 4.9 *(unused — see §4.8)*

### 4.10 `stakes/{stakeId}/auditLog/{auditId}`

Flat audit collection. One row per write to seats, requests, access, kindooManagers, or stake parent doc.

**Doc ID:** `<ISO-timestamp>_<uuid-suffix>` — sortable by ID for newest-first reads.

**Fields:**

```typescript
{
  audit_id: string;            // = doc.id
  timestamp: Timestamp;
  actor_email: string;         // automated actor ('RemoveTrigger', 'OutOfBand', 'Migration', a 'SyncActor:<code>' stamp) or a typed user email.
                               // Legacy 'Importer' rows remain in the audit log from the pre-Sync era
                               // (see `architecture.md` D14); no fresh code path writes that value.
  actor_canonical: string;     // canonical form of actor_email; same value for automated actors
  action:
    | 'create_seat' | 'update_seat' | 'delete_seat'
    | 'create_access' | 'update_access' | 'delete_access'
    | 'create_request' | 'submit_request' | 'complete_request' | 'reject_request' | 'cancel_request'
    | 'create_manager' | 'update_manager' | 'delete_manager'
    | 'create_stake' | 'update_stake' | 'setup_complete'
    | 'import_start' | 'import_end' | 'over_cap_warning' | 'email_send_failed';

  entity_type: 'seat' | 'request' | 'access' | 'kindooManager' | 'stake' | 'system';
  entity_id: string;           // canonical email for seat/access/manager; UUID for request; slug (doc id) for stake
  member_canonical?: string;   // denormalized; cross-collection per-user filter

  before: object | null;
  after: object | null;

  ttl: Timestamp;              // 365 days from write time; Firestore TTL deletes automatically
}
```

**Written by:** Cloud Function audit triggers (one per audited collection or one parameterized).
**Read by:** Manager Audit Log page.

**Invariants:**
- `auditId` is deterministic from `(collection, docId, writeTime)` so trigger retries are idempotent.
- `member_canonical` is set whenever the underlying doc has a `member_canonical` field; absent for system actions (`import_start`, `import_end`, `over_cap_warning`, `setup_complete`, `email_send_failed`).
- Firestore TTL policy on the `ttl` field deletes rows ~24h after their `ttl` timestamp passes.
- `create_stake` fires only on the parent-doc create path (`before==null`, `entity_type='stake'`, `collection='stake'`). Sub-entity creates under `stakes/{sid}/` (wards, buildings, kindooSites, organizations) audit as `entity_type='stake'` with action `update_stake` per the existing `CREATE_ACTION` table in `auditTrigger.ts` — the parent-doc-only branch keeps the `'create_stake'` action unambiguous for audit consumers (Phase 12.3 / F19). Organizations carry a structured `entity_id='organization:<slug>'` (§4.12).

### 4.11 `stakes/{stakeId}/kindooSites/{kindooSiteId}`

Multi-Kindoo-site management for a single SBA stake. A doc here represents a **foreign** Kindoo site this stake's kindooManagers can write to — i.e. a Kindoo environment that is not the SBA stake's own home site. The home site lives on the parent stake doc; there is no `KindooSite` document for it.

**Doc ID:** manager-chosen slug (e.g. `east-stake`, `foreign-1`).

**Fields:**

```typescript
{
  id: string;                          // = doc.id
  display_name: string;                // human-readable label (e.g. 'East Stake (Pine Building)')
  kindoo_expected_site_name: string;   // matches the site-name string Kindoo's admin UI surfaces;
                                       //   the extension's active-session validation compares this
                                       //   against the live Kindoo session's site name
  kindoo_eid?: number | null;          // Kindoo environment ID — the extension matches
                                       //   `localStorage.state.sites.ids[0]` against this.
                                       //   Populated by the extension at first use on a
                                       //   session logged into the site; the manager UI does
                                       //   not expose this field.
  created_at: Timestamp;
  last_modified_at: Timestamp;
  lastActor: { email: string; canonical: string };
}
```

**Written by:** Manager via the Configuration page (Phase 1 ships data model + Configuration UI only; no behavioural consumers yet).
**Read by:** Configuration page (list + edit); downstream phases — Phase 2 request-form filters, Phase 3 extension orchestrator's active-session validation, Phase 4 sync filtering.

**Invariants:**
- The home site has NO `KindooSite` document. Its identity lives on the stake doc (`stake.kindoo_config.site_id` / `kindoo_config.site_name`, plus the optional `kindoo_expected_site_name` override). A `null` / absent `kindoo_site_id` on a building means home; a ward inherits its site from its building (§4.2).
- Only **buildings** carry `kindoo_site_id`. A ward does not store one — its site is derived from its assigned building (`resolveWardSite` / `wardSiteMap`; §4.2).
- Authority gating uses the existing per-stake `kindooManagers` allow-list. The SBA stake remains a single SBA stake; foreign-site management does NOT create a new role or multi-stake principal.
- Field-level referential integrity (a building's `kindoo_site_id` actually existing here) is the UI's concern; rules gate WHO can write, not field-level FK checks.
- **Delete guard.** The Configuration page blocks deleting a Kindoo Site while any **building** still references it (`kindooSiteDeleteBlocker` in `apps/web/src/features/manager/configuration/hooks.ts`). Wards are covered **transitively**: a ward's site comes from its building, so the building guard also protects every ward on that site — there is no separate ward FK check. Rules gate WHO can delete, not this field-level FK; the guard is client-side.
- Writes to this collection are audited by `auditKindooSiteWrites` (entity_type=`stake`, entity_id=`kindooSite:<slug>`) and reconciled by the nightly `reconcileAuditGaps` job.

### 4.12 `stakes/{stakeId}/organizations/{orgId}`

Stake-scope seat pools. An organization is a named pool with its own seat cap that stake managers track alongside wards / buildings; seats and stake-scope requests reference one by its immutable slug id. The home stake pool itself is not an organization — `null` / absent `organization_id` on a grant means "No Organization."

**Doc ID:** immutable slug derived from `name` via `buildingSlug()` (`Primary Children` → `primary-children`). Frozen at create; organization **edit** carries the original slug through and writes the same doc, never re-slugging a renamed org — so renames never orphan a seat / request reference.

**Fields:**

```typescript
{
  organization_id: string;     // = doc.id; immutable slug
  name: string;                // display name; resolved from organization_id at render time
  seat_cap: number;            // per-org seat cap; surfaced as a display-only utilization bar (never blocks)

  created_at: Timestamp;
  last_modified_at: Timestamp;
  lastActor: { email: string; canonical: string };
}
```

**Written by:** Manager via the Configuration → Organizations tab (`useUpsertOrganizationMutation` / `useDeleteOrganizationMutation`, `apps/web/src/features/manager/configuration/hooks.ts`).
**Read by:** Configuration → Organizations tab (list + edit); the New Request / Edit Seat forms (the optional stake-scope org selector); the Stake Roster (org chip id → name + the per-organization utilization bars).

**Invariants:**
- `organization_id` is meaningful only on stake-scope grants. A seat / request at ward scope never carries one; `null` / absent = "No Organization." Seats carry it on the primary grant (`seat.organization_id`) and on each `duplicate_grants[]` entry; requests carry it as `request.organization_id` (§4.6 / §4.7).
- The slug is the immutable doc id; **renames resolve id → name at render time** (`organizationName(orgs, id)` in `apps/web/src/features/organizations/hooks.ts`). This is the deliberate departure from the `building_names` display-name-snapshot arrays — orgs are referenced by slug, so a rename needs no reference cascade and no rename-time ref-guard (contrast §4.3 buildings; `architecture.md` D21).
- **Unique display name.** The Configuration tab blocks a save (create or edit) when another org already uses the chosen name, case-insensitive + trimmed (`duplicateOrganizationNameBlocker`). The name is the human key seats / requests render by, so two orgs must not share one. Client-side only — rules can't iterate the sibling collection.
- **Delete guard.** The Configuration tab blocks deleting an org while any **seat** references it via its primary `organization_id` OR any `duplicate_grants[].organization_id` (`organizationDeleteBlocker`, run against the live seats snapshot — seat-only by design; a pending request referencing a deleted org is an accepted gap, the seat resolves to "No Organization" and the operator reassigns). Client-side only, same reasoning as the Kindoo-site / building guards.
- **`seat_cap` is display-only.** It drives the per-org utilization bar's ok / warn (≥90%) / over coloring on the Stake Roster but never blocks a write — there is no over-cap enforcement for organizations.
- Writes to this collection are audited by `auditOrganizationWrites` (entity_type=`stake`, entity_id=`organization:<slug>`) and reconciled by the nightly `reconcileAuditGaps` job (§7).

## 5. Indexes

### 5.1 Firestore composite indexes

Single-field indexes on scalar fields are auto-created. The composite indexes below need to be declared in `firestore.indexes.json`.

**`auditLog` (per stake — path-scoped, so no `stakeId` field needed in the index):**

```
(timestamp DESC)                            — default chronological view
(action ASC, timestamp DESC)                — filter by action
(entity_type ASC, timestamp DESC)           — filter by entity type
(entity_id ASC, timestamp DESC)             — filter to one entity's history
(actor_canonical ASC, timestamp DESC)       — filter by actor
(member_canonical ASC, timestamp DESC)      — cross-collection per-user view
```

Combinations beyond these (e.g. `action AND entity_type AND date range`) Firestore will request as needed via console-link errors during development.

**`requests`:**

```
(status ASC, requested_at ASC)              — manager queue (pending FIFO)
(status ASC, completed_at DESC)             — manager queue (resolved newest-first)
(requester_canonical ASC, requested_at DESC) — MyRequests
(scope ASC, status ASC, requested_at ASC)   — manager queue scoped by ward
```

**`seats`:** single-field on `scope` covers most queries. No composite needed at this scale.

**`access`, `kindooManagers`, `wards`, `buildings`, `kindooSites`, `organizations`:** small enough to load fully and filter client-side. No composite indexes.

**`remoteApply` and its two subcollections: no composite index, deliberately — and still none after the per-site reshape.** The extension's two job queries filter on a single field and order by nothing — `where('status','==','queued')` + `limit(20)` for the poller, `where('status','==','running')` + `limit(20)` for the stranded sweep — and are served by the automatic index. **Site routing added no index**, because it is applied client-side after the read rather than as a second `where`: the poller reads a page of `queued` jobs and picks the first its own site can serve. Ordering the queued query by `created_at` alongside the status equality *would* need a composite index, which is why it isn't ordered — document-id order is arbitrary but deterministic, and at this scale the query returns nought or one document anyway. The phone's job subscription is unconstrained (§3.4 explains why the filter and the ordering were both removed), and its `desktops` subscription reads the whole collection with no `where` at all. Both parent-level docs are read by path. If a future query adds a second field or an `orderBy`, it needs an entry in `firestore.indexes.json` — nothing here does today (§3.4).

### 5.2 Firestore TTL policy

Configured once via `gcloud`:

```bash
gcloud firestore fields ttls update ttl \
  --collection-group=auditLog \
  --enable-ttl
```

Optionally also on `platformAuditLog` if retention there matters.

## 6. Firestore Security Rules

Full rules. Lives in `firestore.rules`.

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ===== Helpers =====

    function isAuthed() {
      return request.auth != null;
    }

    function authedCanonical() {
      // Trustworthy: set by sync triggers as a custom claim.
      return request.auth.token.canonical;
    }

    function isManager(stakeId) {
      return isAuthed()
        && 'stakes' in request.auth.token
        && stakeId in request.auth.token.stakes
        && request.auth.token.stakes[stakeId].manager == true;
    }

    function isStakeMember(stakeId) {
      return isAuthed()
        && 'stakes' in request.auth.token
        && stakeId in request.auth.token.stakes
        && request.auth.token.stakes[stakeId].stake == true;
    }

    function bishopricWardOf(stakeId) {
      return isAuthed()
        && 'stakes' in request.auth.token
        && stakeId in request.auth.token.stakes
          ? request.auth.token.stakes[stakeId].wards
          : [];
    }

    function isAnyMember(stakeId) {
      return isManager(stakeId) || isStakeMember(stakeId) || bishopricWardOf(stakeId).size() > 0;
    }

    // Limited app access (D25). The `'limited' in ...` presence guard is
    // load-bearing: the claim minter omits the key for full users rather
    // than writing `false`, so a bare field read would error on every
    // full user's write. Absent => full.
    function isLimited(stakeId) {
      return isAuthed()
        && 'stakes' in request.auth.token
        && stakeId in request.auth.token.stakes
        && 'limited' in request.auth.token.stakes[stakeId]
        && request.auth.token.stakes[stakeId].limited == true;
    }

    function isPlatformSuperadmin() {
      return isAuthed() && request.auth.token.isPlatformSuperadmin == true;
    }

    // Bootstrap-wizard escape hatch — see §6.1 "Bootstrap-admin gate".
    // Unblocks the Phase 7 wizard's chicken-and-egg first writes
    // (the bootstrap admin's auto-self-add to kindooManagers, before
    // syncManagersClaims has minted them a manager claim).
    function isBootstrapAdmin(stakeId) {
      let stakePath = /databases/$(database)/documents/stakes/$(stakeId);
      return isAuthed()
        && exists(stakePath)
        && get(stakePath).data.setup_complete == false
        && get(stakePath).data.bootstrap_admin_email == request.auth.token.email;
    }

    function lastActorMatchesAuth(data) {
      return data.lastActor.canonical == authedCanonical()
        && data.lastActor.email == request.auth.token.email;
    }

    // ===== Top-level collections =====

    match /userIndex/{canonicalEmail} {
      allow read: if isAuthed() && resource.data.uid == request.auth.uid;
      allow write: if false;
    }

    match /platformSuperadmins/{canonicalEmail} {
      allow read: if isPlatformSuperadmin();
      allow write: if false;
    }

    match /platformAuditLog/{auditId} {
      allow read: if isPlatformSuperadmin();
      allow write: if false;
    }

    // ----- RemoteApply (phone → desktop-extension mailbox; D27, §3.4) -----
    // Top-level because the doc key is the manager's canonical email and the
    // stake is a FIELD — the desktop resolves its own stake from whichever
    // Kindoo site it is in. Ownership is therefore the anchor on every rule,
    // and `isManager(<the doc's stake_id>)` is the second gate on `desktops`
    // and `jobs` so a signed-in non-manager can't register a desktop or queue
    // work under a stake they don't manage.
    //
    // Presence is keyed by Kindoo SITE: the parent doc is the profile-wide
    // opt-in alone, liveness lives in `desktops/{siteKey}`, and a job names
    // the site that may claim it.
    match /remoteApply/{memberCanonical} {

      function ownsMailbox(owner) {
        return isAuthed() && authedCanonical() == owner;
      }

      // Rules' List API has hasAll / hasOnly but no hasExactly.
      function keysAreExactly(data, fields) {
        return data.keys().hasOnly(fields) && data.keys().hasAll(fields);
      }

      // Three keys and only three. `remote_apply_enabled` is the only
      // optional one: absent ⇒ opted out. NOTE for the extension: hasOnly
      // sees the MERGED result, so a `{merge: true}` write over a doc still
      // carrying the retired per-site keys is DENIED — write it whole.
      function validPresence(data) {
        return data.keys().hasOnly(['remote_apply_enabled', 'ext_version', 'lastActor'])
          && data.keys().hasAll(['ext_version', 'lastActor'])
          && (!('remote_apply_enabled' in data) || data.remote_apply_enabled is bool)
          && data.ext_version is string
          // Length bound, not a format check. Load-bearing: it is what
          // replaces the isManager gate this doc no longer has.
          && data.ext_version.size() <= 32;
      }

      allow read: if ownsMailbox(memberCanonical);
      // Create and update share a predicate: the extension rewrites the whole
      // doc on every heartbeat. NO isManager gate — rules can't ask "manager
      // of ANY stake", and re-adding a `stake_id` purely as a gate anchor
      // would reintroduce the field that flapped between sites. The exact key
      // set plus the ext_version cap bound the doc instead.
      allow create, update: if ownsMailbox(memberCanonical)
        && validPresence(request.resource.data)
        && lastActorMatchesAuth(request.resource.data);
      // Opting out clears the flag; it never deletes the doc.
      allow delete: if false;

      // ----- desktops/{siteKey} — one live Kindoo tab, one Kindoo site -----
      // Doc id is the tab's site KEY (`remoteApplySiteKey`), the same value a
      // job carries as `target_site_key`. Not constrained here: proving it
      // names a real kindooSites doc would cost a read per heartbeat, and the
      // home site has no such doc at all.
      match /desktops/{siteKey} {

        // Every key required, three nullable. The rule deliberately does NOT
        // check `kindoo_site_id` against `siteKey` — the relation is
        // `remoteApplySiteKey` (null ↔ 'home'), which rules can't express
        // without pinning a shared constant in a second place.
        function validDesktop(data) {
          return keysAreExactly(data, ['stake_id', 'kindoo_site_id', 'last_seen_at',
                                       'kindoo_eid', 'kindoo_site_name', 'ext_version',
                                       'lastActor'])
            && data.stake_id is string
            && (data.kindoo_site_id == null || data.kindoo_site_id is string)
            && data.last_seen_at is timestamp
            && (data.kindoo_eid == null || data.kindoo_eid is int)
            && (data.kindoo_site_name == null || data.kindoo_site_name is string)
            && data.ext_version is string;
        }

        allow read: if ownsMailbox(memberCanonical);

        // Two tabs on two sites BOTH succeed — that is the point of keying
        // by site. This is the doc that makes the phone's button appear, so
        // it is the one that proves the writer manages the stake.
        allow create, update: if ownsMailbox(memberCanonical)
          && isManager(request.resource.data.stake_id)
          && validDesktop(request.resource.data)
          && lastActorMatchesAuth(request.resource.data);

        // Deletion allowed on ownership alone. A closing tab retracts its own
        // presence immediately rather than leaving the phone naming a site as
        // covered for a full staleness window. NOT gated on isManager: a
        // manager whose claim was just revoked must still be able to retract
        // presence they published while they held it.
        allow delete: if ownsMailbox(memberCanonical);
      }

      match /jobs/{jobId} {

        // Set once by the phone, never moved. The per-transition allowlists
        // below already exclude these; this states the invariant directly.
        // `target_site_key` matters most: a mutable one would let a tab
        // retarget work to itself and provision on the wrong Kindoo site.
        function jobCoreUnchanged(before, after) {
          return after.request_id == before.request_id
            && after.stake_id == before.stake_id
            && after.target_site_key == before.target_site_key
            && after.created_at == before.created_at
            && after.created_by_device == before.created_by_device;
        }

        // Terminal-write shape. `finished_at` / `outcome` are typed when
        // present but NOT required — a denial here would strand the job in
        // `running` and leave the phone spinning forever. `outcome.code` is
        // checked as a string, not against the RemoteApplyOutcomeCode union,
        // so the desktop's vocabulary can grow without a rules deploy.
        // `over_caps` is a list and no deeper: CEL cannot iterate, and 64 is
        // a render bound (one phone row per element), not a storage one.
        function validFinish(data) {
          return (!('finished_at' in data) || data.finished_at is timestamp)
            && (!('outcome' in data)
                || (data.outcome.keys()
                      .hasOnly(['code', 'message', 'kindoo_uid', 'provisioning_note',
                                'over_caps'])
                    && data.outcome.code is string
                    && data.outcome.message is string
                    && (!('over_caps' in data.outcome)
                        || (data.outcome.over_caps is list
                            && data.outcome.over_caps.size() <= 64))));
        }

        allow read: if ownsMailbox(memberCanonical);

        // Born `queued`, carrying exactly the seven fields the phone knows at
        // tap time. Exact key set, not a minimum — adding a field to the job
        // doc requires widening this rule first.
        //
        // IF YOU ARE WRITING A CLOUD FUNCTION THAT QUEUES JOBS: stamp
        // `target_site_key` yourself. Admin SDK writes bypass this rule, and
        // a job without the key is permanently stuck — `jobCoreUnchanged`
        // reads it bare, a missing-key read errors, and every transition is
        // denied. `allow delete: if false` means no client can clear it. See
        // T-79.
        allow create: if ownsMailbox(memberCanonical)
          && isManager(request.resource.data.stake_id)
          && request.resource.data.status == 'queued'
          && keysAreExactly(request.resource.data,
                            ['request_id', 'stake_id', 'target_site_key', 'status',
                             'created_at', 'created_by_device', 'lastActor'])
          && request.resource.data.request_id is string
          && request.resource.data.request_id.size() > 0
          && request.resource.data.stake_id is string
          && request.resource.data.target_site_key is string
          && request.resource.data.target_site_key.size() > 0
          && request.resource.data.created_at is timestamp
          && request.resource.data.created_by_device is string
          && lastActorMatchesAuth(request.resource.data);

        // The status transitions ARE the lock — no runTransaction is
        // available in an MV3 service worker. Each branch pins the BEFORE
        // status, which is what resolves the two-tab claim race and freezes
        // a job once it reaches a terminal status.
        allow update: if ownsMailbox(memberCanonical)
          && lastActorMatchesAuth(request.resource.data)
          && jobCoreUnchanged(resource.data, request.resource.data)
          && (
            // queued → running — a Kindoo tab claiming the job.
            (resource.data.status == 'queued'
             && request.resource.data.status == 'running'
             && request.resource.data.diff(resource.data).affectedKeys()
                .hasOnly(['status', 'claimed_at', 'claimed_by', 'lastActor'])
             && (!('claimed_at' in request.resource.data)
                 || request.resource.data.claimed_at is timestamp)
             && (!('claimed_by' in request.resource.data)
                 || request.resource.data.claimed_by.ext_version is string))
            ||
            // queued → cancelled — the 90s pickup timeout, written by the
            // phone's own timer or by the desktop poller that outlives it.
            (resource.data.status == 'queued'
             && request.resource.data.status == 'cancelled'
             && request.resource.data.diff(resource.data).affectedKeys()
                .hasOnly(['status', 'finished_at', 'outcome', 'lastActor'])
             && validFinish(request.resource.data))
            ||
            // running → terminal — the extension reporting back. `partial` is
            // a distinct outcome, not a failure: Kindoo took the write and
            // markRequestComplete did not.
            (resource.data.status == 'running'
             && request.resource.data.status in ['applied', 'partial', 'failed']
             && request.resource.data.diff(resource.data).affectedKeys()
                .hasOnly(['status', 'finished_at', 'outcome', 'lastActor'])
             && validFinish(request.resource.data))
          );

        // Jobs are history.
        allow delete: if false;
      }
    }

    // ===== Per-stake collections =====

    match /stakes/{stakeId} {

      // Parent stake doc — `isBootstrapAdmin` lets the wizard write Step 1 fields
      // and the final `setup_complete=true` flip before the manager claim is minted.
      // `isPlatformSuperadmin()` lets the Stake List page (`/superadmin/stakes`)
      // read every stake's parent doc, including the zero-role first-run case
      // where the superadmin holds no per-stake role on any stake.
      // Note: `update` carries NO per-field allowlist — a manager (or the bootstrap
      // admin pre-setup) may write any stake-doc field. Adding a config field such as
      // `eq_president_app_access` (§4.1, D23) or `web_base_url_override` (§4.1)
      // therefore needs no rules change.
      allow read: if isAnyMember(stakeId) || isBootstrapAdmin(stakeId)
        || isSetupInProgressReadable(stakeId)
        || isPlatformSuperadmin();
      allow create: if isPlatformSuperadmin();
      allow update: if (isManager(stakeId) || isBootstrapAdmin(stakeId))
        && lastActorMatchesAuth(request.resource.data);
      allow delete: if false;

      // ----- Wards -----
      match /wards/{wardCode} {
        allow read: if isAnyMember(stakeId) || isBootstrapAdmin(stakeId);
        allow write: if (isManager(stakeId) || isBootstrapAdmin(stakeId))
          && lastActorMatchesAuth(request.resource.data);
      }

      // ----- Buildings -----
      match /buildings/{buildingId} {
        allow read: if isAnyMember(stakeId) || isBootstrapAdmin(stakeId);
        allow write: if (isManager(stakeId) || isBootstrapAdmin(stakeId))
          && lastActorMatchesAuth(request.resource.data);
      }

      // ----- KindooSites (§4.11) -----
      // Manager-only writes; any stake member can read. Same gating
      // pattern as kindooManagers — authority
      // over which Kindoo environments this stake can target is a
      // stake-level configuration concern. Existing csnorth
      // `kindooManagers` allow-list governs all Kindoo writes
      // regardless of which Kindoo site they target; this rule does
      // not introduce a new role.
      match /kindooSites/{kindooSiteId} {
        allow read: if isAnyMember(stakeId);
        allow create, update: if isManager(stakeId)
          && lastActorMatchesAuth(request.resource.data);
        allow delete: if isManager(stakeId);
      }

      // ----- Organizations -----
      // Stake-scope seat pools (§4.12). Mirrors kindooSites' gating:
      // any member reads (the org list feeds the No-Organization picker
      // and the roster chip's id→name resolution), managers write with
      // the lastActor integrity check. Small unfiltered collection — no
      // index needed.
      match /organizations/{organizationId} {
        allow read: if isAnyMember(stakeId);
        allow create, update: if isManager(stakeId)
          && lastActorMatchesAuth(request.resource.data);
        allow delete: if isManager(stakeId);
      }

      // ----- KindooManagers -----
      // The bootstrap-admin gate breaks the chicken-and-egg: wizard's first action
      // is adding the bootstrap admin to this collection, which fires
      // `syncManagersClaims` and mints the manager claim.
      match /kindooManagers/{memberCanonical} {
        allow read: if isManager(stakeId) || isBootstrapAdmin(stakeId);
        allow write: if (isManager(stakeId) || isBootstrapAdmin(stakeId))
          && lastActorMatchesAuth(request.resource.data);
      }

      // ----- Access (split-ownership) -----
      match /access/{memberCanonical} {
        allow read: if isManager(stakeId);

        // Manager creates a manual-only access doc (no importer rows yet,
        // so no tier stamp either)
        allow create: if isManager(stakeId)
          && memberCanonical == request.resource.data.member_canonical
          && request.resource.data.importer_callings == {}
          && !('importer_limited_callings' in request.resource.data)
          && request.resource.data.manual_grants.size() > 0
          && lastActorMatchesAuth(request.resource.data);

        // Manager edits manual_grants only — importer_callings and its tier
        // stamp are immutable from clients
        allow update: if isManager(stakeId)
          && request.resource.data.member_canonical == resource.data.member_canonical
          && request.resource.data.importer_callings == resource.data.importer_callings
          && request.resource.data.get('importer_limited_callings', {})
             == resource.data.get('importer_limited_callings', {})
          && request.resource.data.diff(resource.data).affectedKeys()
             .hasOnly(['manual_grants', 'last_modified_by', 'last_modified_at', 'lastActor'])
          && lastActorMatchesAuth(request.resource.data);

        // Manager deletes a now-empty access doc (importer side cleared, last manual grant removed)
        allow delete: if isManager(stakeId)
          && resource.data.importer_callings == {}
          && resource.data.manual_grants == {};
      }

      // ----- Seats -----
      match /seats/{memberCanonical} {
        allow read: if isManager(stakeId)
          || (resource.data.scope == 'stake' && isStakeMember(stakeId))
          || (resource.data.scope in bishopricWardOf(stakeId));

        // Manager creates a manual/temp seat as part of completing a request.
        // The cross-doc invariant (this seat's existence is justified by a request flipping
        // to status=complete in the same write) is verified via getAfter().
        allow create: if isManager(stakeId)
          && memberCanonical == request.resource.data.member_canonical
          && request.resource.data.type in ['manual', 'temp']
          && request.resource.data.duplicate_grants.size() == 0
          && request.resource.data.callings.size() == 0
          && lastActorMatchesAuth(request.resource.data)
          && tiedToRequestCompletion(stakeId,
                                     request.resource.data.granted_by_request,
                                     request.resource.data.scope,
                                     memberCanonical,
                                     request.resource.data.type);

        // Updates: the ONLY client-writable seat mutation is the inline
        // organization edit — a stake member may set / clear
        // `organization_id` on a `scope == 'stake'` seat, bypassing the
        // request flow (organizations are a stake-scope concept; §4.12,
        // `architecture.md` D21). The `affectedKeys().hasOnly([...])`
        // allowlist matches the web inline-edit mutation EXACTLY (those 4
        // keys, nothing else), so a hand-crafted write can't smuggle other
        // field changes through this path. Every OTHER seat mutation stays
        // server-side via the Admin SDK — request-completion
        // (`markRequestComplete`), removal (`removeSeatOnRequestComplete`),
        // import-sync callables — all of which bypass rules. Editing any
        // other seat field is request-only (an `edit_*` request completed by
        // the callable). T-66 removed the formerly-orphaned manager
        // direct-update allowlist.
        allow update: if isStakeMember(stakeId)
          && resource.data.scope == 'stake'
          && request.resource.data.diff(resource.data).affectedKeys()
               .hasOnly(['organization_id', 'last_modified_at', 'last_modified_by', 'lastActor'])
          && lastActorMatchesAuth(request.resource.data);

        // Direct delete from manager UI — only when no collisions remain.
        // The remove-request flow handles deletion via a Cloud Function (Admin SDK bypass) instead,
        // because Firestore's `delete` rule has no access to request.resource.data fields.
        allow delete: if isManager(stakeId)
          && resource.data.type in ['manual', 'temp']
          && resource.data.duplicate_grants.size() == 0;
      }

      function tiedToRequestCompletion(sid, requestId, expectedScope, expectedMember, expectedSeatType) {
        let reqBefore = get(/databases/$(database)/documents/stakes/$(sid)/requests/$(requestId));
        let reqAfter  = getAfter(/databases/$(database)/documents/stakes/$(sid)/requests/$(requestId));
        return reqBefore.data.status == 'pending'
          && reqAfter.data.status == 'complete'
          && reqAfter.data.scope == expectedScope
          && reqAfter.data.member_canonical == expectedMember
          && (
            (expectedSeatType == 'manual' && reqAfter.data.type == 'add_manual')
            || (expectedSeatType == 'temp' && reqAfter.data.type == 'add_temp')
          );
      }

      // ----- Limited-app-access helpers (D25) -----
      // Reached only from the `requests` create predicate, and only when
      // `isLimited(stakeId)` is true — full users pay no extra reads.

      // Inclusive of both endpoints: exactly 90 days passes, 91 does not.
      // Safe to split / int() unguarded — the ISO-shape and
      // `start_date <= end_date` conjuncts short-circuit ahead of this.
      function tempWindowWithin90Days(data) {
        let s = data.start_date.split('-');
        let e = data.end_date.split('-');
        return timestamp.date(int(e[0]), int(e[1]), int(e[2]))
             - timestamp.date(int(s[0]), int(s[1]), int(s[2]))
            <= duration.value(90, 'd');
      }

      // "The ward's building", resolved id-first with a raw-name
      // fallback — the rules-side mirror of `resolveWardBuilding`.
      // Reading `ward.building_name` directly would demand a STALE name
      // whenever a building was renamed while no seat / pending request
      // pinned it (`buildingRenameBlocker` never checks `wards` — T-74).
      // The ternary short-circuits, so a dangling `building_id` falls
      // through to the name path rather than erroring the predicate;
      // `Map.get(key, default)` avoids an error on an absent key.
      function limitedWardBuildingName(sid, scope) {
        let ward = get(/databases/$(database)/documents/stakes/$(sid)/wards/$(scope)).data;
        let bid = ward.get('building_id', '');
        return bid is string
            && bid.size() > 0
            && exists(/databases/$(database)/documents/stakes/$(sid)/buildings/$(bid))
          ? get(/databases/$(database)/documents/stakes/$(sid)/buildings/$(bid)).data.get('building_name', '')
          : ward.get('building_name', '');
      }

      // Exact one-element equality — no cross-building grants, no
      // supersets. Fails closed: a missing ward doc denies; an
      // unresolvable building yields '' and fails the size guard.
      function limitedWardBuildingOk(sid, data) {
        let name = limitedWardBuildingName(sid, data.scope);
        return name is string && name.size() > 0 && data.building_names == [name];
      }

      // A limited user may only remove TEMP seats. `get()` rather than
      // `exists()` because we need the seat's `type` VALUE. The
      // `seat_member_canonical` guards come first so a request omitting
      // the field denies on a legible predicate instead of an opaque
      // path-construction error.
      function limitedRemoveTargetIsTemp(sid, data) {
        return 'seat_member_canonical' in data
          && data.seat_member_canonical is string
          && data.seat_member_canonical.size() > 0
          && get(/databases/$(database)/documents/stakes/$(sid)/seats/$(data.seat_member_canonical)).data.type == 'temp';
      }

      // Same gate for `edit_temp`, but keyed on `member_canonical` —
      // edit requests target that seat, removals target
      // `seat_member_canonical`.
      function limitedEditTargetIsTemp(sid, data) {
        return 'member_canonical' in data
          && data.member_canonical is string
          && data.member_canonical.size() > 0
          && get(/databases/$(database)/documents/stakes/$(sid)/seats/$(data.member_canonical)).data.type == 'temp';
      }

      // ----- Requests -----
      match /requests/{requestId} {
        allow read: if isAuthed() && (
          isManager(stakeId)
          || resource.data.requester_canonical == authedCanonical()
          || (resource.data.scope == 'stake' && isStakeMember(stakeId))
          || (resource.data.scope in bishopricWardOf(stakeId))
        );

        // Submit
        allow create: if isAuthed()
          && request.resource.data.status == 'pending'
          && request.resource.data.requester_canonical == authedCanonical()
          && request.resource.data.requested_at == request.time
          && lastActorMatchesAuth(request.resource.data)
          && (request.resource.data.type == 'remove'
              || request.resource.data.member_name.size() > 0)
          && (request.resource.data.type == 'remove'
              || request.resource.data.scope != 'stake'
              || request.resource.data.building_names.size() > 0)
          // Role-for-scope gate. Any one branch authorises:
          //   - Kindoo Manager → every scope, every type, no `access`
          //     row required
          //   - scope == 'stake' → caller holds `stake: true`
          //   - scope == <ward>  → caller's `wards` includes that code
          // `scope` is deliberately not checked against the wards
          // collection — see D24.
          && (
               isManager(stakeId)
            || (request.resource.data.scope == 'stake' && isStakeMember(stakeId))
            || (request.resource.data.scope in bishopricWardOf(stakeId))
          )
          // Limited app access (D25). Narrows the surface for a caller
          // carrying `stakes[stakeId].limited`; short-circuits for
          // everyone else, so a full user pays for none of the reads.
          // LAST conjunct on purpose — the ISO-shape and
          // `start_date <= end_date` gates above have already run, so
          // `tempWindowWithin90Days` splits well-formed dates.
          && (
            !isLimited(stakeId)
            || (
                 request.resource.data.type in ['add_temp', 'edit_temp', 'remove']
              && (request.resource.data.type != 'remove'
                  || limitedRemoveTargetIsTemp(stakeId, request.resource.data))
              && (request.resource.data.type != 'edit_temp'
                  || limitedEditTargetIsTemp(stakeId, request.resource.data))
              && (request.resource.data.type == 'remove'
                  || (
                       tempWindowWithin90Days(request.resource.data)
                    && (request.resource.data.scope == 'stake'
                        || limitedWardBuildingOk(stakeId, request.resource.data))
                  ))
            )
          );

        // State transition: pending → {complete, rejected, cancelled}
        allow update: if resource.data.status == 'pending'
          && lastActorMatchesAuth(request.resource.data)
          && (
            // Cancel — only the original requester
            (request.resource.data.status == 'cancelled'
             && resource.data.requester_canonical == authedCanonical())
            ||
            // Complete — only managers
            (request.resource.data.status == 'complete'
             && isManager(stakeId)
             && request.resource.data.completer_canonical == authedCanonical())
            ||
            // Reject — only managers, with non-empty reason
            (request.resource.data.status == 'rejected'
             && isManager(stakeId)
             && request.resource.data.rejection_reason.size() > 0
             && request.resource.data.completer_canonical == authedCanonical())
          );

        allow delete: if false;
      }

      // ----- AuditLog -----
      match /auditLog/{auditId} {
        allow read: if isManager(stakeId);
        allow write: if false;  // server-only via audit trigger
      }
    }
  }
}
```

### 6.1 Notes on the rules

- **`getAfter()` use is bounded** — only on the `seats.create` rule's cross-doc check against requests. Every other rule is local to its document.
- **`lastActorMatchesAuth` is the integrity check** — every client write must carry a `lastActor` field whose `email` matches the auth token's typed email AND whose `canonical` matches the token's canonical claim. This is what gives the audit trigger a trustworthy `actor_email` to write.
- **No client writes to auto seats** — auto seats are written only by the `syncApplyFix` callable via Admin SDK, which bypasses rules. The rules' `seats.create` only allows `type in ['manual', 'temp']`.
- **No client writes to importer_callings or its tier stamp** — same pattern. `access.update` rules verify both `importer_callings` and `importer_limited_callings` are unchanged on every client write, and `access.create` requires the stamp absent. Neither is in the update `affectedKeys()` allowlist (§4.5, D26).
- **Cross-stake denial is automatic** — `isAnyMember(stakeId)` returns false when the user has no claims for that stakeId, so reads are denied at the stake-doc level and inherit through.
- **Admin SDK writes bypass everything** — the Cloud Functions (audit triggers, claim sync, request-completion callables) operate via the Admin SDK; rules don't fire. The discipline lives in those functions' code.
- **Requests-create role-for-scope gate** — the submit predicate admits any of three branches: `isManager(stakeId)` (every scope, every type, no `access` row required), `stake: true` for `scope == 'stake'`, or the ward code in the caller's `wards` for ward scopes. The SPA's `isScopeAllowed` / `allowedScopesFor` (`apps/web/src/features/requests/scopeOptions.ts`) is the user-visible mirror; this rule is the defense-in-depth layer. Two properties are load-bearing. **(a) Manager authority is blanket.** It is not intersected with the caller's claim-derived scopes, so a manager who also holds a Bishopric claim may submit for wards outside it. **(b) Platform superadmin status alone grants nothing** — only the per-stake manager claim does, which is a deliberate divergence from the nav model's superadmin-as-manager treatment. The manager branch widens WHO may create, never WHAT the payload must carry: every other create conjunct — non-empty `member_name` for add types, non-empty `building_names` for stake-scope add/edit types, the required `comment` on edit types, and Policy 1's `edit_auto`-not-at-stake — still binds a manager submit. This reverses the B-3 / T-36 hardening (PR #52) and subsumes the `add_manual` stake carve-out it had been punctured with (PR #223). See `architecture.md` D24 and PR #240.
- **The create rule does not verify the ward code exists** — a manager can write a `scope` naming a ward absent from the `wards` collection. Admitting it avoids an `exists()` read on every submit; it is an accepted data-quality gap for a trusted role, not an escalation (D24).
- **Requests-create limited-access clause** — the last conjunct of the create predicate narrows the submit surface for a caller carrying `stakes[stakeId].limited` (§2, D25): `type in ['add_temp','edit_temp','remove']`; `remove` and `edit_temp` each only against a seat whose `type == 'temp'` (keyed on `seat_member_canonical` and `member_canonical` respectively — the two request families identify their target seat differently); temp windows ≤ 90 days end-to-start; and ward-scope temp requests locked to exactly that ward's own building. Stake scope keeps the free building choice — there is no single ward to lock to. Three properties are load-bearing. **(a) It is a narrowing, not a branch.** The clause is `&&`-ed onto the predicate, so a limited caller must still satisfy the role-for-scope gate above; the flag authorises nothing by itself. **(b) Full users pay nothing.** `!isLimited(stakeId)` short-circuits the whole clause, so neither the ward/building reads nor the seat read execute for them. **(c) Position matters.** It is last so the ISO-shape and `start_date <= end_date` gates have already run, which is what makes the unguarded `split()` / `int()` inside `tempWindowWithin90Days` safe. Enforcement is **creation-time only** — deliberately no `markRequestComplete` third layer, unlike Policy 1 (`spec.md` §6.1). The ward lock resolves the building id-first with a raw-name fallback; the whole clause costs at most 4 of the 10 document accesses a single-document request allows (ward `get`, building `exists`, building `get`, plus the seat `get` on a ward-scope `edit_temp`). The SPA mirrors every clause (`scopeOptions.ts`, `schemas.ts`, `NewRequestForm`, `EditSeatDialog`) and is stricter in one place — `canRemoveSeat` also requires the specific grant row to be temp, which a rules `get()` cannot cheaply prove. See `architecture.md` D25 and `spec.md` §4 / §6.1.
- **No `access` rules change was needed for the tier marker** — `manual_grants` is already in the access `update` `affectedKeys()` allowlist and the `create` predicate only counts entries, so a grant object carrying an extra `level` key rides the existing rule (§4.5).
- **`remoteApply` is the only place a status transition substitutes for a transaction on the *client* side** — the request `reject` / `complete` rules use the same pin-the-before-status technique, but there a transaction was available and merely redundant. Here the consumer is an MV3 service worker where `runTransaction` throws at runtime, so the rule is the entire concurrency control. Three properties are load-bearing and should survive any edit. **(a) Every branch pins `resource.data.status`,** which is what makes a lost claim race a clean `permission-denied` rather than a double-provision, and what freezes a terminal job. **(b) The terminal fields are typed, not required** — requiring them would convert a malformed report-back into a denial, which the extension cannot retry its way out of (`permission-denied` is precisely the error it must not retry), leaving the job to be swept as stranded five minutes later and reported to the manager as "didn't finish" rather than as whatever actually happened. A terminal row missing a timestamp is the cheaper failure. **(c) `outcome.code` is `is string`, not a union match** — the codes are the desktop extension's vocabulary and it ships through Chrome Web Store review on its own cadence; pinning them here would mean a rules deploy is a prerequisite for an extension release. `outcome.over_caps` follows (c)'s logic and adds a mechanical limit of its own: rules' CEL cannot iterate a list, so `is list` plus a size cap is the deepest check expressible, and the cap is sized as a render bound (one phone row per element) rather than a storage one. **A branch is not the writer's identity.** `queued → cancelled` is written by the phone's timer *and* by a desktop poller expiring a job it found stale; both are the mailbox owner, and the rule neither can nor should tell them apart. See §3.4 and `architecture.md` D27.
- **The `remoteApply` subcollection write predicates carry `isManager` as well as ownership; the parent doc's does not.** Ownership alone would let any signed-in user write arbitrary documents under `remoteApply/{their own email}`, since the doc key is their own email — so `desktops` and `jobs` both require the manager claim for the `stake_id` in the document being written. The conjunct reads the claim only (no `get()`), so it costs nothing on the heartbeat path. The **parent doc lost that gate deliberately** when `stake_id` moved down to `desktops`: rules cannot ask "is this user a manager of *any* stake" (the `stakes` claim is a map with no way to test a predicate across its values), and keeping a `stake_id` up there purely as a gate anchor would reintroduce the field that flapped between sites on every heartbeat. **What replaces it is the exact three-key shape plus `ext_version.size() <= 32`** — that cap is the storage bound, not a format check, and removing it as cosmetic would reopen the hole. The doc grants nothing on its own: the phone requires a fresh `desktops` doc before it offers any button.

- **A `remoteApply` job with no `target_site_key` is frozen, not merely malformed.** `jobCoreUnchanged` reads `before.target_site_key` bare; a missing-key read errors, an erroring condition denies, and that helper gates `allow update` ahead of all three transition branches — so the job can't be claimed, can't be cancelled by either pickup-timeout writer, and can't be reported terminal, while `allow delete: if false` blocks any client from clearing it. Unreachable today only because every writer of that collection is a client gated by the create rule. See §3.4 and T-79.

#### Bootstrap-admin gate

The Phase 7 bootstrap wizard runs as a designated bootstrap admin who, on first sign-in, holds NO role claims for the stake — the wizard's first action is to add them to `kindooManagers/`, which fires `syncManagersClaims` and mints the manager claim. Without an escape hatch, that very first write would be denied (chicken-and-egg).

The `isBootstrapAdmin(stakeId)` predicate provides the escape hatch. It evaluates to true only when:

1. The user is authenticated, AND
2. The stake doc exists, AND
3. `stake.setup_complete == false`, AND
4. `stake.bootstrap_admin_email == request.auth.token.email`. The stored value is lowercased on the way in (dots and `+suffix` preserved — see §4.1 field comment); `request.auth.token.email` is whatever Firebase Auth emitted, which is always lowercased. Case-normalizing on the write side closes the operator-typo gap where the Create Stake form receives `Foo@Bar` but the rule is handed `foo@bar`.

The gate is OR'd into the read + write rules of the four wizard-managed paths:

- `stakes/{sid}` (parent stake doc) — read + update (Step 1 fields + the final `setup_complete=true` flip)
- `stakes/{sid}/kindooManagers/{canonical}` — read + write (auto-self-add + Step 4 additional managers)
- `stakes/{sid}/wards/{wardCode}` — read + write (Step 3)
- `stakes/{sid}/buildings/{buildingId}` — read + write (Step 2)

The other wizard-adjacent collections (access, seats, requests, auditLog) are NOT covered by the gate — the wizard never writes to them, and the gate intentionally does not open up arbitrary doors.

**One-shot enforcement.** Step 3 of the gate's predicate (`setup_complete == false`) is what makes it strictly time-bounded. The wizard's final write flips `setup_complete=true`; the rule evaluates against pre-write state, so the flip itself succeeds, but every subsequent wizard-shaped write fails because the gate's predicate now returns false. By that point the bootstrap admin holds the manager claim minted by `syncManagersClaims`, so `isManager(stakeId)` takes over.

**Operator pre-step.** The stake doc must exist with `setup_complete=false` and `bootstrap_admin_email=<lowercased email>` BEFORE the bootstrap admin signs in for the first time. The Phase 12.3 `createStake` callable lowercases on the way in; a direct-console seed (or any out-of-band write path) must do the same. The gate's `get()` short-circuits if the stake doc is missing — operator seed is mandatory. See `infra/runbooks/provision-firebase-projects.md` for the seed instructions.

**`lastActorMatchesAuth` still applies.** The gate widens the *who can write* predicate but doesn't bypass the lastActor integrity check — the bootstrap admin's writes must still carry `lastActor.{email, canonical}` matching their auth token. This keeps audit trail integrity intact during bootstrap.

## 7. Cloud Functions

| Function | Trigger | Purpose |
|---|---|---|
| `onAuthUserCreate` | `auth.user().onCreate` | Writes `userIndex/{canonical}`; seeds custom claims from existing role data if any |
| `syncAccessClaims` | Firestore write on `stakes/{sid}/access/{memberCanonical}` | Recomputes `stakes[sid].stake` and `stakes[sid].wards` claims; calls `revokeRefreshTokens` |
| `syncManagersClaims` | Firestore write on `stakes/{sid}/kindooManagers/{memberCanonical}` | Recomputes `stakes[sid].manager` claim; revokes |
| `syncSuperadminClaims` | Firestore write on `platformSuperadmins/{canonicalEmail}` | Toggles `isPlatformSuperadmin` claim |
| `syncBootstrapClaims` | Firestore write on `stakes/{stakeId}` | Mints/clears the `stakes[sid].bootstrap` marker (§2, D28) on the designated bootstrap admin's claim block, keyed on `(bootstrap_admin_email, setup_complete)`. No-ops silently when no Auth user exists yet for that email. |
| `auditTrigger` | Firestore write on `stakes/{sid}/{collection}/{docId}` for audited collections | Writes deterministic audit row to `stakes/{sid}/auditLog` |
| `markRequestComplete` | Callable (manager-invoked) | Resolves seat slot, writes the add/edit, flips the request to `complete` in one transaction |
| `syncApplyFix` | Callable (operator-invoked from the extension's Sync panel) | Applies one classifier-derived fix to `access` + `seats` via Admin SDK; sole auto-seat writer |
| `backfillEqPresidentAccess` | Callable (manager-invoked from the Configuration → Config backfill dialog) | Reconciles `access` docs after a stake flips `eq_president_app_access` (§4.1). `{stakeId, direction:'grant'\|'revoke'}` → `{ok, seats_matched, docs_written, docs_deleted}`. Sweeps auto ward-scope seats holding the Elders Quorum President calling and merges that one entry into / out of `importer_callings[scope]`; `manual_grants` untouched. Auth reads `kindooManagers/{canonical}` directly (not the ~1h-stale claim); `direction` must match the stake's current flag or `failed-precondition`. Single-field `type == 'auto'` query — no composite index. Idempotent. See `spec.md` §8, D23. |
| `backfillKindooSiteId` | Callable (superadmin-invoked from the Stake List Apply Fixes menu) | Re-derives each seat's `kindoo_site_id` from its ward's building and writes only the diffs (idempotent). **Platform superadmin only** (`isPlatformSuperadmin` claim) — the former active-Kindoo-Manager gate was removed. See `spec.md` §15. |
| `mintExtensionToken` | Callable (invoked by the SPA's `/auth/extension` route) | Mints a Firebase **custom** token for the caller's own uid, for the Chrome extension to exchange via `signInWithCustomToken` (`spec.md` §4.1, D33). No payload; gated on `request.auth` and nothing further. No `developerClaims` — user-record claims flow through the exchange untouched. Writes nothing, so no audit row. **Needs `roles/iam.serviceAccountTokenCreator` on `kindoo-app@<project>`, granted to that account on itself** — under ADC `createCustomToken` signs through the IAM `signBlob` API. The emulator substitutes an unsigned token, so a missing grant only ever fails in a deployed environment. |
| `notifyOnRequestWrite` | Firestore write on `stakes/{sid}/requests/{rid}` | Sends Resend email per spec.md §9 (submit, complete, reject, cancel). Each send reads `stakes/{sid}/wards` once to render ward names (§4.2); the two manager-bound sends batch that read with the requester's `access` + `kindooManagers` docs. |
| `notifyOnAccessGranted` | Firestore write on `stakes/{sid}/access/{memberCanonical}` | Sends the app-access welcome email to the granted member per spec.md §9. Fires only on the no-scopes → at-least-one-scope transition (`scopesFromAccessDoc` over `importer_callings` + `manual_grants`): a scope added to an existing holder, a revoke to zero, and a delete are all silent; a re-grant after a full revoke fires again. Third trigger on this path alongside `syncAccessClaims` and `auditAccessWrites` (§4.5). Reads the stake doc and the member's `kindooManagers` row together — the latter to resolve the D25 tier, which narrows the copy for a limited recipient (§4.5) — plus `stakes/{sid}/wards` for the scope list (§4.2). Not gated on `setup_complete`; suppressed by `notifications_enabled === false`. |
| `notifyOnOverCap` | Firestore write on `stakes/{sid}` (`last_over_caps_json` change) | Sends the over-cap email when the array goes from empty to non-empty. Reads `stakes/{sid}/wards` once and labels every flagged pool from that one read (§4.2). Subject counts the pools (`spec.md` §9). |
| `pushOnRequestSubmit` | Firestore write on `stakes/{sid}/requests/{rid}` (status=`pending` on create) | Fans FCM Web Push to active managers' subscribed devices |
| `removeSeatOnRequestComplete` | Firestore write on `stakes/{sid}/requests/{rid}` (status flips to complete and type='remove') | Deletes the matching seat doc + writes audit (Admin SDK bypass for the deletion) |
| `reconcileAuditGaps` | Cloud Scheduler nightly | Diffs entity collections vs auditLog; pages on gaps |

Total: ~10–12 Cloud Functions. None hot-path; all run on free tier at this scale.

**Remote apply adds none (§3.4, D27).** Both ends of the mailbox are client SDK writes gated by rules, and the work the desktop does once it claims a job runs through the two callables that already exist — `getMyPendingRequests` to re-resolve the request and `markRequestComplete` to close it. There is no server-side participant in the transport at all: no trigger fires on `remoteApply`, and no audit row is fanned for a job doc (the audited row is the `complete_request` / seat write that `markRequestComplete` produces, exactly as it would for a desktop-initiated apply).

**Organizations deltas (PR #224).** The parameterized `auditTrigger` gains `auditOrganizationWrites` on `stakes/{sid}/organizations/{orgId}`, fanning rows as `entity_type='stake'`, `entity_id='organization:<slug>'` (same pattern as wards / buildings / kindooSites — organizations are not a first-class audit entity type). `reconcileAuditGaps` adds `organizations` to its `AUDITED_COLLECTIONS` list. Inline seat org edits audit automatically as `update_seat` (the existing `auditSeatWrites` path). `markRequestComplete` carries the request's `organization_id` onto the seat on stake-scope add/edit completion (new-seat primary, the stake-grant slot in the auto-merge path, and the resolved edit slot). Add vs edit are asymmetric: an **add** auto-merge onto an existing stake grant re-stamps `organization_id` **only when the request carries a non-null id** (the add form never pre-fills org, so a `null` add must not silently clear an existing org); the brand-new-seat add still writes `null` when none is picked. An **edit** is authoritative — the form pre-fills, so `null` clears. `syncApplyFix` preserves a client-set `organization_id` through auto-seat rewrites and clears it in `applyScopeMismatch` when a seat moves off stake scope to a ward. No new composite index.

## 8. Open questions / deferred decisions

Sorted by weight. The first item gates everything else.

### 8.1 Meta — RESOLVED 2026-04-27

Q1 (whether to migrate, and to which architecture) was resolved on 2026-04-27 when the user committed to the Firebase migration. `docs/firebase-migration.md` was rewritten from the prior Cloud Run + Express plan to direct-to-Firestore + custom claims and is now the active plan. See §8.6 for the resolved-decisions summary.

### 8.2 Behavioural changes from current spec — RESOLVED 2026-04-27

Q2 (duplicate manual/temp blocking), Q3 (multi-calling collapse + utilization recount), and Q4 (stake-priority hides cross-scope members from ward rosters) all locked in. See §8.6 for the resolved-decisions summary. All three are candidates for the cutover communication plan (E3 from the migration plan's pre-Phase-1 work) so end users aren't surprised.

### 8.3 Design pieces sketched but not finished

**Q5. The Reconcile flow UX.** We described the collision badge and a radio-button modal in words. No layout, no state-transition diagram, no error cases. Smallish but unbuilt.

**Q6. Audit log diff rendering under the new schema.** Spec §5.3 specifies "field-by-field diff (unchanged fields collapsed as 'N unchanged')." Under this schema, before/after include nested maps (`importer_callings: {scope: string[]}`, `manual_grants: {scope: Array}`). The "N unchanged" collapse logic has to walk into those maps. Worth a small spike on what reads well.

**Q7. `getAfter()` viability spike.** The `seats.create` rule's cross-doc check against request status leans on `getAfter()`. It's documented for exactly this purpose, but uncommon enough that emulator behaviour should be verified to match live behaviour before committing the architecture to it.

**Q8. Custom claims size budget.** Firebase caps custom claims at 1 KB. With one stake and ~12 ward codes plus the canonical email and superadmin flag, we're nowhere near the limit. **Phase 12 re-opens this** (2026-05-18): F18 makes multi-stake claims load-bearing — a user may now hold roles on N stakes simultaneously. At target scale (operator's foreseeable horizon: 2–4 stakes per power user, ~12 wards each), the worst-case claim is `~4 × (12 ward codes + manager + stake flags) ≈ 250-400 bytes`, still well under 1 KB. Revisit if a user routinely accumulates roles across 10+ stakes; the mitigation in that scenario is to drop `wards: string[]` in favour of a denormalized `userIndex/{canonical}.bishopricWards` lookup that the rules consult via `get()`. Not built; tracked as a future re-evaluation when stake count grows.

**Q9. Bootstrap admin first sign-in sequencing.** The bootstrap admin signs into a stake with `setup_complete=false`. Their `userIndex` doc gets written; claims sync from existing role data — but the access doc doesn't exist yet for them, and they're added to `kindooManagers/` only by the wizard's first step. Race-prone. Worth tracing through end-to-end.

**Q10. Self-lockout protection.** Manager toggles their own `kindooManagers.{self}.active = false`; claim sync removes their manager claim; they can't toggle it back. Same problem as today's spec — no guard. Worth a "you're about to lock yourself out" client-side warning at minimum.

### 8.4 Operational questions

**Q11. Migration script under this schema.** Original plan had a detailed Sheet → Firestore migration. Under this schema it's different (one seat doc per email, access docs with split fields, no `source_row_hash`). Migration script + idempotency + spot-check tooling — all undesigned.

**Q12. Test strategy.** Original plan was rigorous (rules tests, trigger tests, E2E, migration tests). Under this design the surfaces shift: more rules tests (because more logic lives in rules), fewer service-layer unit tests (because there's no service layer). Not sketched.

**Q13. Phase plan.** Original plan had 12 phases with acceptance criteria. Under this design a few phases collapse and one or two new ones appear (claim-sync triggers, `userIndex` maintenance, audit triggers). No phase plan written.

**Q14. `reconcileAuditGaps` failure mode.** Nightly job catches gaps in audit log. What happens when it finds one? Best guess: alert Tad. Need to define alerting channel and what manual recovery looks like.

**Q15. `userIndex` collision.** Two Google accounts canonicalising to the same email is rare but real (Gmail enforces uniqueness at signup, but rejected variants can still occur). The trigger as sketched lets the second one overwrite the first's entry silently. Should detect and refuse, or surface to ops.

### 8.5 Minor / "name the bikeshed" decisions

**Q16. Buildings doc-ID slugging strategy** — recommendation: slugify-on-write with `building_name` display field; reconfirm.

**Q17. Email "From" address** — recommendation: `noreply@kindoo.csnorth.org`. Subdomain isolates DNS from existing csnorth.org mail setup.

**Q18. Token claim field name for canonical email** — used `canonical` in the rules. Could be `canonicalEmail` for clarity. Either works.

**Q19. `requests` doc IDs** — kept as UUIDs because a member can submit many requests over time. Could revisit (`<canonical>__<seq>`?), but probably not worth it.

**Q20. TTL on `platformAuditLog`** — defaulted to 365 days; superadmin records may warrant longer.

**Q21. `reconcileAuditGaps` cadence** — defaulted nightly. First signal of false positives may push to hourly.

**Q22. Sync ward-vs-ward priority** — defaulted to alphabetical `ward_code`. Document or override.

### 8.6 What's effectively decided (not open)

For completeness, here's what was actively considered and resolved during the conversation, so future readers don't reopen them by mistake:

- **Q1 — Migration commitment (2026-04-27):** User committed to the Firebase migration on 2026-04-27. `docs/firebase-migration.md` is the active plan (rewritten from the prior Cloud Run + Express architecture to direct-to-Firestore + custom claims; the rewrite superseded the prior plan in the same file path).
- **Audit-log strategy:** Option A (trigger-written audit, flat `auditLog` collection per stake) chosen over Option B (embedded `history` subcollections with `getAfter()` rules). Reasoning: B's atomicity advantage applies only to client writes; Admin SDK writes (Sync's `syncApplyFix`, request-completion callables) bypass rules either way. Option D (best-effort + nightly reconciliation) kept as fallback.
- **Seat ID format:** canonical email. Not `{type}__{scope}__{canonical}`, not UUIDs.
- **Access ID format:** canonical email. Not composite key.
- **Source-row hash:** dropped. Doc ID is the natural key.
- **`scopes_with_access` field on seats:** rejected. Single `scope` field is what utilization reads; `duplicate_grants` is informational only and not counted.
- **Custom claims model:** chosen. Rejected: per-request Firestore lookups for role checks, denormalized `roleIndex` collection.
- **`userIndex` collection:** chosen, top-level. Bridges canonical email → uid.
- **Q2 — duplicate manual/temp seats (2026-04-27):** Block at write time (vs today's "warn, don't block"). Managers see a hard error; the existing-seat affordance is the workaround.
- **Q3 — multi-calling collapse + utilization recount (2026-04-27):** Multi-calling people collapse to one seat doc per (stake, member) with a `callings[]` array. Utilization counts each person once — fixes today's quiet over-counting where Kindoo licenses 1 seat per person but Apps Script created 1 row per calling.
- **Q4 — stake-priority hides cross-scope members from ward rosters (2026-04-27):** A person with both a stake-scope grant and a ward-scope grant has `scope='stake'` as primary and the ward grant goes to `duplicate_grants[]`. Stake roster shows them; ward roster does not. Bishopric loses visibility but the seat doc still records the ward calling.

## 9. What this doc does not cover

- Phase plan (how to actually port the Apps Script app to this architecture).
- UI/UX changes implied by the schema (e.g. card-per-user rendering on the Access page, Reconcile flow on collisions).
- Migration script (Sheet → Firestore mapping under this schema).
- Test strategy (rules tests, trigger tests, E2E).

Each of those is a follow-up document if/when the migration resumes.
