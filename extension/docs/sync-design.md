# Sync — design (Phase 1 + Phase 2 outline)

A new feature on top of the v2.2 extension: surface drift between SBA's seat state and Kindoo's user state, so a manager can spot and fix divergence before it grows.

Two phases:

| Phase | Ships | Why first |
|---|---|---|
| **Phase 1 — Read-only sync report** | New `SyncPanel` accessed via a "Sync" link in the Queue header. Reads all SBA seats + all Kindoo environment-users + auto-calling templates. Parses Kindoo descriptions, classifies intended seat shape, reports discrepancies in a list. No write actions. | Low-risk visibility. Lets the operator see the actual shape of drift before designing fix actions. |
| **Phase 2 — Fix actions** | Per-row "Fix this" button next to each discrepancy. Each action either pushes a Kindoo provision (using v2.2's orchestrator) or creates an SBA request (via a new callable). Direction-of-truth resolved per discrepancy type. | Cannot land before Phase 1 — needs the diff catalog to know what fix actions are needed and at what granularity. |

This doc covers Phase 1 in detail. Phase 2 is outlined and gets its own design pass before implementation.

## Locked-in decisions

1. **Phased: read-only first, fix actions later.** Operator wants visibility before deciding remediation surface area.
2. **UI surface:** new panel state inside the existing slide-over, reached via a "Sync" link in the Queue header (alongside "Configure Kindoo"). NOT a separate tab/window.
3. **Trigger:** explicit operator click only. No periodic/background sync.
4. **Performance:** batch read all data, render the report in one shot when reads complete. Show a spinner during the read. No streaming.
5. **Unparseable descriptions** (don't match `Scope (Calling)[ | Scope (Calling)]`): assume **manual seat with unknown scope** and **flag for review**. Operator decides what to do.
6. **Kindoo Manager accounts** (manager's own account + any other Kindoo Manager): their descriptions typically don't fit the convention (e.g. `Kindoo Manager - Stake Clerk account`); they fall through to "unparseable" + flagged for review naturally. No special-case skip.
7. **No backend changes in Phase 1.** All reads go through existing collection-level Firestore reads (already allowed for managers) + the existing paginated Kindoo `GetEnvironmentUsersLight` endpoint.

## Phase 1 — Read-only sync report

### Data reads

Run in parallel during a single spinner state on `SyncPanel`:

**From SBA (Firestore, via new SW message `data.getSyncData`):**
- All seats under `stakes/{STAKE_ID}/seats/*`.
- All wards under `stakes/{STAKE_ID}/wards/*` (for ward-name → ward_code resolution; and for Kindoo Sites Phase 4, the optional `kindoo_site_id` on each ward).
- All buildings under `stakes/{STAKE_ID}/buildings/*` (for Kindoo-rule → building-name resolution via the v2.1 config).
- All ward calling templates under `stakes/{STAKE_ID}/wardCallingTemplates/*` (auto-calling sets per ward).
- All stake calling templates under `stakes/{STAKE_ID}/stakeCallingTemplates/*` (auto-calling set for stake scope).
- All Kindoo Sites under `stakes/{STAKE_ID}/kindooSites/*` (foreign-site directory — see `docs/spec.md` §15). Used by the Phase 4 active-site filter to map the live EID to home / `foreign(siteId)` / unknown.
- The stake doc itself (for `stake_name`, `kindoo_expected_site_name`, `kindoo_config.site_id` (Phase 4 home-EID match), etc).

**From Kindoo (content script, paginated):**
- Loop `KindooGetEnvironmentUsersLightWithTotalNumberOfRecords` with `start = 0, 50, 100, …` until `EUList.length < 50` (or `TotalRecordNumber` reached). Standard envelope.
- The response includes `Description`, `IsTempUser`, `UserID`, `EUID`, `AccessSchedules[]` per user — everything we need for classification.

Both reads happen client-side (CS for Kindoo, SW for Firestore). The content script orchestrates: ask SW for SBA data, fire Kindoo loop in parallel, wait for both, render.

### Description parser (`sync/parser.ts`)

Pure function. Takes a description string + the wards array (for name → code resolution) + stake name. Returns:

```ts
type ParsedDescription = {
  segments: ParsedSegment[];
  unparseable: boolean;   // true if no segment could be matched
  raw: string;
};

type ParsedSegment = {
  rawScopeName: string;          // e.g. "Maple Ward"
  scope: 'stake' | string;       // resolved: ward_code or 'stake'
  calling: string;               // free-text from parens
  resolvedScope: boolean;        // true if scope name matched a known ward/stake
};
```

Algorithm:
1. Split on ` | ` (the cross-scope separator) → raw segments.
2. For each, regex `^(.+?) \((.+)\)\s*$` → `scopeName`, `calling`.
3. Resolve `scopeName`:
   - Exact match against `stake.stake_name` (case-insensitive, trimmed) → `scope = 'stake'`.
   - Exact match against any `ward.ward_name` → `scope = ward.ward_code`.
   - No match → `resolvedScope = false`.
4. `unparseable = segments.every(s => !s.resolvedScope)`.

Multi-calling within a single segment (`Maple Ward (Elders Quorum First Counselor, Accompanist)`) → calling field contains the comma-joined raw text; the classifier splits on `, ` when it needs to check each individually.

### Classifier (`sync/classifier.ts`)

For each parsed segment + the user's `IsTempUser` flag, compute the intended seat shape:

```ts
type IntendedSeatShape = {
  scope: 'stake' | string;
  type: 'auto' | 'manual' | 'temp';
  callings: string[];      // for auto, the matched callings; otherwise []
  freeText: string;        // unmatched leftover from the parens
};
```

Algorithm:
1. If `IsTempUser === true`: every segment's type = `'temp'`. Skip auto-template check.
2. Else: split `segment.calling` on `, ` to get individual callings.
3. For each individual calling:
   - For stake scope: look up against `stakeCallingTemplates/*` calling-name set. Match → it's auto.
   - For ward scope: look up against `wardCallingTemplates/*` calling-name set for that ward (templates may be scoped per ward). Match → auto.
4. If ALL individual callings in the segment match the auto set → segment type = `'auto'`; collect matched callings.
5. If NONE match → segment type = `'manual'`; the calling text becomes the `reason` equivalent.
6. Mixed (some match, some don't) → segment type = `'auto'` with `reviewMixed: true`; the auto calling drives the type (the user IS an auto seat), the unmatched callings are carried in `freeText` so the detector can ask the operator to add them to the SBA seat.

Resulting per-user shape:
- If multiple parsed segments → one primary + duplicates.
- **Primary-pick rule (`pickPrimarySegment`):** prefer a segment that auto-matches the calling templates; among auto-matching segments — and as the fallback when none auto-match — apply SBA's existing `pickPrimaryScope` ordering (stake > ward, alphabetical by `ward_code` among wards). Rationale: a non-auto stake calling alongside an auto ward calling is a common real shape (e.g. `Colorado Springs North Stake (Technology Specialist) | Mount Herman YSA Ward (Bishop)`); the SBA seat lives on the ward (`scope=MH/auto/Bishop`). The pre-auto-pref rule picked the stake segment as primary and emitted a false-positive `scope-mismatch`. Preferring an auto-matching segment first lines primary up with the side SBA actually seats on.

### Discrepancy detector (`sync/detector.ts`)

Iterate over the union of (SBA seat emails) ∪ (Kindoo user emails). For each email:

| SBA side | Kindoo side | Discrepancy code |
|---|---|---|
| seat present | no Kindoo user | `sba-only` |
| no seat | Kindoo user present | `kindoo-only` |
| seat | Kindoo user, unparseable | `kindoo-unparseable` (flag for review) |
| seat | Kindoo user, parsed primary scope ≠ seat.scope | `scope-mismatch` |
| seat (manual/auto, not temp) | grant-based promote/demote — see Stage 1 (c) | `type-mismatch` |
| seat (any type) | Kindoo user, `derivedBuildings` ≠ seat.building_names | `buildings-mismatch` |
| seat (manual/temp) | Kindoo user, `derivedBuildings === null`, accessSchedules' rule set ≠ seat.building_names mapped to RIDs via v2.1 config | `buildings-mismatch` (AccessSchedules fallback) |
| seat (auto) | Kindoo user, `derivedBuildings === null` (per-user derivation failed) | (buildings check skipped — fallback) |
| seat | Kindoo parsed callings ⊋ seat `callings[]` ∪ `reason` — see Stage 1 (e) | `extra-kindoo-calling` (flag for review — operator adds the missing calling(s) to the SBA seat) |
| seat | Kindoo user, all-good | (no row) |

Severity:
- `sba-only`, `kindoo-only`, `scope-mismatch`, `type-mismatch`, `buildings-mismatch` → **drift** (real divergence).
- `kindoo-unparseable`, `extra-kindoo-calling` → **review** (operator-judgment needed).

**Auto-user buildings derivation.** Auto-imported users (the Church Access Automation flow, ~310 of 313 csnorth users in production) receive door access via **direct door grants keyed by `VidName`**, not via `AccessSchedules`. The bulk listing (`KindooGetEnvironmentUsersLightWithTotalNumberOfRecordsWithEntryPoints`) only exposes `AccessSchedules` — direct grants are excluded.

To reconcile auto users, the Sync run derives each user's effective building set from their per-door grants. The chain (implemented in `content/kindoo/sync/buildingsFromDoors.ts`):

1. **`buildRuleDoorMap`** — one `KindooGetEnvRuleWithEntryPointsFormatted` call per AccessRule referenced by an SBA building (csnorth has 4 → 4 calls). Each rule's response carries every door in the environment with `IsSelected: true` on the doors belonging to the queried rule. The map: `RuleID → Set<DoorID>`.
2. **`getUserDoorIds`** — one `KindooGetUserAccessRulesLightWithTotalNumberOfRecordsWithEntryPoints` call per Kindoo user (313 calls in csnorth). Paginated with `start += 40`. Every row carries a `DoorID` regardless of grant origin (rule-derived vs direct Church Access Automation grant via `AccessScheduleID === 0`). The flattened, deduplicated set is the user's effective door set.
3. **`deriveEffectiveRuleIds`** — pure function. A user "effectively holds" a rule iff EVERY DoorID in that rule's door set is present in the user's door set. Strict subset; partial overlap does not claim the rule. Empty rule door sets are explicitly guarded against (would otherwise vacuously match every empty rule).
4. **`derivedBuildingNames`** — pure function. Map effective RuleIDs to SBA building names via `building.kindoo_rule.rule_id`. Returns a deduplicated, alphabetically-sorted array.

The `SyncPanel` orchestrates the per-user loop with a concurrency cap (4 in flight) and a throttled progress text ("Reading Kindoo user N of M…", updated every 10 users so the React reconciler stays responsive). Each user's `KindooEnvironmentUser` is enriched with `derivedBuildings: string[] | null` BEFORE the detector runs. On per-user failure the field is set to `null` and the loop continues — one user's network blip does not fail the whole sync. Consequence: a `null` (per-user door-read blip) can surface a manual/temp `buildings-mismatch` row whose "Update SBA" button is disabled (it refuses to source from the AccessSchedules fallback); the resolution is to re-run Sync.

The detector's `buildings-mismatch` rule then, for ALL seat types:
- `derivedBuildings: string[]` (direct + rule grants): the authoritative Kindoo door-access signal — compare against it. Applies to auto, manual, and temp alike.
- `derivedBuildings: null`, manual / temp: fall back to the AccessSchedules-derived `buildingNames`.
- `derivedBuildings: null`, auto: skip the check (fallback — when derivation failed, we'd rather show nothing than false drift).

Wall-time estimate: ~313 per-user calls at concurrency 4 and ~150 ms median latency → ~12 s. The summary header still surfaces seat / user counts; the operator sees the per-user progress while the loop runs.

**`kindoo-only` rows with `intended.type === 'auto'` are NOT filtered.** Even when the Kindoo user's description classifies as auto, the absence of an SBA seat is still drift — these users need to be imported into SBA. The drift row stays.

**Active-site filter (Kindoo Sites Phase 4 — see `docs/spec.md` §15).** The detector takes an optional `activeSite: ActiveSite` input resolved by `content/kindoo/sync/activeSite.ts` from the live EID (`localStorage.state.sites.ids[0]`), `stake.kindoo_config.site_id`, and each `KindooSite.kindoo_eid`. The filter scopes both sides of the diff to seats / users belonging to the active Kindoo site so a session pointed at the home site does not flag foreign-site grants as drift (and vice versa):

- `home` — Include seats whose `scope === 'stake'` (Phase 1 policy: stake-scope seats are home-only) and seats whose scope is a ward with `kindoo_site_id` null / absent. Include Kindoo users whose parsed primary segment resolves to one of those wards or to the stake; on home, unparseable / unresolvable Kindoo users are also kept so the historical `kindoo-only` / `kindoo-unparseable` rows still surface.
- `foreign(siteId)` — Include only seats whose scope is a ward with `kindoo_site_id === siteId`. Stake-scope seats and unparseable Kindoo users are excluded. Include only Kindoo users whose parsed primary segment resolves to one of those wards — home-ward users and other-foreign-ward users belong to a different manager's queue and are dropped entirely (no `kindoo-only` drift row).
- `unknown` — Active EID matches neither home nor any configured `KindooSite`. The detector returns an empty diff; the panel renders an empty-state recovery message and skips the report entirely (and the door-grant enrichment loop is short-circuited up front in `SyncPanel`).

The summary counters surface the FILTERED seat / user totals so the operator sees the comparison scope, not the raw collection sizes.

### UI (`SyncPanel.tsx`)

States:
- `idle` — initial render with a "Run Sync" button + brief explanation.
- `loading` — spinner + status text ("Reading SBA + Kindoo…").
- `report` — discrepancy list rendered.
- `error` — spinner clears, error rendered with retry button.

Report rendering:
- Header: `Found X drift items, Y need review. SBA: N seats. Kindoo: M users.`
- Filter chips: All / Drift only / Review only (default: All).
- Row: email, side-by-side SBA + Kindoo blocks, discrepancy reason in plain text, severity badge.
- Sort: severity (drift first, then review), then alphabetical by email.
- No fix buttons in Phase 1.
- "Back to Queue" button.

Entry point: a "🔍 Sync" link in the Queue header (alongside "⚙ Configure Kindoo"). Click → routes to the Sync panel state.

### Wire protocol additions

`extension/src/lib/messaging.ts`:

```ts
{
  type: 'data.getSyncData';
}
// response:
type SyncDataBundle = {
  stake: Stake;
  wards: Ward[];
  buildings: Building[];
  seats: Seat[];
  wardCallingTemplates: WardCallingTemplate[];
  stakeCallingTemplates: StakeCallingTemplate[];
};
```

SW handler in `background/messages.ts` + `background/data.ts` reads each collection via the Firebase SDK.

CS-side wrapper in `lib/extensionApi.ts`: `getSyncData(): Promise<SyncDataBundle>`.

### Kindoo client additions

`extension/src/content/kindoo/endpoints.ts`:

```ts
listAllEnvironmentUsers(session, fetchImpl?): Promise<KindooEnvironmentUser[]>
```

Internally loops `GetEnvironmentUsersLight` with `start += 50` until exhaustion. Uses the existing `KindooEnvironmentUser` parser. Returns the full list.

### Files

New:
- `extension/src/content/kindoo/sync/parser.ts` + `parser.test.ts`
- `extension/src/content/kindoo/sync/classifier.ts` + `classifier.test.ts`
- `extension/src/content/kindoo/sync/detector.ts` + `detector.test.ts`
- `extension/src/panel/SyncPanel.tsx` + `SyncPanel.test.tsx`
- `extension/src/panel/sync-row.css` (or fold into `panel.css`)

Modified:
- `extension/src/panel/QueuePanel.tsx` — add "Sync" link in header
- `extension/src/panel/App.tsx` — add 'sync' state to the router
- `extension/src/lib/messaging.ts` — new `data.getSyncData` wire type
- `extension/src/lib/extensionApi.ts` — new wrapper
- `extension/src/background/messages.ts` — new handler
- `extension/src/background/data.ts` — new reader for seats + calling templates
- `extension/src/content/kindoo/endpoints.ts` — new `listAllEnvironmentUsers`
- `extension/src/manifest.config.ts` — version `0.3.6 → 0.4.0` (minor, new feature)
- `extension/CLAUDE.md` — document the new module
- `extension/docs/v2-kindoo-api-capture.md` — note multi-page paginated read pattern (if any new shape observed)

### Test surface

- **Parser:** every shape variant (single segment stake / ward / cross-scope two segments / cross-scope three segments / unparseable random text / segment with no parens / segment with mismatched scope name).
- **Classifier:** each calling outcome (auto-match / no-match / mixed callings / temp override).
- **Detector:** each discrepancy code + the all-good no-emit case.
- **Endpoint:** `listAllEnvironmentUsers` happy path with 2 + 3 pages; truncation when `TotalRecordNumber < (pages × 50)`.
- **Component:** `SyncPanel` happy path (idle → loading → report); empty report; error state.
- **Wire-protocol:** `data.getSyncData` SW handler reads expected collections.

### Out of scope for Phase 1

- Any write actions. The report is read-only.
- Filtering / search beyond the basic severity chips.
- Pagination of the report itself (all rows render at once; 313 users → ~150-200 discrepancy rows worst case; renders fine in a single scroll).
- Background / scheduled sync.
- Export to CSV.

## Phase 2 — Fix actions (locked in 2026-05-13)

Each discrepancy row gains one or two specific-action buttons. Per-row only — no bulk fix. Trust-fire model: no confirmation dialog, no success toast. Click → applying state → row removed from the list (on success) or inline error + Retry (on failure). The operator runs a fresh sync when they want a clean state.

### Fix-action catalogue

| Code | Buttons | What happens |
|---|---|---|
| `sba-only` | "Provision in Kindoo" | Kindoo-side write via `syncProvisionFromSeat`. Inviting if absent; description rewrite + per-rule reconcile if existing. |
| `kindoo-only` | "Create SBA seat" | SBA-side: `syncApplyFix` with `code: 'kindoo-only'`. Server-side stamps the seat write with `SyncActor:kindoo-only`. |
| `extra-kindoo-calling` | "Add to SBA seat" | SBA-side: `syncApplyFix` with `code: 'extra-kindoo-calling'`; backend de-dupes + appends to `callings[]`. |
| `scope-mismatch` | "Update Kindoo" / "Update SBA" | Update Kindoo: rewrite Description to SBA scope via `syncProvisionFromSeat`. Update SBA: `syncApplyFix` with `code: 'scope-mismatch'` carrying Kindoo's parsed primary scope. |
| `type-mismatch` | "Update SBA" only | **Superseded by Stage 1 (c).** Grants own the type decision (promote/demote), so the only action is Update SBA, which flips the seat to the grant-derived target (`grantTargetType`) via `syncApplyFix` with `code: 'type-mismatch'`. No "Update Kindoo" — the extension can't write church grants; revoke-on-promote is Stage 2. |
| `buildings-mismatch` | "Update Kindoo" / "Update SBA" | Update SBA sources from `derivedBuildings` (the direct + rule-grant strict-subset chain) for ALL seat types — never the AccessSchedules-derived `buildingNames`, which misses direct grants and would wipe buildings for auto users. Update SBA refuses (button disabled) when `derivedBuildings === null` (per-user door read failed). Update Kindoo: manual/temp reconciles AccessSchedules to SBA's building set (per-rule revoke + saveAccessRule merge); auto is disabled (Church Access Automation owns direct door grants). |
| `kindoo-unparseable` | none | Operator handles in Kindoo's admin UI. |

### Audit + SyncActor

Every backend-side seat write made by `syncApplyFix` is stamped with `lastActor: SyncActor:<code>` where `<code>` is the discrepancy code that triggered it. The parameterised `auditTrigger` fans an audit row off the resulting Firestore write the same way every other write goes through audit — Sync writes don't bypass anything.

The `SyncActor:` prefix is recognised by the web renderer's `isAutomatedActor` helper and rendered with the automated-actor chip in the audit log + dashboard, alongside `Importer` / `ExpiryTrigger` / `RemoveTrigger` / `OutOfBand`. Helpers (`syncActorName`, `parseSyncActorCode`, `SYNC_DISCREPANCY_CODES`) live in `packages/shared/src/systemActors.ts`.

Kindoo-side writes (`sba-only`, every `*-mismatch` "Update Kindoo") don't reach Firestore — they're Kindoo API calls and have no SBA audit row by design. The seat docs themselves don't change on those paths.

### Per-row state machine

- `idle` — buttons visible.
- `applying` — buttons replaced by "Applying \<label\>…" text + `aria-live="polite"` so screen readers announce the in-flight state.
- success — splice the row out of the local list. Drift / review counters in the summary decrement automatically (counters are derived from the rendered list, not the raw detector output).
- `error` — inline danger-coloured message in the row + a single "Retry" button that re-fires the last attempted action.

No detector re-run on success: the in-memory list edits forward. The operator clicks "Run Sync" again to get a clean state from scratch.

### Sourcing payload data

Most payload fields come straight off the `Discrepancy` row's `kindoo` block (`KindooBlock`). The detector's Phase 2 work expanded that block to carry `memberName`, `intendedCallings`, `intendedFreeText`, `buildingNames`, `derivedBuildings`, and (for temp users) `startDate` / `endDate` — derived from Kindoo's `FirstName` / `LastName` + the classifier output + the rule-id-to-building-name lookup + the door-grant derivation. `KindooEnvironmentUser`'s `startAccessDoorsDateAtTimeZone` / `expiryDateAtTimeZone` are stripped to ISO `YYYY-MM-DD` for the temp date fields.

`kindoo-only` seat creation prefers `derivedBuildings` for ALL seat types when non-null, falling back to the AccessSchedules-derived `buildingNames` only when the per-user door read failed (`null`). Unlike the buildings-mismatch "Update SBA" path (which refuses when `derivedBuildings === null`), creating a fresh seat with whatever building data the sync had is acceptable — the seat isn't being destroyed, and the operator can repair it later via Update SBA. Edge cases:
- `intendedType === 'auto'` → callings = `intendedCallings`; no reason.
- `intendedType === 'manual'` → callings = comma-split `intendedFreeText`; reason = full `intendedFreeText`.
- `intendedType === 'temp'` → callings = `[]`; reason = `intendedFreeText`; `startDate` / `endDate` set when present.
- `intendedType === null` (couldn't classify) → fall through as `manual` with the free text as reason.

The building source matters because the bulk listing's AccessSchedules excludes Church Access Automation direct grants. `derivedBuildings` is the authoritative Kindoo door-access signal (covers BOTH direct and rule-based grants via the door-set strict-subset chain), so it is preferred for every seat type, not just auto.

### Files

New:
- `extension/src/content/kindoo/sync/fix.ts` + `fix.test.ts` — dispatcher + payload builder.
- `extension/src/content/kindoo/sync-provision.ts` — Kindoo-side orchestrator that drives Kindoo to a single `Seat`. Sibling of `provision.ts`; reuses the same low-level endpoint helpers without piping through the request-driven merge path.

Modified:
- `extension/src/content/kindoo/sync/detector.ts` — `KindooBlock` extended with `memberName` + classifier fields + building names + temp dates.
- `extension/src/panel/SyncPanel.tsx` — per-row Fix UI + state machine.
- `extension/src/lib/messaging.ts` — `data.syncApplyFix` wire type.
- `extension/src/lib/api.ts` — SW-side callable wrapper.
- `extension/src/background/messages.ts` — dispatcher routes `data.syncApplyFix`.
- `extension/src/lib/extensionApi.ts` — CS-side wrapper.

### Out of scope (deferred to future)

- Bulk fix ("Fix all SBA-only" etc.) with summary preview. Single-row is enough for v1 traffic.
- Per-row confirmation dialogs. Operator chose trust-fire.
- Undo affordance. Operator can run sync again and fix forward.
- Sync-driven Firestore writes that bypass the callable. Every SBA write goes through `syncApplyFix`.
- Writing auto-user door grants from the extension (Church Access Automation territory). Auto seats can't be type-changed and can't have their Kindoo-side buildings written via Update Kindoo in Phase 2 — Update SBA on `buildings-mismatch` is allowed and reconciles SBA to `derivedBuildings`.

## Grant-derived seat type (Stage 1 + Stage 2 — locked 2026-05-30)

> Supersedes the template-based half of the **Classifier** section above. Motivated by a
> real incident: a `manual` seat whose building door access came entirely from Church
> Access Automation **direct grants**, invisible to every existing drift check. Per
> `docs/architecture.md` D14 / T-45 the LCR importer is gone and Sync is now the **sole
> auto-seat source**, so changing how Sync decides `type` changes how every auto seat is born.

### The principle

`auto` vs `manual` is a **provenance** label — *who owns provisioning the Kindoo grant*:
the church (`auto`, SBA writes no rule) or SBA (`manual`, SBA writes/revokes an AccessRule).
Today that's *predicted* from per-stake `auto_kindoo_access` calling templates. A per-stake
template is a guess at a churchwide, church-controlled behaviour, so it drifts (the incident).
We replace the prediction with **observation**: a seat is `auto` iff the member actually holds
the seat's building doors via direct grants.

Two axes that look correlated but aren't (the root of the bug):

- *Door-access state* — does the member hold the doors? (**observable**)
- *Provenance* — should SBA or the church own the grant? (**what `type` means**)

Grants are authoritative for the first; `type` encodes the second. We let observed grants
*drive* the second under the policy "church grants the doors ⇒ the church owns them ⇒ `auto`."

### Lifecycle (self-healing convergence)

- **Birth:** every seat is born `manual`. (Already true — the request path only mints
  `add_manual` / `add_temp`; `markRequestComplete` never sets `auto`.) `temp` is unchanged
  throughout — it's `IsTempUser` + expiry, never grant-derived.
- **Promote `manual → auto`:** when Sync observes the member holds the seat's building doors
  via direct grants. Flip `type`; if SBA had written its own rule for those doors, revoke it
  (else it orphans — auto-seat removal won't revoke it later). **Stage 1: operator-clicked.
  Stage 2: auto-applied, silent.**
- **Demote `auto → manual`:** when an `auto` seat's expected direct grants are gone (church
  removed access). **Always surfaced, never automated** — it decides whether the member keeps
  or loses access (release vs. reprovision-as-manual), which observation alone can't disambiguate.

The asymmetry is the safety model: promote preserves access (the church grant remains); demote
risks it.

### The detector (the load-bearing piece)

The current `derivedBuildings` signal is a **set-difference** (`derivedBuildings ⊋ rule-backed
buildings`) and is **insufficient**: it only fires when the church grants doors *beyond* what
SBA's rules explain. In the overlap/lag case — SBA wrote a rule **and** the church grants the
same doors — the door sets coincide, the signal is silent, and the seat never promotes.

The authoritative signal is **direct-grant coverage**: the church's grants are the per-door
rows with **`AccessScheduleID === 0`** (Church Access Automation). A seat is church-backed iff
every door of its building's rule is present among the member's `AccessScheduleID === 0` rows —
true even when an SBA rule covers the same doors.

**Confirmed — the data is already in hand, no fresh capture needed.**

- The per-user door endpoint
  (`KindooGetUserAccessRulesLightWithTotalNumberOfRecordsWithEntryPoints`) returns one row
  **per (door, granting source)**: `AccessScheduleID === 0` is a direct church grant; a non-zero
  value is the granting rule. A door granted by both a rule and a direct grant therefore emits
  **both** rows — so the overlap/lag case is observable. (`v2-kindoo-api-capture.md:781–820`.)
- The endpoint parser **already surfaces it**: `endpoints.ts` returns
  `UserDoorGrantRow { doorId, accessScheduleId }` (`:756,:825`). Only `getUserDoorIds` in
  `buildingsFromDoors.ts` collapses it (`new Set(rows.map((r) => r.doorId))`). The detector work
  is to *stop collapsing it* and partition direct (`accessScheduleId === 0`) from rule-derived.

**Algorithm** (mirrors the existing strict-subset `deriveEffectiveRuleIds`, restricted to direct
doors):

1. `directDoorIds = { r.doorId | r.accessScheduleId === 0 }` for the member.
2. A building X (→ rule `R_X`, door set from `buildRuleDoorMap`) is **direct-granted** iff
   **every** door of `R_X` ∈ `directDoorIds` (strict subset; partial coverage ⇒ not
   church-backed — conservative, matches the existing rule-derivation convention).
3. A seat is **church-backed** iff every one of its `building_names` is direct-granted. Partial
   coverage on a multi-building seat ⇒ not auto (surface for review rather than guess).

### Stage 1 — grant classification + sort + soft-deprecation (operator-clicked)

Internal order: (a) can land independently; (b)→(c)→(d) are sequential — you cannot retire
`auto_kindoo_access` until grants classify.

(a) **Compiled sort table + render-time sort** (`packages/shared` + `apps/web`). A canonical
72-entry `calling → order` module in `packages/shared` (stake callings 1–31, ward 32–72; exact
names, trimmed + case-insensitive match; no wildcards). The web sort
(`apps/web/src/lib/sort/seats.ts`, plus `features/manager/access/sort.ts` if it sorts) computes
order from the seat's callings **at render time** and no longer reads the denormalized
`seat.sort_order`. Resolved sort (operator-locked 2026-05-30):

- **Type bands unchanged**: auto, then manual, then temp.
- **auto + manual bands**: by calling order — a multi-calling seat uses the **MIN** order across
  its callings. **Unknown** (no calling matches the table) → bottom of the band, by `created_at`
  ascending (oldest first).
- **temp band**: unchanged — by `end_date` (soonest-expiring at the band bottom), per the prior
  operator brief. (Temps carry a free-text reason, not a roster calling, so calling-order
  doesn't apply.)
- **Cross-scope (All Seats)**: scope-primary (stake first, then wards alpha) is preserved; the
  banding above applies within each scope.

`syncApplyFix`'s template-based `sort_order` stamping is **left in place (vestigial — web ignores
it)**; removing it is a deferred cleanup, not required for Stage 1. This keeps the sort track
independent of the detector track (which reuses `applyTypeMismatch`).

(b) **Direct-grant detector** (extension). Extend `buildingsFromDoors.ts` to track
`AccessScheduleID === 0` coverage per building; add a per-seat "church-backed?" predicate.
Plus the prerequisite capture above.

(c) **Switch classification** (extension). `detector.ts` `type-mismatch` (`:535`) becomes
promote/demote rows driven by the predicate, not `intended.type` vs stored type.
`classifier.ts`'s auto-set role (`buildCallingTemplateSets`; the `auto_kindoo_access` lookups at
`:84,:88`) retires; the **parser stays** (still need the calling name for `callings[]` + the
sort lookup). Promote/demote are operator-clicked via the existing `SyncPanel` fix UI — the
`applyTypeMismatch` write path (`syncApplyFix.ts:391`) already flips type + handles `sort_order`
+ access-doc parity, so no new write path is needed.

(d) **Soft-deprecate `auto_kindoo_access`.** Once (b)+(c) land, nothing reads it for
classification; once (a) lands the web sort no longer reads `sort_order` (functions' template
`sheet_order` stamping is left vestigial). Stop reading it for type; **leave the
field and the Configuration "Auto Callings" tab in place, dormant** — it is the validation
fallback (promote/demote are operator-approved in Stage 1; there is no template safety net
otherwise). `give_app_access` and `sheet_order` are untouched — `sheet_order` still drives
`give_app_access` wildcard precedence, and the access-doc parity (`filterByGiveAppAccess`) is
unchanged. The request path is untouched (already born-manual).

(e) **Redefine `extra-kindoo-calling`.** Currently keyed on the auto-calling concept (mixed
auto/non-auto in `classifier.ts`); that trigger disappears. Redefine as a plain callings-set
diff — Kindoo's parsed callings vs `seat.callings`, independent of type — so "Kindoo records a
calling the SBA seat doesn't" still surfaces.

#### Implementation notes — detector track (b + c + e), landed

These pin down details the design above glossed; they are the as-built contract.

**Prefer-direct door dedup (b).** `getUserAccessRulesWithEntryPoints` (`endpoints.ts`) returns one
`UserDoorGrantRow` per (door, source). It collapses to one row per `doorId` but **prefers the
direct grant**: if ANY row for a door is direct (`AccessScheduleID === 0`), the collapsed row
carries `accessScheduleId: 0`. Without this, a rule row arriving before the direct row would mask
the direct grant (the overlap/lag case) since the old dedup kept first-seen. `directGrantBuildings`
is then `derivedBuildingNames(deriveEffectiveRuleIds(directDoorIds, ruleDoorMap), buildings)` over
the direct-only door subset; `enrichUsersWithDerivedBuildings` computes both sets from a single
fetch (`getUserDoorGrants`) and nulls BOTH on a per-user error.

**`isChurchBacked` (c).** `directGrantBuildings !== null && every seat building ∈
directGrantBuildings`. A seat with no buildings is vacuously church-backed when the direct set is
known (no doors the church must own). `null` direct set ⇒ not church-backed (can't determine).

**Promote/demote target carrier (c).** The grant-derived target type rides on
`KindooBlock.grantTargetType` (`'auto'` for promote, `'manual'` for demote; also set on
`kindoo-only` rows as the created-seat type). `fix.ts` sends THIS as the callable `newType`, never
`intendedType`. `type-mismatch` throws in the payload builder if `grantTargetType` is absent.

**`kindoo-only` created type (c).** Same rule: temp (`IsTempUser`) → temp; else church-backed
(evaluated against the building set the new seat would carry — `derivedBuildings` when known, else
the AccessSchedules fallback) → auto; else manual. The created seat's `callings[]` is the FULL
parsed primary-segment calling list (matched ∪ unmatched), since type no longer gates which
callings land on it.

**Detector check order (c + e).** Within the both-sides-present branch the order is
scope-mismatch → type-mismatch (promote/demote) → buildings-mismatch → **extra-kindoo-calling
(last)**. Each `continue`s, so at most one row per email; a genuine type/scope/buildings drift
preempts a calling addition.

**`extra-kindoo-calling` false-positive guard (e).** The diff is trimmed + case-insensitive,
additive direction only, and **type-scoped to where the SBA seat records its calling** (per
`docs/spec.md` §13 + `markRequestComplete`):

- **auto** seat → compare Kindoo's parsed callings against the roster `callings[]`.
- **manual / temp** seat → `callings[]` is empty by construction; the calling lives in the single
  free-text `reason`. Compare against `reason` (split on `,` for the rare multi-calling reason). A
  manual seat whose `reason` reflects the Kindoo calling does NOT fire — this is what keeps the
  review list from flooding with every manual seat.

The extras ride on `KindooBlock.extraKindooCallings`; `fix.ts` sends them as the callable
`extraCallings`.

**`extra-kindoo-calling` fix action (e) — awkward for manual seats.** The `syncApplyFix`
`extra-kindoo-calling` path appends to the roster `callings[]`. That's correct for an **auto** seat,
so it gets the one-click **"Add to SBA seat"** button. A **manual / temp** seat records its calling
in the single free-text `reason`, not a `callings[]` list — appending would mint a hybrid seat
(`callings: [X]` + `reason: "Y"`), the wrong shape. So `fixActionsFor` returns **no fix button** for
a manual / temp `extra-kindoo-calling` row: the drift still surfaces (review severity) but the
operator reconciles `reason` in the web app. The seam is the backend's `callings[]`-only append; a
future `reason`-aware `syncApplyFix` variant could close it (out of scope here — extension-only).

**`type-mismatch` fix UI (c).** Kindoo grants are the source of truth for type, so the row exposes
**only "Update SBA"** — no "Update Kindoo" (the extension can't write church grants; revoke-on-
promote is Stage 2). `fixActionsFor('type-mismatch')` returns the single SBA action.

**Zero-grant seats never auto (b/c).** The seat-type decision uses `grantsBackAuto` (church-backed
AND ≥1 building), not the raw `isChurchBacked` (which is vacuously true for a zero-building seat).
A `kindoo-only` user with no door grants (newly added, access revoked) is therefore born **manual**,
not an empty-building auto seat, and a zero-building `manual` seat is not spuriously promoted.
Demote keys off `!isChurchBacked` so a degenerate zero-building `auto` seat is not spuriously
demoted either.

### Stage 2 — automate promote (after Stage 1 validates the detector in production)

- Promote auto-applies (no click); demote stays surfaced.
- Conditional SBA-rule revoke on promote (only when an `AccessSchedule` exists for the seat's
  doors); optionally a **provision-time** grant check in the RequestCard flow so a member who
  already holds church grants is created `auto` and SBA never writes a redundant rule.
- Hard-remove `auto_kindoo_access` (field + Configuration tab) once promote has run cleanly in
  production.

### Open questions

1. **Web-app access during the manual window.** The `access/{canonical}` doc (→ web-app custom
   claims) is written for `give_app_access` callings but **gated on `type === 'auto'`**
   (`syncApplyFix.ts:251`, `needsTemplates`). Under born-manual a `give_app_access` holder has
   no access doc until promoted. Confirm that's acceptable, or decouple access-doc writing from
   auto-type (web-app access is orthogonal to door provenance).
2. **Revoke-on-promote vs. leave-rule.** Revoking is clean (matches the auto contract) but
   creates a dependency on the church grant persisting; leaving it risks orphan grants on
   removal. Stage 2 decision.
3. **Multi-stake compiled table.** The `calling → order` table is global (calling hierarchy is
   churchwide). This removes per-stake ordering customisation — acceptable, and consistent with
   "reality is churchwide."

## Out of scope for Sync entirely (any phase)

- Reconciling SBA's seat data against the LCR Sheet — that's the importer's job.
- Detecting drift in non-seat data (kindooManagers, stake config, etc.).
- Drift detection across multiple stakes — single-stake only until Phase 12.

## Capture reference

API request/response shapes are in `extension/docs/v2-kindoo-api-capture.md` (gitignored). The paginated `listAllEnvironmentUsers` builds on the existing `GetEnvironmentUsersLight` shape; the response is already captured. No new endpoint captures needed for Phase 1.
