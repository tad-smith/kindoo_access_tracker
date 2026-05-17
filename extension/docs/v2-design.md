# Chrome extension v2 — design

v1 surfaces SBA's pending request queue inside Kindoo and lets the manager Mark Complete after they've manually re-entered the request in Kindoo's admin UI. v2 closes the loop: from the same panel, the manager can provision (add / remove / change-access) the user in Kindoo with one click.

This doc is the working contract for v2's two phases. Not a public spec; lives next to the extension workspace.

## Scope split — two phases

| Phase | What ships | Why first |
|---|---|---|
| **v2.1 — Configuration** | First-run setup wizard. Verifies the Kindoo site matches the SBA stake. Lets the operator map each SBA building to a Kindoo Access Rule. Persists to Firestore. No Kindoo mutations. | Lower risk, must come first — v2.2 reads this config to translate `building_names[]` → Kindoo RIDs. |
| **v2.2 — Provision & Complete** | Replaces "Mark Complete" with "Provision & Complete." Uses v2.1's config to drive the Kindoo add / remove / change-access flow, then calls SBA's existing `markRequestComplete`. | Cannot land before v2.1 — needs the building→rule mapping. |

This doc covers v2.1 in detail and outlines v2.2. v2.2 gets its own design pass before implementation.

## Locked-in decisions

1. **Site name verification uses the Kindoo API**, not DOM scraping. `KindooGetEnvironments` returns the site list; we match on `EID` (= `localStorage.state.sites.ids[0]`) and read the site name from the response. DOM scraping is brittle against react-native-web's hashed class names.
2. **Config persists to Firestore**, not `chrome.storage.local`. Shared across all managers of the stake; new managers don't reconfigure.
3. **Stake-level config on the stake doc; per-building rules on each building doc.** The site identity (one per stake) lives on `stakes/{stakeId}`. The Access Rule for a building (one per building) lives on `stakes/{stakeId}/buildings/{buildingId}`.
4. **Block on site-name mismatch.** No override. Wrong-site provisioning would grant access in the wrong physical buildings — catastrophic, irreversible.
5. **Block on missing building→rule mapping** (in v2.2, when provisioning a request that grants a building with no mapped rule). Block + offer "Reconfigure" entry point.
6. **Kindoo Manager prerequisite**: the operator creates Access Rules in Kindoo's admin UI before configuring the extension. The extension does not create rules; it only lets the operator pick from existing rules.
7. **UserRole hardcoded to 2 (Guest)** for every provisioned user. Only role the manager account can grant (confirmed from the Add User DOM dropdown).

## v2.1 — Configuration

### Schema additions

**`packages/shared/src/types/stake.ts`** — extend `Stake`:

```ts
export type KindooConfig = {
  /** Kindoo site / environment ID. Matches `EID` in Kindoo's API payloads. */
  site_id: number;
  /** Kindoo's display name for the site, captured at config time for diagnostics and drift detection. */
  site_name: string;
  configured_at: TimestampLike;
  configured_by: ActorRef;
};

export type Stake = {
  // … existing fields …
  /** Optional; absent until v2.1 first-run config completes. */
  kindoo_config?: KindooConfig;
};
```

**`packages/shared/src/types/building.ts`** — extend `Building`:

```ts
export type KindooBuildingRule = {
  /** Kindoo's internal rule id (`RID`). */
  rule_id: number;
  /** Display name captured at config time. Re-fetched/repaired on reconfigure. */
  rule_name: string;
};

export type Building = {
  // … existing fields …
  /** Optional; absent until v2.1 maps a Kindoo Access Rule for the building. */
  kindoo_rule?: KindooBuildingRule;
};
```

### Firestore rules

`stakes/{stakeId}` — managers may write `kindoo_config` (in addition to whatever fields they can already write).

`stakes/{stakeId}/buildings/{buildingId}` — managers may write `kindoo_rule`.

Rule updates land in `firestore/firestore.rules` with tests.

### Audit trail

The parameterized `auditTrigger` already fans audit rows for every entity write — no functions changes required for v2.1.

### Kindoo API surface (read-only in v2.1)

Endpoints exercised:

1. **`KindooGetEnvironments`** — fetch the operator's list of sites; find the active one by `EID`; read site name.
2. **`KindooGetEnvironmentRules`** — fetch all Access Rules for the active site. Each entry has at minimum `RID` (number) and `Name` (string). The operator picks one rule per SBA building from this list.

Both calls run from the content script via `fetch()`. Standard multipart/form-data envelope: `SessionTokenID` (from `localStorage.kindoo_token`), `EID` (from `JSON.parse(localStorage.state).sites.ids[0]`), `AppVersion=6.1.0`, `PlatformOS=web`.

### UI flow

The slide-over panel gets a new state: **needs-config**. Shown when a signed-in manager opens the panel and either:
- `stake.kindoo_config` is absent, OR
- Any `building.kindoo_rule` is absent.

The needs-config screen has two sequential steps:

**Step 1 — Site verification (read-only)**

- Read EID from `localStorage.state`. If missing, show "Sign into Kindoo first" + abort.
- Call `KindooGetEnvironments`. Find entry matching EID. Extract `Name`.
- Compare `Name` to `stake.stake_name` (case-insensitive, whitespace-trimmed).
- **Match**: show green check, "Confirmed: 'Colorado Springs North Stake' ↔ 'Colorado Springs North Stake'." Continue button enabled.
- **Mismatch**: show red error. "Kindoo site is 'X' but SBA stake is 'Y'. Sign into the correct Kindoo site and retry." No override. Continue button disabled.

**Step 2 — Building → Access Rule mapping**

- Call `KindooGetEnvironmentRules`. Hold the list of `{RID, Name}` in component state.
- Fetch the SBA building list from Firestore (`stakes/{stakeId}/buildings/*`).
- Render one row per building: `Building Name | [Select Kindoo Access Rule ▼]`. Default: whatever's already in `building.kindoo_rule` (for reconfigure cases).
- Validate: every building has a selection. Save button disabled until valid.
- Save: Firestore batched write of `stake.kindoo_config = { site_id, site_name, configured_at, configured_by }` + `building.kindoo_rule = { rule_id, rule_name }` for each. `configured_by` is the current `usePrincipal()` actor ref.

After save → panel transitions to the regular Queue view.

### Reconfigure entry point

Top of the Queue panel: a small "⚙ Configure Kindoo" link visible at all times. Re-opens the needs-config flow with current values pre-filled. Used when:
- A new building is added to SBA after initial config.
- Operator created additional Kindoo Access Rules and wants to remap.
- Site identity changed (rare; expected to require reconfigure).

### Per-site configuration (Kindoo Sites Phase 5)

When the SBA stake operates more than one Kindoo site (home plus N foreign), each foreign site's buildings need their own `kindoo_rule` mappings — those `RID`s come from the foreign site's Access Rule list, not home's. The wizard ships re-runnable per Kindoo site:

- **One wizard run = one Kindoo site.** Which site is determined by `resolveActiveKindooSite(...)` in `siteCheck.ts` (the same active-session detector the orchestrator entry guard uses for the request's expected site). The operator switches sites via Kindoo's own UI and reopens the SBA panel; no "switch sites" button lives in SBA.
- **Header label:** `"Configuring: <displayName>"` — `stake.kindoo_expected_site_name || stake.stake_name` for home, `KindooSite.display_name` for a foreign site.
- **Building filter:** the wizard renders only buildings whose `kindoo_site_id` matches the active site (`null` / absent for home; a foreign doc id for foreign). A home wizard never prompts for foreign buildings; a foreign wizard never prompts for home buildings.
- **Save scope:** the `data.writeKindooConfig` payload carries `kindooSiteId: string | null`. `null` → write `stake.kindoo_config` + per-building `kindoo_rule` on home buildings. `<string>` → auto-populate `kindoo_eid` on the foreign `KindooSite` doc (idempotent — re-asserts the value on subsequent runs) + per-building `kindoo_rule` on foreign buildings. The stake doc's `kindoo_config` is NEVER touched on a foreign run.
- **Unknown active site:** if the active session's site name matches neither home nor any configured foreign site, the wizard refuses with `"This Kindoo site (<active site name>) isn't configured in SBA. Add it in Configuration → Kindoo Sites first."`. The operator adds the site to SBA via the manager web app's Configuration → Kindoo Sites surface (Phase 1) and reopens the panel.
- **First-run gate.** `App.tsx`'s `decideConfigStatus()` routes to the wizard takeover until `stake.kindoo_config` exists AND every HOME building has `kindoo_rule`. Foreign-building rule mappings happen on a subsequent wizard run while the operator is signed into that foreign site — checking foreign buildings in the gate would loop the wizard forever for any home session.

### Wire-protocol additions (SW ↔ CS)

v2.1 is content-script-side for everything Kindoo-related (per locked-in CS decision in v1). Firestore reads of `stakes/{stakeId}` + buildings happen from the SW via the existing `extensionApi.ts` boundary; the CS asks the SW for principal + stake + buildings data.

New message types (TBD names, in `lib/messaging.ts`):
- `data.getStakeConfig` → response: `{ stake: Stake, buildings: Building[], wards: Ward[], kindooSites: KindooSite[] }`
- `data.writeKindooConfig` → input: `{ kindooSiteId: string | null, siteId, siteName, buildingRules: [{ buildingId, ruleId, ruleName }] }` → response: success/error. Phase 5 — `kindooSiteId === null` discriminates a home save (writes `stake.kindoo_config`) from a foreign save (writes `kindooSites/<id>.kindoo_eid`).

Firestore writes are done by the SW (it owns the Firebase Auth session) in a single batched write.

### Test surface

- **Unit:** Kindoo client (`KindooGetEnvironments`, `KindooGetEnvironmentRules` parsing). Mock `fetch`.
- **Component:** Configure panel — happy path, site-mismatch, missing-rule validation. Mock the extensionApi boundary.
- **Rules:** Firestore rule tests for the new field writes (manager allowed; non-manager denied).
- **No E2E** for v2.1 — Playwright MV3 + Kindoo is still deferred.

## v2.2 — Provision & Complete

Closes the loop: from the same panel, the manager provisions (add / remove / change-access) the user in Kindoo with one click, then SBA's request flips to complete.

### Locked-in decisions (v2.2)

1. **No confirmation dialog before provisioning.** The RequestCard already shows everything; a "are you sure?" step adds friction without value.
2. **Button label varies by request type:**
   - `add_manual` / `add_temp` → `Add Kindoo Access`
   - `remove` → `Remove Kindoo Access`
3. **Result confirmation dialog after every action.** Synthesized message describes what was done. Persisted on the request doc as `provisioning_note` for audit.
4. **Single spinner during the call** — no per-step progress.
5. **Read-first + merged-state pattern (add AND remove).** Both paths read the SBA `Seat` doc + call `lookupUserByEmail` for the Kindoo user's current state, compute the intended *post-completion* state, then drive Kindoo to that state with `saveAccessRule` (rule additions), `revokeUserFromAccessSchedule` (per-rule narrowing), `revokeUser` (full-wipe when nothing survives), and `editEnvironmentUserAdvancedSettings` (description / temp / dates).
   - **`saveAccessRule` is MERGE, not REPLACE** (confirmed in staging 2026-05-12). Sending a subset of the user's existing rules does NOT remove the omitted ones — only additions land. That's exactly what we want on the add path; on the remove path we use `revokeUserFromAccessSchedule` to narrow.
   - **Remove is scope-specific.** Computes the post-removal seat shape (mirroring SBA's `removeSeatOnRequestComplete` trigger's "promote first duplicate / drop matching duplicate" logic), derives the surviving rule set, and reconciles Kindoo: per-rule revoke for rules the seat no longer needs, full `revokeUser` when the seat is being deleted (no duplicates promoted), `editUser` for description-only diffs. SBA's post-state and Kindoo's stay in lockstep by construction.
   - Resolves B-7 and B-8 by construction.
6. **Description merge format** — synthesized from the SBA seat's primary grant + each `duplicate_grants[]` entry:
   - Primary: `${scopeName} (${callings.join(', ') || reason})`
   - Each duplicate: ` | ${dupScopeName} (${dupCallings.join(', ') || dupReason})`
   - Final string: primary + each dup joined by ` | `. Matches the Kindoo manual convention.
7. **ExpiryTimeZone**: read from the env's `TimeZone` field (from `KindooGetEnvironments` or persisted on `kindoo_config`). No IANA↔Windows mapping needed; Kindoo's wire format IS Windows-style.
8. **Temp-request date format**: full-day bounds. For Invite: `${start_date} 00:00` / `${end_date} 23:59` (SPACE separator). For Edit: `${start_date}T00:00` / `${end_date}T23:59` (T separator). See "Date format choreography" below — formats differ per endpoint.
9. **Remove with user-not-in-Kindoo**: auto-complete the SBA request as a no-op (`provisioning_note: "User was not in Kindoo (no-op)."`).
10. **Audit**: extend `markRequestComplete` to accept optional Kindoo metadata. Persist on the request doc; auditTrigger picks it up.

### Two-IDs gotcha (CRITICAL)

Kindoo distinguishes two identifiers per environment-user. Both come back from `lookupUserByEmail`:

| Operation | Field in request | Which ID |
|---|---|---|
| `SaveAccessRule` | `UID` | **UserID** (e.g. `85bea3c7-…`) |
| `RevokeUserFromEnvironment` | `UID` | **UserID** |
| `EditEnvironmentUserAdvancedSettings` | `euID` | **EUID** (env-scoped, e.g. `fcf38b4c-…`) |

Orchestrator must keep them distinct. Conflating them silently fails on edit.

### Date format choreography

| Endpoint | Field | Format |
|---|---|---|
| `Invite` | `StartAccessDoorsDate` / `ExpiryDate` | `YYYY-MM-DD HH:MM` (space) |
| `Edit` | `startAccessDoorsDateTime` / `expiryDate` | `YYYY-MM-DDTHH:MM` (T) |
| Lookup returns | `StartAccessDoorsDateAtTimeZone` / `ExpiryDateAtTimeZone` | T (matches Edit — echo verbatim) |

For Edit calls, prefer echoing the `…AtTimeZone` values from lookup. For Invite, compute fresh with the space separator.

### Architecture

All Kindoo work runs in the content script (same as v2.1). SBA `markRequestComplete` continues to round-trip through the SW.

```
extension/src/content/kindoo/
├── client.ts               (existing — multipart envelope)
├── auth.ts                 (existing — read SessionTokenID + EID)
├── endpoints.ts            (existing read-only + NEW write endpoints)
└── provision.ts            (NEW — orchestration)
```

New endpoint wrappers in `endpoints.ts`:

- `checkUserType(session, email)` → `{ exists: boolean }` — used as a cheap existence probe before deciding invite vs lookup. (Could be subsumed into `lookupUserByEmail` if its latency is similar; orchestrator just calls `lookupUserByEmail` first and treats `EUList.length === 0` as "not exists.")
- `inviteUser(session, payload)` → `{ userId: string }` (single-user invite — extracts UserID from response; if response doesn't carry it, fall back to a follow-up `lookupUserByEmail` to resolve).
- `saveAccessRule(session, userId, rids[])` → `{ ok: boolean }` — MERGE-only (confirmed staging 2026-05-12): can grow the rule set but cannot shrink it. Used on the add path; not on remove.
- `editUser(session, euId, payload)` → `{ ok: boolean }` — `payload = { description, isTemp, startAccessDoorsDateTime, expiryDate, timeZone }`. Echo current values from lookup for fields not being changed.
- `lookupUserByEmail(session, email)` → `KindooEnvironmentUser | null` — narrow the entry to the fields v2.2 needs: `EUID`, `UserID`, `Username`, `Description`, `IsTempUser`, `StartAccessDoorsDateAtTimeZone`, `ExpiryDateAtTimeZone`, `ExpiryTimeZone`, `AccessSchedules[]`. Filter `EUList` by exact `Username` match client-side (Kindoo's `keyWord` does substring).
- `revokeUser(session, userId)` → `{ ok: boolean }` — whole-user revoke from the site.
- `revokeUserFromAccessSchedule(session, euId, ruleId)` → `{ ok: boolean }` — scope-specific revoke (one rule). Response is plain `"1"` for success. Shipped but UNUSED by v2.2 — reserved for the future scope-specific remove flow (B-10).

### Orchestration (`provision.ts`)

Two top-level functions:

```ts
provisionAddOrChange(req, seat, stake, buildings, wards, envs, session): Promise<ProvisionResult>
provisionRemove(req, seat, stake, buildings, wards, envs, session): Promise<ProvisionResult>
```

`seat` is the SBA `Seat` doc for the request's subject pre-completion (or `null` if it doesn't exist yet — only possible on a first-ever add for that member, or on a remove that lost an R-1 race). Both paths compute the post-completion seat shape and reconcile Kindoo to it.

#### Kindoo Sites Phase 3 — entry guard (`siteCheck.ts`)

Every orchestrator entry (`provisionAddOrChange`, `provisionRemove`, `provisionEdit`) is gated on `checkRequestSite(...)` in `RequestCard.tsx` — see spec §15 Phase 3. The check runs after `getEnvironments` (which yields the active session's `Name`) and BEFORE any Kindoo write:

- Stake-scope / home-ward requests: expected EID is `stake.kindoo_config.site_id`.
- Foreign-ward requests (`ward.kindoo_site_id` set): expected EID is `kindooSites/<id>.kindoo_eid`.
- Foreign site with no recorded `kindoo_eid`: compare the active session's site name against the doc's `kindoo_expected_site_name` (trim + lowercase). Match → `writeKindooSiteEid(...)` populates the EID, then the orchestrator runs. Mismatch → refuse with `ProvisionSiteMismatchError` ("This request needs to be provisioned on '<expected>'. Switch Kindoo sites and try again.").

`checkRequestSite` is a pure function; it takes `{ request, session, envs, stake, wards, kindooSites }` and returns a discriminated `{ ok: true }` / `{ ok: true, populate }` / `{ ok: false, error }` result. The `kindooSites` array reaches the orchestrator through the `data.getStakeConfig` callable response — extended in Phase 3 to also fetch `stakes/{STAKE_ID}/kindooSites/*`.

Result:

```ts
{
  kindoo_uid: string | null;             // UserID; null only on noop-remove
  action: 'invited' | 'updated' | 'removed' | 'noop-remove';
  note: string;                          // synthesized; persists as provisioning_note
}
```

#### Compute step (ADD path only)

For ADD requests: compute the **post-completion** seat state by merging the request into the current seat:
- `targetBuildings = unique(seat.building_names ∪ seat.duplicate_grants[].building_names ∪ request.building_names)`. Aggregate `seat.building_names` ∪ `duplicate_grants[].building_names` to capture the user's total current scope coverage across all SBA grants. Top-level `seat.building_names` is primary-only by design (per `firebase-schema.md`).
- Resulting `callings` / `duplicate_grants` per SBA's existing merge logic (extension mirrors what `markRequestComplete` will do server-side).

For REMOVE requests: compute the **post-removal** seat state by mirroring the `removeSeatOnRequestComplete` trigger:
- If `seat.scope === request.scope` and `seat.duplicate_grants` is empty → seat is deleted; `targetBuildings = []`.
- If `seat.scope === request.scope` with duplicates → first duplicate promotes to primary; `targetBuildings = unique(promoted.building_names, …rest duplicate building_names)`.
- If a duplicate matches → drop that duplicate; `targetBuildings = unique(seat.building_names, …surviving duplicate building_names)`.

Then for both paths, from `targetBuildings` + `buildings[].kindoo_rule`:
- `targetRIDs = targetBuildings.map(b => buildings[b].kindoo_rule.rule_id)`. Block if any building lacks `kindoo_rule`.

From the merged seat:
- `targetDescription = synthesizeDescription(seat, request, stake, wards, mergeAddIntoSeat, removeScope?)` per the format in decision 6. ADD passes `mergeAddIntoSeat=true`; REMOVE passes `mergeAddIntoSeat=false` and `removeScope=request.scope` so the removed grant drops from the synthesized text.

#### add_manual / add_temp flow

1. Compute `targetBuildings`, `targetRIDs`, `targetDescription` (above).
2. `lookupUserByEmail(session, request.member_email)`.
3. **Not found** (`EUList.length === 0` after exact-username filter):
   - `inviteUser(session, payload)` with description, temp flag, dates, etc. Capture `UserID`.
   - `saveAccessRule(session, UserID, targetRIDs)`.
   - Action: `'invited'`. Note: `"Invited X to Kindoo with access to A, B."`.
4. **Found**:
   - From lookup: `EUID`, `UserID`, current `Description`, `IsTempUser`, `…AtTimeZone` values, `AccessSchedules`.
   - If `targetDescription !== current.Description` OR `request.type === 'add_temp'` (temp flag / dates may need updating):
     - `editUser(session, EUID, { description: targetDescription, isTemp: …, startAccessDoorsDateTime: …, expiryDate: …, timeZone: … })`. Echo current values for anything not being changed.
   - `ridsToAdd = targetRIDs - (currentSchedules ∪ effectiveRulesFromDirectGrants)` via `computeKindooDiff`. The direct-grant subtraction uses the strict-subset chain in `content/kindoo/sync/buildingsFromDoors.ts` (`buildRuleDoorMap` + `getUserDoorIds` + `deriveEffectiveRuleIds`) so a rule whose door set is fully covered by Church Access Automation's direct grants is skipped — never write a redundant AccessSchedule. If `ridsToAdd.length > 0`: `saveAccessRule(session, UserID, ridsToAdd)`. Derivation failure (transient Kindoo error) logs `[sba-ext]` and falls back to `targetRIDs - currentSchedules`.
   - Action: `'updated'`. Note: `"Updated X's Kindoo access to A, B."` (or whatever describes the actual diff).

#### remove flow

Scope-specific, mirroring SBA's `removeSeatOnRequestComplete` trigger:

1. Compute `targetBuildings` (post-removal seat shape; see "Compute step" above), `targetRIDs`.
2. `lookupUserByEmail(session, request.member_email)`.
3. **Not found**: `{ kindoo_uid: null, action: 'noop-remove', note: "User was not in Kindoo (no-op)." }`.
4. **Found**:
   - `toRevoke = currentRIDs \ targetRIDs` → per-rule revoke via `revokeUserFromAccessSchedule(session, EUID, ruleId)` (uses EUID, not UserID — see "Two-IDs gotcha").
   - `toAdd = targetRIDs \ currentRIDs` → rare for a remove flow (only when a promoted duplicate's building wasn't in Kindoo). `saveAccessRule(session, UserID, toAdd)` to merge in.
   - **If `targetRIDs` is empty**: `revokeUser(session, UserID)` to wipe the env-user record entirely. Action: `'removed'`. Note: `"Removed X from Kindoo."`.
   - **Else**: if `targetDescription !== current.Description`, `editUser(session, EUID, …)` to sync. Action: `'updated'`. Note: `"Updated X's Kindoo access to A, B."` (post-removal building set).

#### edit_auto / edit_manual / edit_temp flow

The three edit request types share a single orchestrator entry —
`provisionEdit(req, seat, …)`. Replace-semantics: `request.building_names`
IS the new target set for the matching seat slot; we do NOT union with
the seat's current building set. The edit dialog enforces Policy B for
`edit_auto` (template buildings pre-checked + disabled in the UI).

1. **Stake-auto guard.** `request.type === 'edit_auto'` + `request.scope
   === 'stake'` → throw `ProvisionStakeAutoEditError` before any Kindoo
   read or write. Defense in depth alongside the UI / rules / callable
   layers (spec §6.1 Policy 1).
2. **Date validity (`edit_temp` only).** `tempDatesFor(req)` throws
   `KindooApiError('unexpected-shape', …)` if `start_date` or `end_date`
   are missing.
3. **Compute target RIDs** from `request.building_names` directly via
   `ridsForBuildings`. Same missing-mapping guard as add/remove.
4. **Synthesize target description** by replacing the matching seat
   slot's `reason` with the request's reason (slot resolution mirrors
   `planEditSeat`: primary `(scope, type)` first, then duplicates). For
   `edit_auto` the description is callings-driven so the text doesn't
   change; for `edit_manual` / `edit_temp` the segment's reason is
   replaced verbatim.
5. **`lookupUserByEmail(session, request.member_email)`.** Edit MUST
   find the user — there's no "create as part of an edit" path. Missing
   → throw `ProvisionEditUserMissingError`; operator provisions the
   user via an add request first.
6. **Reconcile rule set** via `computeKindooDiff`:
   - `ridsAlreadyEffective = currentSchedules ∪ effectiveRulesFromDirectGrants`. The direct-grant subtraction comes from `content/kindoo/sync/buildingsFromDoors.ts` (`buildRuleDoorMap` + `getUserDoorIds` + `deriveEffectiveRuleIds`). A rule whose door set is fully covered by Church Access Automation's direct grants is treated as already held; the orchestrator never writes a redundant AccessSchedule for it.
   - `ridsToAdd = targetRids - ridsAlreadyEffective` → `saveAccessRule(session, UserID, ridsToAdd)` (MERGE — preserves unrelated rules on the user).
   - `ridsToRevoke = currentSchedules - targetRids` → per-rule `revokeUserFromAccessSchedule(session, EUID, ruleId)`. Required because `saveAccessRule` cannot shrink. Operates only on AccessSchedules; direct grants are owned by Church Access Automation and can't be revoked from this surface.
   - On derivation failure (transient Kindoo error during the rule-door / user-door reads): log a `[sba-ext]` warning and fall back to the legacy `ridsToAdd = targetRids - currentSchedules`. Provision still completes; worst case we re-introduce the redundant-rule scenario rather than block the operator.
7. **`editUser`** only if description / temp flag / dates differ. For
   `edit_temp` the payload carries `isTemp=true` + the new dates
   (`YYYY-MM-DDTHH:MM` with 00:00 / 23:59 day bounds). For
   `edit_auto` / `edit_manual` the payload echoes the user's existing
   dates so editUser preserves them.
8. **Result** — `action='updated'`. Note: `"Updated X's Kindoo access to
   A, B."` (the post-edit building set) when any Kindoo write
   happened; `"No Kindoo changes needed for X."` when nothing
   differed.

**Note on side-effects in the SBA callable.** The Kindoo write happens
BEFORE `markRequestComplete` is called. If the callable rejects (e.g.
no matching seat slot for the resolved `(scope, type)` pair), the
Kindoo state may already reflect the edit. The orchestrator surfaces
the callable error via the existing partial-success dialog, and the
operator can either retry the SBA side or manually reconcile.

#### After Kindoo (all paths except noop-remove)

Call existing `markRequestComplete` callable with `{ requestId, kindoo_uid, provisioning_note }`. Callable persists on the request doc.

### UI changes

`RequestCard.tsx`:
- Button label: `Add Kindoo Access` / `Remove Kindoo Access` depending on `request.type`.
- Click → button disabled + inline spinner.
- On success → modal-style `ResultDialog` rendered in the panel; dismiss returns to Queue.
- On Kindoo error → spinner clears, error rendered inline. Button re-enabled (re-click resumes — orchestrator is idempotent because of the read-first pattern).
- On Kindoo-OK-but-SBA-fail → result dialog shows partial success with a "Mark Complete in SBA" retry button that calls `markRequestComplete` with the captured `kindoo_uid` + `provisioning_note`.

New `ResultDialog.tsx` — shows the synthesized note + dismiss button.

### Schema additions

**`packages/shared/src/types/request.ts`** — extend `AccessRequest`:

```ts
export type AccessRequest = {
  // … existing fields …
  /** Kindoo UserID captured at provision time. Optional — only set when v2.2 provisioning succeeded. */
  kindoo_uid?: string;
  /** Human-readable summary of what v2.2 did in Kindoo. */
  provisioning_note?: string;
};
```

### Functions changes

**`functions/src/callable/markRequestComplete.ts`** — extend input to optionally accept `kindoo_uid` + `provisioning_note`. Persist both on the request doc in the existing transaction.

### Firestore rules

`stakes/{stakeId}/requests/{requestId}` — managers may write the new optional fields. Standard validator pattern matching v2.1's `kindoo_config` rule.

### New wire-protocol message (SW ↔ CS)

`data.getSeatByEmail({ canonical }): Promise<Seat | null>` — CS asks SW for the SBA seat doc for the request's subject. Used by the orchestrator's compute step. SW reads `stakes/{STAKE_ID}/seats/{canonical}` via Firestore SDK.

### Test surface

- **Unit:** each new endpoint wrapper (envelope assembly, response parsing — happy + each error arm). `revokeUserFromAccessSchedule` covers the plain `"1"` success contract.
- **Unit:** orchestrator compute step (merge math + description synthesis + RID diff detection) — add path only; remove path has no compute step.
- **Unit:** orchestrator branching (mock the Kindoo client + the seat fetch — exercise: new user, existing user no-op, existing user description-only change, existing user rules-only change, existing user both, remove with existing user, remove with user-not-in-Kindoo).
- **Component:** `RequestCard` with the new button + spinner + result dialog. Mock provision module.
- **Functions:** `markRequestComplete` accepts and persists the new optional fields.
- **Rules:** new field writes allowed for managers, denied otherwise.

### UI changes

`RequestCard.tsx`:
- Button label: `Add Kindoo Access` / `Remove Kindoo Access` depending on `request.type`.
- Click → button disabled + inline spinner.
- On success → modal-style result dialog rendered in the panel; dismiss returns to Queue (card disappears).
- On Kindoo error → spinner clears, error rendered inline below the button. Button re-enabled (re-click resumes from CheckUserType / lookup — idempotent).
- On Kindoo-OK-but-SBA-fail → result dialog shows partial success message with a "Mark Complete in SBA" retry button that calls `markRequestComplete` with the captured `kindoo_uid` + provisioning_note (no Kindoo retry).

New `ResultDialog.tsx` component — shows the synthesized note + dismiss button.

### Schema additions

**`packages/shared/src/types/request.ts`** — extend `AccessRequest`:

```ts
export type AccessRequest = {
  // … existing fields …
  /** Kindoo internal user id captured at provision time. Optional — only set when v2.2 provisioning succeeded. */
  kindoo_uid?: string;
  /** Human-readable summary of what v2.2 did in Kindoo. Optional — same shape contract as `completion_note`. */
  provisioning_note?: string;
};
```

### Functions changes

**`functions/src/callable/markRequestComplete.ts`** — extend input schema to optionally accept `kindoo_uid` + `provisioning_note`. Persist both on the request doc in the same transaction that flips status to complete. The auditTrigger picks them up automatically.

Input validation: both fields optional; when present, both must be strings; `provisioning_note` max length ~500 chars.

### Firestore rules

`stakes/{stakeId}/requests/{requestId}` — managers may write `kindoo_uid` and `provisioning_note` (in addition to whatever fields they can already write at completion). Standard validator pattern matching v2.1's `kindoo_config` rule.

### Test surface

- **Unit:** each new endpoint wrapper (request envelope, response parsing — happy + each error arm). Mock `fetch`.
- **Component:** `RequestCard` with the new button + spinner + result dialog. Mock the provision module.
- **Integration:** orchestration paths (mock the Kindoo client, exercise each branch — new user, existing user, no-op remove, Kindoo-OK-SBA-fail).
- **Functions:** `markRequestComplete` accepts and persists the new optional fields.
- **Rules:** new field writes allowed for managers, denied otherwise.

### Phasing within v2.2

**One PR.** add / remove / change flows share most of the code (lookup, error handling, payload assembly); splitting would multiply review surface without reducing risk.

## Out of scope for v2

- Auto-creating Access Rules in Kindoo. The operator does this in Kindoo's admin UI; the extension only references existing rules.
- Mutating Kindoo's site-level config (site name, capacity, etc.).
- Bulk operations. Each request is its own provision call.
- Multi-stake (Phase 12). The config schema is stake-scoped already (Stake doc + per-building); multi-stake will work without re-design.
- Time-of-day on temp requests. Full-day bounds used in v2.2; if a manager needs finer control they can edit the user in Kindoo directly post-provision.

## Open follow-ups (post-v2.2)

- Operator-configurable Description template per stake.
- Disambiguation when `lookupUserByEmail` returns multiple matches (defer until it actually happens).
- Verify `KindooRevokeUserFromEnvironment` semantics — does it remove site access only, or all access globally? Name suggests environment-scoped; confirm with a post-revoke check.

## Capture reference

API request/response shapes captured live: `extension/docs/v2-kindoo-api-capture.md` (gitignored, has real session tokens). v2.1 implementation should fixture against those for tests.
