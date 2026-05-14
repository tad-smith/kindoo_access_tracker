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
- All wards under `stakes/{STAKE_ID}/wards/*` (for ward-name → ward_code resolution).
- All buildings under `stakes/{STAKE_ID}/buildings/*` (for Kindoo-rule → building-name resolution via the v2.1 config).
- All ward calling templates under `stakes/{STAKE_ID}/wardCallingTemplates/*` (auto-calling sets per ward).
- All stake calling templates under `stakes/{STAKE_ID}/stakeCallingTemplates/*` (auto-calling set for stake scope).
- The stake doc itself (for `stake_name`, `kindoo_expected_site_name`, etc).

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
  rawScopeName: string;          // e.g. "Cordera Ward"
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

Multi-calling within a single segment (`Cordera Ward (Elders Quorum First Counselor, Accompanist)`) → calling field contains the comma-joined raw text; the classifier splits on `, ` when it needs to check each individually.

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
- If multiple parsed segments → one primary (first segment? or pick by SBA's priority rule: stake-scope wins for primary, then alphabetical ward) + duplicates.
- The "primary picking" should mirror SBA's existing `pickPrimaryScope` helper (stake > ward, alphabetical among wards).

### Discrepancy detector (`sync/detector.ts`)

Iterate over the union of (SBA seat emails) ∪ (Kindoo user emails). For each email:

| SBA side | Kindoo side | Discrepancy code |
|---|---|---|
| seat present | no Kindoo user | `sba-only` |
| no seat | Kindoo user present | `kindoo-only` |
| seat | Kindoo user, unparseable | `kindoo-unparseable` (flag for review) |
| seat | Kindoo user, parsed primary scope ≠ seat.scope | `scope-mismatch` |
| seat | Kindoo user, intended type ≠ seat.type | `type-mismatch` |
| seat (manual/temp) | Kindoo user, accessSchedules' rule set ≠ seat.building_names mapped to RIDs via v2.1 config | `buildings-mismatch` |
| seat (auto) | Kindoo user, any AccessSchedules state | (buildings check skipped — see below) |
| seat (auto) | Kindoo user lists auto calling + additional non-auto calling(s) | `extra-kindoo-calling` (flag for review — operator adds the extras to the SBA seat) |
| seat | Kindoo user, all-good | (no row) |

Severity:
- `sba-only`, `kindoo-only`, `scope-mismatch`, `type-mismatch`, `buildings-mismatch` → **drift** (real divergence).
- `kindoo-unparseable`, `extra-kindoo-calling` → **review** (operator-judgment needed).

**Auto seats skip the buildings comparison.** Auto-imported users (the Church Access Automation flow, ~310 of 313 users in production) receive door access via **direct door grants keyed by `VidName`**, not via `AccessSchedules`. The bulk listing endpoint (`GetEnvironmentUsersLightWithTotalNumberOfRecordsWithEntryPoints`) only exposes `AccessSchedules` on the user — direct door grants are NOT included. Auto users therefore come back with `AccessSchedules: []` regardless of how much actual access they have, so comparing it would always show false-positive drift. Manual and temp seats ARE provisioned by SBA via `AccessSchedules` (the v2.2 Provision & Complete flow writes via `saveAccessRule`), so for those the comparison is meaningful and runs as before. The scope-mismatch and type-mismatch checks above still run for auto seats; only the buildings check is gated.

Proper auto-user reconciliation would require per-user `KindooGetUserAccessRulesLightWithTotalNumberOfRecordsWithEntryPoints` calls (313 calls in our current env) and is deferred to Phase 2.

**`kindoo-only` rows with `intended.type === 'auto'` are NOT filtered.** Even when the Kindoo user's description classifies as auto, the absence of an SBA seat is still drift — these users need to be imported into SBA. The drift row stays.

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

## Phase 2 — Fix actions (outline)

Each discrepancy row gains a "Fix this" button. The action varies by discrepancy code:

| Code | Direction of truth | Fix action |
|---|---|---|
| `sba-only` | SBA → Kindoo | Provision the SBA seat in Kindoo (invite + saveAccessRule, mirroring v2.2's add path with the seat as input). |
| `kindoo-only` | TBD per type | If Kindoo user's intended type is auto: probably do nothing (importer will catch it). If manual/temp: prompt operator to either create an SBA request or revoke from Kindoo. |
| `scope-mismatch`, `type-mismatch`, `buildings-mismatch` | TBD | Two-button row: "Update Kindoo to match SBA" vs "Update SBA to match Kindoo" — operator picks the source of truth per row. |
| `kindoo-unparseable`, `extra-kindoo-calling` | manual | No fix button; operator handles in Kindoo's admin UI (for `extra-kindoo-calling`, add the extra calling(s) to the SBA seat so the records match). |

Phase 2 needs its own design pass to settle:
- Confirmation dialogs (each fix is potentially destructive).
- Bulk fix ("Fix all SBA-only") with summary preview.
- Whether to create SBA requests (existing flow) or write seat docs directly (faster but bypasses normal request audit).
- Audit trail for sync-driven changes (probably stamped with a `SyncActor` sentinel, similar to the existing `Importer` / `ExpiryTrigger` / `OutOfBand` synthetic actors).

## Out of scope for Sync entirely (any phase)

- Reconciling SBA's seat data against the LCR Sheet — that's the importer's job.
- Detecting drift in non-seat data (kindooManagers, stake config, etc.).
- Drift detection across multiple stakes — single-stake only until Phase 12.

## Capture reference

API request/response shapes are in `extension/docs/v2-kindoo-api-capture.md` (gitignored). The paginated `listAllEnvironmentUsers` builds on the existing `GetEnvironmentUsersLight` shape; the response is already captured. No new endpoint captures needed for Phase 1.
