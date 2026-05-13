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

## v2.2 — Provision & Complete (outline)

To be designed in detail before implementation. Key shape:

- "Mark Complete" button → "Provision & Complete."
- On click, content script:
  1. Read SessionTokenID + EID from localStorage. Fail-fast if missing.
  2. Validate the relevant buildings all have `kindoo_rule` set. If not, block + offer Reconfigure.
  3. For `add_manual` / `add_temp`: `KindooCheckUserTypeInKindoo` → if new, `KindooCheckUserTypeAndInviteAccordingToType` → `KindooSaveAccessRuleFromListOfAccessSchedules(RIDs)`.
  4. For `remove`: `KindooGetEnvironmentUsersLightWithTotalNumberOfRecords` (lookup) → `KindooRevokeUserFromEnvironment`.
  5. For change-access (existing user, different rules): `SaveAccessRuleFromListOfAccessSchedules` with the new RIDs. No new SBA RequestType — falls out of the existing flow naturally when an `add_manual` targets a user Kindoo already knows about.
  6. On Kindoo success → call SBA's existing `markRequestComplete` callable.
  7. On Kindoo-succeeded-but-SBA-failed: show a recovery button "Mark Complete" (SBA-only retry; Kindoo work already done).

Constants per request:
- `UserRole=2` always.
- `CCInEmail=false` (matches current operator default).
- `IsTempUser=true` for `add_temp`, else `false`.
- `StartAccessDoorsDate` / `ExpiryDate` from `request.start_date` / `request.end_date` for `add_temp`; `null` otherwise.
- `ExpiryTimeZone="Mountain Standard Time"` — hardcoded for v1 single-stake. Future per-stake field if we expand.
- `Description`: synthesized from `request.scope` + `request.reason`. Format per the observed convention: `Ward Name (Reason)` or `Stake Name (Reason)`. (See `v2-kindoo-api-capture.md` § "Add-user form".)

## Out of scope for v2

- Auto-creating Access Rules in Kindoo. The operator does this in Kindoo's admin UI; the extension only references existing rules.
- Mutating Kindoo's site-level config (site name, capacity, etc.).
- Bulk operations. Each request is its own provision call.
- Multi-stake (Phase 12). The config schema is stake-scoped already (Stake doc + per-building); multi-stake will work without re-design.

## Open follow-ups for v2.2 (do not block v2.1)

- Per-stake `ExpiryTimeZone` config — currently a hardcoded constant.
- Description templating — should it be operator-configurable per stake?
- Error recovery: when Kindoo's `Invite` succeeds but `SaveAccessRule` fails, the user is half-created. Need a "retry rule only" button or a redo-from-step.
- Soft-delete semantics on remove. Does `KindooRevokeUserFromEnvironment` delete the user record or just unlink them from this environment? Capture confirms the latter (the name suggests `Environment`-scoped removal). Need to verify they don't keep door access via another path.

## Capture reference

API request/response shapes captured live: `extension/docs/v2-kindoo-api-capture.md` (gitignored, has real session tokens). v2.1 implementation should fixture against those for tests.
