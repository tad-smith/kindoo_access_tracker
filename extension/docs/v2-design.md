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

### Wire-protocol additions (SW ↔ CS)

v2.1 is content-script-side for everything Kindoo-related (per locked-in CS decision in v1). Firestore reads of `stakes/{stakeId}` + buildings happen from the SW via the existing `extensionApi.ts` boundary; the CS asks the SW for principal + stake + buildings data.

New message types (TBD names, in `lib/messaging.ts`):
- `data.getStakeConfig` → response: `{ stake: Stake, buildings: Building[] }`
- `data.writeKindooConfig` → input: `{ siteId, siteName, buildingRules: Record<buildingId, { ruleId, ruleName }> }` → response: success/error

Firestore writes are done by the SW (it owns the Firebase Auth session) in a single batched write.

### Test surface

- **Unit:** Kindoo client (`KindooGetEnvironments`, `KindooGetEnvironmentRules` parsing). Mock `fetch`.
- **Component:** Configure panel — happy path, site-mismatch, missing-rule validation. Mock the extensionApi boundary.
- **Rules:** Firestore rule tests for the new field writes (manager allowed; non-manager denied).
- **No E2E** for v2.1 — Playwright MV3 + Kindoo is still deferred.

## v2.2 — Provision & Complete

Closes the loop: from the same panel, the manager provisions (add / remove / change-access) the user in Kindoo with one click, then SBA's request flips to complete.

### Locked-in decisions (v2.2)

1. **No confirmation dialog before provisioning.** The RequestCard already shows everything (email, scope, buildings, reason, type); a "are you sure?" step adds friction without value. Operator chose Option B for this reason.
2. **Button label varies by request type:**
   - `add_manual` / `add_temp` → `Add Kindoo Access`
   - `remove` → `Remove Kindoo Access`
   - Existing user matched on an add request → still `Add Kindoo Access` (the UI doesn't tell add-vs-change-access apart; it's the same flow).
3. **Result confirmation dialog after every action.** Synthesized message describes what was done. Same dialog text is persisted on the request doc as a `provisioning_note` for audit traceability.
4. **Single spinner during the call** — no per-step progress. Escalate to multi-step if calls turn out to be slow.
5. **Description format**: `${scopeName} (${request.reason})`. `scopeName` resolves to the ward's `building_name`-equivalent display (read from the ward doc) for ward scope, or the stake name for stake scope.
6. **ExpiryTimeZone**: re-fetched from `KindooGetEnvironments` at provision time. Use the env entry's `TimeZone` field verbatim — already in Kindoo's wire format. No IANA↔Windows mapping needed.
7. **Temp-request date format**: full-day bounds. `StartAccessDoorsDate = ${request.start_date} 00:00`, `ExpiryDate = ${request.end_date} 23:59`. No time-of-day field added to SBA's request schema in v2.2; defer if anyone wants finer control.
8. **Remove with user-not-in-Kindoo**: auto-complete the SBA request as a no-op. Mirrors SBA's existing R-1 race annotation pattern (`completion_note: "User was not in Kindoo (no-op)"`). Operator sees the result dialog noting the no-op.
9. **Existing-user-on-add**: silent update path. CheckUserType returns existing → skip invite → SaveAccessRule with the new RIDs. The result dialog text reflects what actually happened ("Updated X's access" vs "Added X").
10. **Audit**: extend `markRequestComplete` to accept optional Kindoo metadata. Persist on the request doc; no new collection. Captured via the existing auditTrigger.

### Architecture

All Kindoo work runs in the content script (same as v2.1 — already on `web.kindoo.tech`, has `host_permissions` for `service89.kindoo.tech`, can read `localStorage.kindoo_token`). SBA `markRequestComplete` continues to round-trip through the SW.

```
extension/src/content/kindoo/
├── client.ts               (existing — multipart envelope)
├── auth.ts                 (existing — read SessionTokenID + EID)
├── endpoints.ts            (existing read-only + NEW write endpoints)
└── provision.ts            (NEW — orchestration)
```

New endpoint wrappers in `endpoints.ts` (response shapes added to gitignored captures once each is exercised in staging):

- `checkUserType(session, email)` → `{ exists: boolean; uid: string | null }`
- `inviteUser(session, payload)` → `{ uid: string }` (single-user invite — extracts UID from response)
- `saveAccessRule(session, uid, rids[])` → `{ ok: boolean }`
- `lookupUserByEmail(session, keyword)` → `{ users: Array<{ uid, email, ... }> }` (paginated; v2.2 takes the first match)
- `revokeUser(session, uid)` → `{ ok: boolean }`

### Orchestration (`provision.ts`)

Three high-level functions:

```ts
provisionAddOrChange(req, stake, buildings, env, session): Promise<ProvisionResult>
provisionRemove(req, session): Promise<ProvisionResult>
```

Where `ProvisionResult` is:
```ts
{
  kindoo_uid: string | null;        // null only on no-op (remove-not-in-kindoo)
  action: 'added' | 'updated' | 'removed' | 'noop-remove';
  note: string;                     // human-readable summary; persists as provisioning_note
}
```

#### add_manual / add_temp flow

1. Resolve RIDs from `request.building_names` via `buildings[].kindoo_rule.rule_id`. Block if any building lacks a mapped rule.
2. Resolve ExpiryTimeZone from env (already-fetched at panel mount; one extra getEnvironments call cached for the session).
3. Resolve Description: `${scopeName} (${request.reason})`.
4. `checkUserType(session, request.member_email)`.
5. If not exists: `inviteUser(session, payload)` with the temp/permanent flags, dates, etc. Capture returned UID.
6. `saveAccessRule(session, uid, rids)`.
7. Synthesize note: `"Added X to Kindoo with access to Cordera Building, Pine Creek Building."` or `"Updated X's Kindoo access to Cordera Building."` based on the checkUserType branch.

#### remove flow

1. `lookupUserByEmail(session, request.member_email)`. First match wins (Kindoo's email index makes collisions extremely unlikely in practice; if multiple, future-us can add disambiguation).
2. If no match: return `{ kindoo_uid: null, action: 'noop-remove', note: 'User was not in Kindoo (no-op).' }`.
3. `revokeUser(session, uid)`.
4. Synthesize note: `"Removed X from Kindoo."`.

#### After Kindoo

Call existing `markRequestComplete` callable with `{ requestId, kindoo_uid?, provisioning_note? }`. Callable persists on the request doc.

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
