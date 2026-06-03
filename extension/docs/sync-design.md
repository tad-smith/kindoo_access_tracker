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
5. **Unparseable descriptions** (don't match `Scope (Calling)[ | Scope (Calling)]`): originally flagged for review with no action. **Superseded in Stage 2** — now split on blank-vs-present. A **blank** Description stays review-only (`kindoo-no-description`). A **present-but-unparseable** Description is treated as a church-wide stake-scope calling and gets an actionable Update-SBA `kindoo-unparseable` drift row, but **only for a home-site Guest whose seat isn't already stake-aligned**; a non-Guest (Manager / admin) gets a review-only `kindoo-unparseable` row, a foreign site or an already-aligned seat emits no row, and the defensive parsed-but-no-primary case is review. See the discrepancy catalogue + fix-action catalogue below.
6. **Kindoo Manager accounts** (manager's own account + any other Kindoo Manager): their descriptions *often* don't fit the convention (e.g. `Kindoo Manager - Stake Clerk account`), so they typically fall through to "unparseable" + flagged for review naturally. **But this is not guaranteed** — a manager whose Description happens to parse (e.g. `Colorado Springs North Stake (Stake Clerk)`, a real staging case) and matches an SBA seat would otherwise be subjected to grant-based type / buildings reconciliation and falsely demoted (a manager has no guest door grants, so the church-direct-grant chain reads as "access revoked"). **Managers are now detected by their Kindoo seat role, not assumed-unparseable.** Grant-based reconciliation (`type-mismatch` promote/demote AND `buildings-mismatch`) applies ONLY to **Guests** (`UserRole === 2` — the role SBA provisions seats as); every non-Guest (Manager / admin, e.g. the staging manager's `UserRole: 0`) is skipped entirely, no row. The role rides on a **per-user call the sync already makes** (no extra request — it's denormalized on every `RulesList` row of the door-grants response) and is stamped onto `KindooEnvironmentUser.userRole`. An unreadable role (empty `RulesList` / failed fetch → `userRole` unset) also skips (`undefined !== 2`) — the safe default; we never promote/demote a user we can't classify. See the "Role-based grant-reconciliation scope" implementation note under Stage 1.
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

> **Superseded for `type` classification** by the "Grant-derived seat type (Stage 1 + Stage 2)"
> section below (shipped 2026-05-30, PRs #178–#180). The detector no longer derives a seat's
> `type` from this classifier's template match — `type` is observed from Church Access Automation
> direct grants (`isChurchBacked` / `grantsBackAuto`). The classifier still runs to extract the
> **calling name(s)** (for `callings[]` + the sort lookup) and the parsed scope; its `type` /
> `reviewMixed` outputs are no longer authoritative. `extra-kindoo-calling` is now an AUTO-only
> `seat.callings` diff, not the `reviewMixed` path described in step 6. Read this section for the
> parser/calling-extraction mechanics; read the Grant-derived section for how `type` is decided.

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
| seat | Kindoo user, Description present but unparseable, **home site + Guest + not already stake-aligned** | `kindoo-unparseable` (drift — treat as church-wide stake-scope calling, Update SBA) |
| seat | Kindoo user, Description present but unparseable, **non-Guest (Manager / admin)** | `kindoo-unparseable` (review — FYI, no action; an Update SBA would clobber the manager's seat) |
| seat | Kindoo user, Description present but unparseable, **foreign site** | (no row — suppressed; "apply to stake scope" is a home/stake concept) |
| seat | Kindoo user, Description present but unparseable, **already stake-aligned** | (no row — seat already matches the Update-SBA target, resolves like any drift) |
| seat | Kindoo user, Description blank (empty / whitespace) | `kindoo-no-description` (review — nothing derivable, no action) |
| seat | Kindoo user, parsed primary scope ≠ seat.scope | `scope-mismatch` |
| seat (any type) | Kindoo user, `userRole !== 2` (non-Guest, OR role unreadable) | (both type-mismatch AND buildings-mismatch skipped — not a confirmed SBA-owned Guest seat, see "Role-based grant-reconciliation scope") |
| seat (manual/auto, not temp) | grant-based promote/demote — see Stage 1 (c) | `type-mismatch` |
| seat (any type) | Kindoo user, `derivedBuildings` ≠ seat.building_names | `buildings-mismatch` |
| seat (manual/temp) | Kindoo user, `derivedBuildings === null`, accessSchedules' rule set ≠ seat.building_names mapped to RIDs via v2.1 config | `buildings-mismatch` (AccessSchedules fallback) |
| seat (auto) | Kindoo user, `derivedBuildings === null` (per-user derivation failed) | (buildings check skipped — fallback) |
| seat (auto only) | Kindoo parsed callings ⊋ seat `callings[]` — see Stage 1 (e) | `extra-kindoo-calling` (drift — Update SBA appends the missing calling(s) to the seat's `callings[]`) |
| seat | Kindoo user, all-good | (no row) |

Severity:
- `sba-only`, `kindoo-only`, `scope-mismatch`, `type-mismatch`, `buildings-mismatch`, `extra-kindoo-calling` → **drift** (an unambiguous SBA-side action is available).
- `kindoo-unparseable` → **drift** only for a home-site Guest with an unaligned seat; **review** for a non-Guest (Manager / admin). On a foreign site or an already-aligned seat it emits no row at all.
- `kindoo-no-description` → **review** (a blank Kindoo Description yields nothing Sync can reconcile).

**Invariant: a `review`-severity row never renders an action.** `fixActionsFor` returns no buttons for any `severity === 'review'` row, regardless of code (a top-of-function guard). The display-only Sync rows are therefore: `kindoo-no-description` (blank Description), a non-Guest present-but-unparseable `kindoo-unparseable` row, and the defensive parsed-but-no-primary fallback (below). Every other discrepancy code offers an SBA-side action.

The split between `kindoo-unparseable` and `kindoo-no-description` is the parser's blank-vs-present distinction (`parsed.segments.length === 0`). A blank Description has no derivable SBA side (`kindoo-no-description`, always review). A present-but-unparseable Description is treated as a church-wide (stake-scope) calling, but the actionable Update-SBA row is gated three ways in the detector:

- **(A) Home-site only** — on a foreign Kindoo site the row is suppressed entirely (`isHomeSite`, keyed off the same `activeSite` home-vs-foreign signal the T-42 logic uses). "Apply to stake scope" is a home/stake concept.
- **(B) Guest vs non-Guest** — a Guest (`UserRole === 2`) gets the actionable `drift` row; a non-Guest (Manager / admin, `skipGrantReconciliation(kuser)` true) gets a `review` row with no action. An Update SBA on a manager's seat would clobber it.
- **(C) Not already aligned** — for a home-site Guest, the drift row fires only when the SBA seat is **not** already in the state Update SBA would produce (`unparseableAligned`: `scope==='stake'` plus the calling recorded per §6.1 — `callings===[description]` for auto, `reason===description` for manual/temp, case/whitespace-normalized). Once aligned (operator applied it, or the seat already matched), the row is suppressed so it resolves on the next Sync run like every other drift code.

The defensive **"resolved segments but no primary"** fallback also emits `kindoo-unparseable`, but as **review** (no action): there the Description *did* parse (it carries scope + parens, e.g. `Maple Ward (Bishop)`), so routing it to Update SBA would send that whole string as the calling and corrupt the seat. `extra-kindoo-calling` moved `review → drift` once its append became the unambiguous action.

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

- `home` — Include seats whose `scope === 'stake'` (Phase 1 policy: stake-scope seats are home-only) and seats whose scope is a ward with `kindoo_site_id` null / absent. Include Kindoo users whose parsed primary segment resolves to one of those wards or to the stake; on home, unparseable / unresolvable Kindoo users are also kept so the `kindoo-only` / `kindoo-unparseable` / `kindoo-no-description` rows still surface.
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

**Kindoo is authoritative; Sync never writes SBA → Kindoo (locked 2026-06-02, PR #183).** Every fix below is an SBA-side mutation that reconciles the SBA seat to Kindoo's observed state. Provisioning *into* Kindoo (inviting a user, writing AccessSchedules) flows exclusively through the request-driven provision orchestrator (`provision.ts`), not through Sync. There are no "Provision in Kindoo" / "Update Kindoo" buttons; the CS-side Kindoo-write orchestrator that backed them (`sync-provision.ts`) has been removed. The only Sync action toward an orphaned SBA seat is REMOVE.

| Code | Buttons | What happens |
|---|---|---|
| `sba-only` | "Remove From SBA" (danger) | SBA-side delete via `syncApplyFix` with `code: 'sba-only'`. An SBA seat with no Kindoo presence is an orphan (the authority doesn't have it), so the callable deletes it, mirroring `removeSeatOnRequestComplete` — plain `tx.delete` for the common orphan; promote-first-duplicate-to-primary when the seat carries `duplicate_grants[]` for other sites. (Was a Kindoo-side "Provision in Kindoo" write before the Kindoo-authoritative shift.) |
| `kindoo-only` | "Create SBA seat" | SBA-side: `syncApplyFix` with `code: 'kindoo-only'`. Server-side stamps the seat write with `SyncActor:kindoo-only`. |
| `extra-kindoo-calling` | "Update SBA" | SBA-side: `syncApplyFix` with `code: 'extra-kindoo-calling'`; backend de-dupes + appends to `callings[]`. Severity drift. The append path and `testId` (`add-callings-sba`) are unchanged; the button label moved from "Add to SBA seat" to "Update SBA" to match the other Update-SBA actions. |
| `scope-mismatch` | "Update SBA" only | `syncApplyFix` with `code: 'scope-mismatch'` carrying Kindoo's parsed primary scope. No "Update Kindoo" — Sync never writes SBA → Kindoo. |
| `type-mismatch` | "Update SBA" only | Grants own the type decision (promote/demote), so the only action is Update SBA, which flips the seat to the grant-derived target (`grantTargetType`) via `syncApplyFix` with `code: 'type-mismatch'`. No "Update Kindoo" — the extension can't write church grants. |
| `buildings-mismatch` | "Update SBA" only | `syncApplyFix` with `code: 'buildings-mismatch'`. Sources from `derivedBuildings` (the direct + rule-grant strict-subset chain) for ALL seat types — never the AccessSchedules-derived `buildingNames`, which misses direct grants and would wipe buildings for auto users. Update SBA refuses (button disabled) when `derivedBuildings === null` (per-user door read failed). No "Update Kindoo" — Sync never writes SBA → Kindoo. |
| `kindoo-unparseable` | "Update SBA" (drift rows only — never on the review variants) | SBA-side: `syncApplyFix` with `code: 'kindoo-unparseable'`, payload `{ memberEmail, calling }` where `calling` is the raw Kindoo Description text. Only the home-site Guest unaligned variant is drift and carries the button (the non-Guest variant and the no-primary fallback are review → no action per the review-guard invariant). On apply, the callable sets the seat to `scope='stake'`, **clears `kindoo_site_id`** (stake-scope ⇒ home, spec §15), preserves `type`, and writes the calling per the §6.1 convention (auto → `callings[]`; manual/temp → free-text `reason`, callings cleared, temp dates preserved). For an auto seat it reaps the OLD scope's `importer_callings` and then writes `importer_callings['stake'] = [calling]` **iff** the calling matches a `give_app_access` **stake** template — a bare template name (e.g. `Stake Clerk`) keeps stake-scope app access; a non-template calling earns no new grant (old scope still reaped, access doc deleted if it ends up empty). One coherent write (`writeStakeScopeAccessForUnparseable`). |
| `kindoo-no-description` | none | Review-only. A blank Kindoo Description yields nothing Sync can reconcile, so no SBA-side action is offered; the operator decides manually. |

### Audit + SyncActor

Every backend-side seat write made by `syncApplyFix` is stamped with `lastActor: SyncActor:<code>` where `<code>` is the discrepancy code that triggered it. The parameterised `auditTrigger` fans an audit row off the resulting Firestore write the same way every other write goes through audit — Sync writes don't bypass anything.

The `SyncActor:` prefix is recognised by the web renderer's `isAutomatedActor` helper and rendered with the automated-actor chip in the audit log + dashboard, alongside `Importer` / `ExpiryTrigger` / `RemoveTrigger` / `OutOfBand`. Helpers (`syncActorName`, `parseSyncActorCode`, `SYNC_DISCREPANCY_CODES`) live in `packages/shared/src/systemActors.ts`.

Every fix now flows through `syncApplyFix` and lands an SBA-side seat write, so every fix produces an audit row — including `sba-only`. The orphan delete uses the Expiry-style stamp-then-delete (stamp `lastActor: SyncActor:sba-only` in a committed write, then delete) so the audit trigger reads the stamped BEFORE snapshot and attributes the `delete_seat` row to the Sync actor; the duplicate-grant-promotion branch fans an `update_seat` row instead. There are no longer any Kindoo-side Sync writes that bypass Firestore.

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

> **Retired 2026-06-02 (PR #183).** `extension/src/content/kindoo/sync-provision.ts` — the Kindoo-side orchestrator that drove Kindoo to a single `Seat` — was deleted when Sync became Kindoo-authoritative (no SBA → Kindoo writes). Its `unionSeatBuildings` helper had no other caller; the request-driven within-site building union lives in `provision.ts`. `fix.ts` lost its Kindoo-write branch (`dispatchKindooFix`, `synthesizeSeatFromBlocks`, the Kindoo-only `DispatchContext` fields) at the same time.

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
- Writing anything into Kindoo from Sync. Kindoo is authoritative; Sync only mutates / deletes SBA seats to track Kindoo's state. Provisioning into Kindoo flows through the request-driven provision orchestrator, not Sync. The `buildings-mismatch` and `scope-mismatch` "Update Kindoo" buttons and the `sba-only` "Provision in Kindoo" write were removed in PR #183.

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

**Confirmed — the data was already in hand, no fresh capture needed.** (b)+(c) shipped against the
existing capture; nothing was pending.

- The per-user door endpoint
  (`KindooGetUserAccessRulesLightWithTotalNumberOfRecordsWithEntryPoints`) returns one row
  **per (door, granting source)**: `AccessScheduleID === 0` is a direct church grant; a non-zero
  value is the granting rule. A door granted by both a rule and a direct grant therefore emits
  **both** rows — so the overlap/lag case is observable. (`v2-kindoo-api-capture.md:781–820`.)
- The endpoint parser **already surfaces it**: `endpoints.ts` returns
  `UserDoorGrantRow { doorId, accessScheduleId }`. The detector partitions direct
  (`accessScheduleId === 0`) from rule-derived rather than collapsing to `doorId` alone — see the
  "Prefer-direct door dedup" implementation note below for the as-built dedup.

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

**Status (2026-05-30): (a), (b), (c), (e) SHIPPED** to `main` via PR #178 (sort), PR #179
(detector), PR #180 (backend seat-shape). **(d) — soft-deprecation of the `auto_kindoo_access`
flag's seat-type-classification role — is PENDING** (the only unshipped Stage-1 piece). (d) is NOT
a UI change: the Configuration calling-template tabs (**Auto Ward Callings** / **Auto Stake
Callings**, each a `wardCallingTemplates` / `stakeCallingTemplates` table) and both per-row toggles
stay fully functional — see the (d) note below for the flags distinction. Stage 2 remains. The
shipped pieces are described in the present tense below; the as-built contract for the detector
track (b + c + e) is pinned in the "Implementation notes" subsection that follows.

(a) **Compiled sort table + render-time sort** (`packages/shared` + `apps/web`) — **SHIPPED
(PR #178)**. The operator-authoritative `calling → order` module is
`packages/shared/src/callingSortOrder.ts` (the **source of truth**): **85 entries — stake
callings 1–42, ward callings 43–85**; exact names, trimmed + case-insensitive match; no
wildcards. The roster / All Seats web sort (`apps/web/src/lib/sort/seats.ts`, consumed by the
bishopric Roster, stake Roster, Ward Rosters, and the manager All Seats page) computes order from
the seat's callings **at render time** and no longer reads the denormalized `seat.sort_order`. The
manager **App Access** page (`features/manager/access/sort.ts`) is a separate surface and was NOT
touched — it still sorts the `access/` collection by the doc-level `sort_order` / template
`sheet_order`. Resolved sort (operator-locked 2026-05-30):

- **Type bands unchanged**: auto, then manual, then temp.
- **auto band**: by calling order — `seatCallingOrder(seat.callings)`; a multi-calling seat uses
  the **MIN** order across its callings.
- **manual band**: by calling order too, but sourced from `seat.reason`, not `seat.callings` —
  manual seats carry `callings: []` and store the calling in the free-text `reason` (spec §13), so
  the comparator matches `callingSortOrder(seat.reason)` (single value, trimmed +
  case-insensitive) against the same table.
- **auto + manual unknown** (no calling matches the table) → bottom of the band, by `created_at`
  ascending (oldest first), then `member_name`.
- **temp band**: unchanged — by `end_date` (soonest-expiring at the band bottom), per the prior
  operator brief. (Temps carry a free-text reason, not a roster calling, so calling-order
  doesn't apply.)
- **Cross-scope (All Seats)**: scope-primary (stake first, then wards alpha) is preserved; the
  banding above applies within each scope.

`syncApplyFix`'s template-based `sort_order` stamping is **left in place (vestigial — web ignores
it)**; removing it is a deferred cleanup, not required for Stage 1. This keeps the sort track
independent of the detector track (which reuses `applyTypeMismatch`).

(b) **Direct-grant detector** (extension) — **SHIPPED (PR #179)**. `buildingsFromDoors.ts` tracks
`AccessScheduleID === 0` coverage per building (`directGrantBuildings`); `isChurchBacked` /
`grantsBackAuto` in `detector.ts` are the per-seat predicates. No fresh capture was needed — the
`AccessScheduleID === 0` direct-grant signal is already surfaced by `endpoints.ts`
(`UserDoorGrantRow.accessScheduleId`); the detector work was to stop collapsing it and partition
direct from rule-derived (see "Confirmed — the data is already in hand" above). **Follow-up:** the
demote false-fired on Kindoo Managers whose Description parsed; the detector now scopes both grant
checks to Guests (`UserRole === 2`), reading the role off a per-user call the sync already makes —
see the "Role-based grant-reconciliation scope" implementation note below.

(c) **Switch classification** (extension) — **SHIPPED (PR #179)**. `detector.ts` `type-mismatch`
emits promote/demote rows driven by the grant predicate, not `intended.type` vs stored type.
`classifier.ts`'s auto-set lookups against `auto_kindoo_access` no longer drive type; the **parser
stays** (still need the calling name for `callings[]` + the sort lookup). Promote/demote are
operator-clicked via the existing `SyncPanel` fix UI — the `applyTypeMismatch` write path
(`syncApplyFix.ts`) flips type **and reshapes the seat to the §13 convention** (PR #180; see
"Implementation notes" + the Stage 1c backend note below), so no new write path is needed.

(d) **Soft-deprecate the `auto_kindoo_access` flag's seat-type role** — **PENDING (not yet
shipped).** Scope is narrow: `auto_kindoo_access` no longer classifies seat `type` (the detector
derives type from church direct grants, (b)+(c)). The field, the per-row **"Auto Kindoo Access"**
toggle, and the **Auto Ward Callings** / **Auto Stake Callings** Configuration tabs all **stay in
place and fully functional** — this is NOT a UI-removal task; `auto_kindoo_access` retains minor
internal uses and remains the validation fallback (promote/demote are operator-approved in Stage 1;
there is no other template safety net).

The two per-row toggles are **independent and must not be conflated**:

- **"Can Request Access"** (`give_app_access`) — ACTIVE, essential: it is how managers grant SBA
  web-app access. NOT deprecated, NOT touched. `sheet_order` still drives its wildcard precedence,
  and the access-doc parity (`filterByGiveAppAccess`) is unchanged.
- **"Auto Kindoo Access"** (`auto_kindoo_access`) — its **role in door auto-seat-type
  classification** is what's soft-deprecated; the flag/toggle stays.

The remaining (d) work is therefore code-only (stop the web reading `auto_kindoo_access` for type)
plus reconciling the spec §13 prose that still describes Sync classifying type against the
templates. The request path is untouched (already born-manual). Tracked as T-57 (d).

(e) **Redefine `extra-kindoo-calling`** (extension) — **SHIPPED (PR #179).** The old auto-calling
trigger (mixed auto/non-auto in `classifier.ts`) is gone. The redefinition landed **AUTO-only**
(operator decision 2026-05-30, narrower than the interim "independent of type" sketch): the diff
fires only when the SBA seat `type === 'auto'`, comparing Kindoo's parsed callings against the
seat's `callings[]`. Manual / temp seats are never checked — see the "Implementation notes" entry
below for the rationale.

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

**`kindoo-only` created type + shape (c).** Same rule: temp (`IsTempUser`) → temp; else church-backed
(evaluated against the building set the new seat would carry — `derivedBuildings` when known, else
the AccessSchedules fallback) → auto; else manual. The seat is shaped to match the request flow /
`markRequestComplete` (`docs/spec.md` §13): an **auto** seat carries the FULL parsed primary-segment
calling list (matched ∪ unmatched) in `callings[]` and no `reason`; a **manual / temp** seat carries
`callings: []` and the full parsed calling text in the single free-text `reason`. Writing the
calling to a manual seat's `callings[]` would mint a hybrid seat that re-fires `extra-kindoo-calling`
forever (the manual diff reads `reason`). The reason sources from the FULL parsed list, not
`intendedFreeText` (the classifier's unmatched remainder, empty when the classifier matched
everything — which would otherwise record the calling nowhere).

**Detector check order (c + e).** Within the both-sides-present branch the order is
scope-mismatch → type-mismatch (promote/demote) → buildings-mismatch → **extra-kindoo-calling
(last)**. Each `continue`s, so at most one row per email; a genuine type/scope/buildings drift
preempts a calling addition.

**`extra-kindoo-calling` is AUTO-only (e — operator decision 2026-05-30).** The diff fires only
when the SBA seat `type === 'auto'`: compare Kindoo's parsed callings against the roster
`callings[]`, trimmed + case-insensitive, additive direction only. **Manual / temp seats are not
checked at all.** They record their calling in the free-text `reason`, which is frequently operator
prose (`"Requested by bishop"`, `"Visiting speaker"`) rather than a calling name; surfacing the
diff on them would flood the review list with non-actionable rows on every existing manual seat.
(This also moots the manual fix-action question — there are no manual `extra-kindoo-calling` rows.)
The extras ride on `KindooBlock.extraKindooCallings`; `fix.ts` sends them as the callable
`extraCallings`. The `syncApplyFix` path appends to `callings[]`, which is the auto-seat shape, so
the one-click **"Add to SBA seat"** button applies to every (auto-only) row.

**`type-mismatch` fix UI + payload (c).** Kindoo grants are the source of truth for type, so the row
exposes **only "Update SBA"** — no "Update Kindoo" (the extension can't write church grants;
revoke-on-promote is Stage 2). `fixActionsFor('type-mismatch')` returns the single SBA action. The
callable payload carries `newType` (grant-derived target) and, **on PROMOTE only (`newType:
'auto'`), `callings: string[]`** — the full Kindoo-parsed primary-segment calling list (matched ∪
unmatched). **DEMOTE (`newType: 'manual'`) omits `callings`** — the backend derives `reason` from
the seat's existing callings.

**Backend seat-shape on flip (PR #180, landed).** `applyTypeMismatch` (`syncApplyFix.ts`) reshapes
the seat to the §13 convention as it flips `type` — the earlier "until the backend PR lands the
field is sent but ignored" caveat is resolved. **Promote** (`manual`/`temp` → `auto`): set
`callings[]` from the payload's `callings` (fallback `[seat.reason]` when the payload is
empty/absent and the seat carries a non-empty reason, else `[]`), clear `reason`, stamp `sort_order`
from the matched template, write the access doc(s) for `give_app_access` callings. **Demote**
(`auto` → `manual`/`temp`): fold the existing `callings[]` into the free-text `reason`, clear
`callings[]`, clear `sort_order`, and clear `importer_callings` for the seat's scope (deleting the
access doc if both `importer_callings` and `manual_grants` end up empty). The shared
`TypeMismatchPayload.callings?: string[]` field carries the promote calling list (append-only type
change).

**Zero-grant seats never auto (b/c).** The seat-type decision uses `grantsBackAuto` (church-backed
AND ≥1 building), not the raw `isChurchBacked` (which is vacuously true for a zero-building seat).
A `kindoo-only` user with no door grants (newly added, access revoked) is therefore born **manual**,
not an empty-building auto seat, and a zero-building `manual` seat is not spuriously promoted.
Demote keys off `!isChurchBacked` so a degenerate zero-building `auto` seat is not spuriously
demoted either.

**Role-based grant-reconciliation scope — Kindoo Managers (post-PR-#179 fix).** The (b)+(c) demote
shipped in #179 read "auto seat + church direct grants gone ⇒ demote" off `directGrantBuildings`.
That false-fires on a Kindoo **Manager** whose Description *parses* (so Locked-in decision #6's
unparseable fall-through doesn't save them — real staging case: `Colorado Springs North Stake (Stake
Clerk)`, `UserRole: 0`, matching a stake-scope auto seat). A manager has no guest door grants, so
the per-user door fetch returns nothing → `directGrantBuildings === []` → `!isChurchBacked` → a
spurious demote; guarding only the demote then flips them to a spurious `buildings-mismatch`
(`derivedBuildings === []` vs the seat's buildings).

**The fix is one predicate, `skipGrantReconciliation(kuser)`**, that both grant checks consult — so
they can never disagree (guarding only one flips the user to the other's spurious row). The detector
skips **both** `type-mismatch` (promote/demote) and `buildings-mismatch` when it returns `true`,
surfacing **no row** (a `scope-mismatch` or the additive AUTO-only `extra-kindoo-calling` can still
fire, since neither is grant-provenance reconciliation).

**The predicate is the Kindoo seat role, and only that:** `kuser.userRole !== KINDOO_GUEST_ROLE`
(Guest === 2 — the role SBA provisions seats as, and the invite dropdown's "Guest"). Grant-based
reconciliation applies ONLY to Guests; any non-Guest (Manager / admin, e.g. the staging manager's
`0`) is skipped — managers / admins are not SBA-owned door grants, so their grant shape is none of
our business. **The role rides on a per-user call the sync already makes — no extra request:** it is
denormalized on every `RulesList` row of the door-grants response
(`KindooGetUserAccessRulesLightWithTotalNumberOfRecordsWithEntryPoints` →
`getUserAccessRulesWithEntryPoints`, which returns the first numeric `UserRole` it sees alongside the
door rows). `enrichUsersWithDerivedBuildings` stamps `KindooEnvironmentUser.userRole` so the
detector has it on every user before `detect()` runs.

**`undefined` role → skip** (the safe default): an empty `RulesList` or a failed door fetch leaves
`userRole` unset, and `undefined !== 2` skips. We never promote/demote a user we can't classify.
This is consistent with the per-check `directGrantBuildings === null` / `derivedBuildings === null`
skips (a failed fetch can't determine the building set either).

**Known limitation — entirely-revoked Guests are NOT demoted.** Because `userRole` is read off the
door-grant rows, a Guest whose church access was completely removed has zero rows → no role to read
→ `userRole` unset → skip. The seat-type label lags at `auto` even though SBA should now own it. We
accept this: the member already has no Kindoo door access (only the label is stale), and the
alternative — a fallback role source (a per-user `checkUserType`, or `UserRole` off the bulk listing
if it carries it) for every zero-row seated user — is cost this manager-demote fix doesn't warrant.
A Guest with ANY remaining grant still carries the role on its rows and demotes normally when those
grants no longer back the seat (`directGrantBuildings` shrinks). If the lag ever matters, the
fallback is a localized follow-up. There is no door-footprint heuristic either: the role is a clean
signal, so the earlier "`hasNoDoorFootprint`" fallback was removed (operator decision 2026-05-30) in
favour of the simpler role gate.

### Stage 2 — automate promote (after Stage 1 validates the detector in production)

- Promote auto-applies (no click); demote stays surfaced.
- Conditional SBA-rule revoke on promote (only when an `AccessSchedule` exists for the seat's
  doors); optionally a **provision-time** grant check in the RequestCard flow so a member who
  already holds church grants is created `auto` and SBA never writes a redundant rule.
- Hard-remove the `auto_kindoo_access` field + its per-row **"Auto Kindoo Access"** toggle once
  promote has run cleanly in production. The **Auto Ward Callings** / **Auto Stake Callings** tabs
  and the **"Can Request Access"** (`give_app_access`) toggle stay — they're an active, essential
  feature (web-app access), not part of the door auto-seat machinery.

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
