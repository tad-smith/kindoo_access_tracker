# Firebase data model + security rules

> **Status: LIVE.** Authoritative schema, rules, and indexes reference. The migration committed on 2026-04-27 closed Phase A on 2026-05-03 (see [`docs/changelog/phase-11-cutover.md`](changelog/phase-11-cutover.md)); Firebase is now in production at `kindoo-prod`. See [`docs/firebase-migration.md`](firebase-migration.md) for phase history and [`docs/spec.md`](spec.md) for runtime behaviour.

## 1. Architecture overview

- **Identity:** Firebase Authentication (Google sign-in only).
- **Authorization:** Custom claims on the auth token, set by Cloud Function triggers on role-data writes.
- **Data path (reads):** Client uses Firestore JS SDK directly. Firestore Security Rules enforce per-document access using claims from the auth token.
- **Data path (writes):** Same — client writes via Firestore SDK; rules enforce field-level invariants and cross-doc invariants via `getAfter()`.
- **Server-side compute:** Cloud Functions only, for: weekly importer (Sheets API), daily temp-seat expiry, email send (SendGrid), audit-log fan-in, custom-claims sync.
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
    };
  };
}
```

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

Allow-list for the multi-tenant superadmin role. Empty in single-stake v1.

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

**Written by:** Firestore console (chicken-and-egg — no in-app management).

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

**Written by:** `createStake` callable Cloud Function; superadmin-management triggers.

**Read by:** Platform admin page.

**Rules:** read by superadmins; writes server-only.

## 4. Per-stake collections

All under `stakes/{stakeId}/`. The parent stake doc holds what was the `Config` tab in the Apps Script app.

### 4.1 `stakes/{stakeId}` — parent doc (Config collapsed in)

**Doc ID:** human-readable slug (`csnorth`, `someother`).

**Fields:**

```typescript
{
  // Identity
  stake_id: string;                    // = doc.id
  stake_name: string;                  // display name
  created_at: Timestamp;
  created_by: string;                  // superadmin canonical email

  // Importer source
  callings_sheet_id: string;           // Google Sheet ID
  bootstrap_admin_email: string;       // typed form
  setup_complete: boolean;

  // Capacity
  stake_seat_cap: number;              // license total

  // Schedules
  expiry_hour: number;                 // 0–23, local stake time
  import_day: 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY' | 'SUNDAY';
  import_hour: number;                 // 0–23
  timezone: string;                    // IANA tz, e.g. 'America/Denver'

  // Notifications
  notifications_enabled: boolean;

  // Operational state (written by importer/expiry, read by manager UI)
  last_over_caps_json: Array<{
    pool: 'stake' | string;            // string = ward_code
    count: number;
    cap: number;
    over_by: number;
  }>;
  last_import_at?: Timestamp;
  last_import_summary?: string;
  last_expiry_at?: Timestamp;
  last_expiry_summary?: string;

  // Bookkeeping
  last_modified_at: Timestamp;
  last_modified_by: { email: string; canonical: string };
  lastActor: { email: string; canonical: string };
}
```

**Written by:** Bootstrap wizard (initial); manager via Configuration page; importer (last_* and last_over_caps_json); expiry (last_expiry_*).

**Read by:** every page (stake metadata is in the bootstrap response).

### 4.2 `stakes/{stakeId}/wards/{wardCode}`

**Doc ID:** 2-letter `ward_code`, matches LCR tab name. Natural key.

**Fields:**

```typescript
{
  ward_code: string;       // = doc.id
  ward_name: string;
  building_name: string;   // FK to buildings (by building_name natural key)
  seat_cap: number;
  created_at: Timestamp;
  last_modified_at: Timestamp;
  lastActor: { email: string; canonical: string };
}
```

**Written by:** Bootstrap wizard; manager via Configuration page.
**Read by:** Roster pages (utilization), importer (scope resolution).

### 4.3 `stakes/{stakeId}/buildings/{buildingId}`

**Doc ID:** URL-safe slug derived from `building_name` (e.g. `Cordera Building` → `cordera-building`).

**Fields:**

```typescript
{
  building_id: string;     // = doc.id (slug)
  building_name: string;   // display form
  address: string;
  created_at: Timestamp;
  last_modified_at: Timestamp;
  lastActor: { email: string; canonical: string };
}
```

**Written by:** Bootstrap wizard; manager via Configuration page.
**Read by:** Wards (FK), seat building_names defaults.

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
**Read by:** `syncManagersClaims` trigger; manager list reads.

### 4.5 `stakes/{stakeId}/access/{canonicalEmail}`

Per-user role-grant doc. Doc exists iff the user has *any* importer or manual access. The split between `importer_callings` and `manual_grants` is the field-level split-ownership boundary that rules enforce.

**Doc ID:** canonical email.

**Fields:**

```typescript
{
  member_canonical: string;    // = doc.id
  member_email: string;        // typed form
  member_name: string;

  // Importer-managed. Keys = scope ('stake' or ward_code). Values = list of callings
  // in that scope whose template row has give_app_access=true.
  importer_callings: {
    [scope: string]: string[];
  };

  // Manager-managed. Keys = scope. Values = explicit manual grants.
  manual_grants: {
    [scope: string]: Array<{
      grant_id: string;        // uuid; lets a manager unambiguously delete one entry
      reason: string;          // free-text; the "calling" column on today's manual rows
      granted_by: { email: string; canonical: string };
      granted_at: Timestamp;
    }>;
  };

  // Doc-level sort key. MIN of `sheet_order` across every (scope, calling) pair in
  // `importer_callings`. `null` for manual-only access docs (no `importer_callings`).
  sort_order: number | null;

  created_at: Timestamp;
  last_modified_at: Timestamp;
  last_modified_by: { email: string; canonical: string };
  lastActor: { email: string; canonical: string };
}
```

**Written by:** Importer Cloud Function (replaces `importer_callings` wholesale each run); manager Access page (`manual_grants` only).

**Read by:** `syncAccessClaims` trigger; manager Access page.

**Invariants:**
- Importer never mutates `manual_grants` (rules enforce on client side; importer code enforces on Admin SDK side).
- Manager never mutates `importer_callings` (rules enforce).
- Doc deletion only when both maps are empty.
- Composite-key uniqueness on (canonical_email, scope, calling) is *structurally absent* — importer's scope is `importer_callings[scope]: string[]`; manual's scope is `manual_grants[scope]: Array`. No path for them to collide.

### 4.6 `stakes/{stakeId}/seats/{canonicalEmail}`

Per-user Kindoo seat. One doc per user per stake. The `duplicate_grants[]` field captures rare cross-scope or cross-type collisions for manager review without affecting accounting.

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
  sort_order: number | null;   // see "Sort order" below

  // Manual/temp linkage
  granted_by_request?: string; // request_id; absent for auto seats

  // Collision flag — informational, never counted in utilization
  duplicate_grants: Array<{
    scope: string;
    type: 'auto' | 'manual' | 'temp';
    callings?: string[];
    reason?: string;
    start_date?: string;
    end_date?: string;
    detected_at: Timestamp;
  }>;

  created_at: Timestamp;
  last_modified_at: Timestamp;
  last_modified_by: { email: string; canonical: string };
  lastActor: { email: string; canonical: string };
}
```

**Written by:** Importer (auto seats); manager via request completion (manual/temp); expiry trigger (deletes expired temp seats); manager via inline edit.

**Read by:** All roster pages (bishopric, stake, all-seats), manager dashboard, manager queue (for duplicate-warning), audit log entity-history view.

**Invariants:**
- Doc ID = `member_canonical`.
- Importer applies priority `stake > ward (alphabetical)` deterministically; first-seen wins among manager-driven writes.
- `scopes_with_access` is **not** stored — `scope` (singular) is what utilization reads.
- Auto seats have `callings.length >= 1` and `type='auto'`. Removing the last calling deletes the seat (or promotes a manual/temp duplicate to primary, see importer logic).
- Manual/temp seats have `granted_by_request` set; auto seats do not.

**Sort order:**
- **Auto seats:** denormalized at importer run as the **MIN** of `sheet_order` across the seat's `callings[]` (the matched calling templates' `sheet_order` values). Multi-calling collapsed seats get the lowest-priority template's order.
- **Manual / temp seats:** always `null`. These seats are created by request completion, never the importer.
- **Orphaned auto seats** (calling no longer matches any template): `null`.

### 4.7 `stakes/{stakeId}/requests/{requestId}`

Request lifecycle docs. Still UUID-keyed because a member can have many requests over time.

**Doc ID:** UUID (Firestore-auto-generated).

**Fields:**

```typescript
{
  request_id: string;          // = doc.id
  type: 'add_manual' | 'add_temp' | 'remove';
  scope: string;               // 'stake' or ward_code

  member_email: string;
  member_canonical: string;
  member_name: string;

  reason: string;
  comment: string;
  urgent: boolean;             // requester flag; defaults false. Client gates the comment-required UX on it.
  start_date?: string;         // temp only
  end_date?: string;           // temp only
  building_names: string[];    // requester's selection (stake-scope add types only)

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

### 4.8 `stakes/{stakeId}/wardCallingTemplates/{callingName}`

Per-ward calling → seat mapping. Wildcards (`*`) preserved verbatim.

**Doc ID:** URL-encoded calling name (e.g. `Bishop`, `Counselor%20%2A` for `Counselor *`).

**Fields:**

```typescript
{
  calling_name: string;        // human form, with wildcards if any
  give_app_access: boolean;    // true → row triggers Access doc population
  sheet_order: number;         // for wildcard tie-breaking (Sheet order wins among wildcards)
  created_at: Timestamp;
  lastActor: { email: string; canonical: string };
}
```

**Written by:** Manager via Configuration page.
**Read by:** Importer (matches against ward-tab `Position` values).

### 4.9 `stakes/{stakeId}/stakeCallingTemplates/{callingName}`

Same shape as `wardCallingTemplates`, applied to the Stake tab.

### 4.10 `stakes/{stakeId}/auditLog/{auditId}`

Flat audit collection. One row per write to seats, requests, access, kindooManagers, or stake parent doc.

**Doc ID:** `<ISO-timestamp>_<uuid-suffix>` — sortable by ID for newest-first reads.

**Fields:**

```typescript
{
  audit_id: string;            // = doc.id
  timestamp: Timestamp;
  actor_email: string;         // 'Importer', 'ExpiryTrigger', or canonical email
  actor_canonical: string;     // canonical form of actor_email; same value for automated actors
  action:
    | 'create_seat' | 'update_seat' | 'delete_seat' | 'auto_expire'
    | 'create_access' | 'update_access' | 'delete_access'
    | 'create_request' | 'submit_request' | 'complete_request' | 'reject_request' | 'cancel_request'
    | 'create_manager' | 'update_manager' | 'delete_manager'
    | 'update_stake' | 'setup_complete'
    | 'import_start' | 'import_end' | 'over_cap_warning';

  entity_type: 'seat' | 'request' | 'access' | 'kindooManager' | 'stake' | 'system';
  entity_id: string;           // canonical email for seat/access/manager; UUID for request; stake_id for stake
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
- `member_canonical` is set whenever the underlying doc has a `member_canonical` field; absent for system actions (`import_start`, `over_cap_warning`, `setup_complete`).
- Firestore TTL policy on the `ttl` field deletes rows ~24h after their `ttl` timestamp passes.

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

**`access`, `kindooManagers`, `wards`, `buildings`, `*CallingTemplates`:** small enough to load fully and filter client-side. No composite indexes.

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

    // ===== Per-stake collections =====

    match /stakes/{stakeId} {

      // Parent stake doc — `isBootstrapAdmin` lets the wizard write Step 1 fields
      // and the final `setup_complete=true` flip before the manager claim is minted.
      allow read: if isAnyMember(stakeId) || isBootstrapAdmin(stakeId);
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

        // Manager creates a manual-only access doc (no importer rows yet)
        allow create: if isManager(stakeId)
          && memberCanonical == request.resource.data.member_canonical
          && request.resource.data.importer_callings == {}
          && request.resource.data.manual_grants.size() > 0
          && lastActorMatchesAuth(request.resource.data);

        // Manager edits manual_grants only — importer_callings is immutable from clients
        allow update: if isManager(stakeId)
          && request.resource.data.member_canonical == resource.data.member_canonical
          && request.resource.data.importer_callings == resource.data.importer_callings
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

        // Inline edit by manager — only certain fields, primary scope/type/email immutable
        allow update: if isManager(stakeId)
          && resource.data.type in ['manual', 'temp']
          && request.resource.data.member_canonical == resource.data.member_canonical
          && request.resource.data.scope == resource.data.scope
          && request.resource.data.type == resource.data.type
          && lastActorMatchesAuth(request.resource.data)
          && request.resource.data.diff(resource.data).affectedKeys()
             .hasOnly(['member_name', 'reason', 'building_names', 'start_date', 'end_date',
                       'duplicate_grants', 'last_modified_by', 'last_modified_at', 'lastActor']);

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
          && (
               (request.resource.data.scope == 'stake' && isStakeMember(stakeId))
            || (request.resource.data.scope in bishopricWardOf(stakeId))
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

      // ----- Calling templates -----
      match /wardCallingTemplates/{callingName} {
        allow read: if isManager(stakeId);
        allow write: if isManager(stakeId) && lastActorMatchesAuth(request.resource.data);
      }

      match /stakeCallingTemplates/{callingName} {
        allow read: if isManager(stakeId);
        allow write: if isManager(stakeId) && lastActorMatchesAuth(request.resource.data);
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
- **No client writes to auto seats** — auto seats are written only by the Importer Cloud Function via Admin SDK, which bypasses rules. The rules' `seats.create` only allows `type in ['manual', 'temp']`.
- **No client writes to importer_callings** — same pattern. `access.update` rules verify it's unchanged on every client write.
- **Cross-stake denial is automatic** — `isAnyMember(stakeId)` returns false when the user has no claims for that stakeId, so reads are denied at the stake-doc level and inherit through.
- **Admin SDK writes bypass everything** — the Cloud Functions (importer, expiry, audit triggers, claim sync) operate via the Admin SDK; rules don't fire. The discipline lives in those functions' code.

#### Bootstrap-admin gate

The Phase 7 bootstrap wizard runs as a designated bootstrap admin who, on first sign-in, holds NO role claims for the stake — the wizard's first action is to add them to `kindooManagers/`, which fires `syncManagersClaims` and mints the manager claim. Without an escape hatch, that very first write would be denied (chicken-and-egg).

The `isBootstrapAdmin(stakeId)` predicate provides the escape hatch. It evaluates to true only when:

1. The user is authenticated, AND
2. The stake doc exists, AND
3. `stake.setup_complete == false`, AND
4. `stake.bootstrap_admin_email == request.auth.token.email` (typed-form comparison).

The gate is OR'd into the read + write rules of the four wizard-managed paths:

- `stakes/{sid}` (parent stake doc) — read + update (Step 1 fields + the final `setup_complete=true` flip)
- `stakes/{sid}/kindooManagers/{canonical}` — read + write (auto-self-add + Step 4 additional managers)
- `stakes/{sid}/wards/{wardCode}` — read + write (Step 3)
- `stakes/{sid}/buildings/{buildingId}` — read + write (Step 2)

The other wizard-adjacent collections (access, seats, requests, calling templates, auditLog) are NOT covered by the gate — the wizard never writes to them, and the gate intentionally does not open up arbitrary doors.

**One-shot enforcement.** Step 3 of the gate's predicate (`setup_complete == false`) is what makes it strictly time-bounded. The wizard's final write flips `setup_complete=true`; the rule evaluates against pre-write state, so the flip itself succeeds, but every subsequent wizard-shaped write fails because the gate's predicate now returns false. By that point the bootstrap admin holds the manager claim minted by `syncManagersClaims`, so `isManager(stakeId)` takes over.

**Operator pre-step.** The stake doc must exist with `setup_complete=false` and `bootstrap_admin_email=<typed email>` BEFORE the bootstrap admin signs in for the first time. The gate's `get()` short-circuits if the stake doc is missing — operator seed is mandatory. See `infra/runbooks/provision-firebase-projects.md` for the seed instructions.

**`lastActorMatchesAuth` still applies.** The gate widens the *who can write* predicate but doesn't bypass the lastActor integrity check — the bootstrap admin's writes must still carry `lastActor.{email, canonical}` matching their auth token. This keeps audit trail integrity intact during bootstrap.

## 7. Cloud Functions

| Function | Trigger | Purpose |
|---|---|---|
| `onAuthUserCreate` | `auth.user().onCreate` | Writes `userIndex/{canonical}`; seeds custom claims from existing role data if any |
| `syncAccessClaims` | Firestore write on `stakes/{sid}/access/{memberCanonical}` | Recomputes `stakes[sid].stake` and `stakes[sid].wards` claims; calls `revokeRefreshTokens` |
| `syncManagersClaims` | Firestore write on `stakes/{sid}/kindooManagers/{memberCanonical}` | Recomputes `stakes[sid].manager` claim; revokes |
| `syncSuperadminClaims` | Firestore write on `platformSuperadmins/{canonicalEmail}` | Toggles `isPlatformSuperadmin` claim |
| `auditTrigger` | Firestore write on `stakes/{sid}/{collection}/{docId}` for audited collections | Writes deterministic audit row to `stakes/{sid}/auditLog` |
| `runImporter` | Cloud Scheduler hourly + manager callable | Reads LCR Sheet, applies diff against access + seats per stake whose schedule matches |
| `runExpiry` | Cloud Scheduler hourly + manager callable | Scans seats with type='temp' and end_date<today, deletes |
| `notifyOnRequestWrite` | Firestore write on `stakes/{sid}/requests/{rid}` | Sends SendGrid email per spec.md §9 (submit, complete, reject, cancel) |
| `notifyOnOverCap` | Firestore write on `stakes/{sid}` (`last_over_caps_json` change) | Sends over-cap warning email when the array goes from empty to non-empty |
| `removeSeatOnRequestComplete` | Firestore write on `stakes/{sid}/requests/{rid}` (status flips to complete and type='remove') | Deletes the matching seat doc + writes audit (Admin SDK bypass for the deletion) |
| `reconcileAuditGaps` | Cloud Scheduler nightly | Diffs entity collections vs auditLog; pages on gaps |

Total: ~10–12 Cloud Functions. None hot-path; all run on free tier at this scale.

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

**Q8. Custom claims size budget.** Firebase caps custom claims at 1 KB. With one stake and ~12 ward codes plus the canonical email and superadmin flag, we're nowhere near the limit. Worth bounding for the long-tail multi-stake case (Phase B).

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

**Q22. Importer ward-vs-ward priority** — defaulted to alphabetical `ward_code`. Document or override.

### 8.6 What's effectively decided (not open)

For completeness, here's what was actively considered and resolved during the conversation, so future readers don't reopen them by mistake:

- **Q1 — Migration commitment (2026-04-27):** User committed to the Firebase migration on 2026-04-27. `docs/firebase-migration.md` is the active plan (rewritten from the prior Cloud Run + Express architecture to direct-to-Firestore + custom claims; the rewrite superseded the prior plan in the same file path).
- **Audit-log strategy:** Option A (trigger-written audit, flat `auditLog` collection per stake) chosen over Option B (embedded `history` subcollections with `getAfter()` rules). Reasoning: B's atomicity advantage applies only to client writes; Admin SDK writes (importer, expiry) bypass rules either way. Option D (best-effort + nightly reconciliation) kept as fallback.
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
