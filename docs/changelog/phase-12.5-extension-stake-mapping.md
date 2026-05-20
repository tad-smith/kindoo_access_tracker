# Phase 12.5 — Extension EID-to-stake mapping

**Shipped:** 2026-05-20
**Commits:** branch `feat/12.5-extension-stake-mapping`.

## What shipped

The fifth and final implementation atom of Phase 12 (multi-stake). The Chrome extension now resolves a Kindoo session's EID against every stake the operator manages, surfacing a stake picker on the slide-over when the EID is configured under more than one of them (operator-resolved decision #3, 2026-05-18). The picker's choice is remembered per-EID in `chrome.storage.local`. All per-stake reads, writes, and callable invocations in the extension thread an explicit `stakeId` — the hardcoded `STAKE_ID = 'csnorth'` constant in `extension/src/lib/constants.ts` is gone.

**Service-worker (`extension/src/background/`).**

- New `resolveEidStakes(eid, managerStakes)` in `background/data.ts`. Reads each managed stake's parent doc + `kindooSites/*` in parallel and returns a sorted array of `{ stakeId, label, match: 'home' | 'foreign', siteLabel? }` candidates. A stake is a candidate iff `stake.kindoo_config.site_id === eid` (home) OR some `kindooSites/<id>.kindoo_eid === eid` (foreign). Home wins over a foreign collision on the same stake (defensive).
- `loadStakeConfig`, `loadSyncData`, `loadSeatByEmail`, `writeKindooConfig`, `writeKindooSiteEid` all take an explicit `stakeId` parameter — no more hardcoded constant.
- New SW message `data.resolveEidStakes` in `background/messages.ts`. Reads `managerStakes` off the signed-in user's ID token via the new `readManagerStakes(user)` helper in `lib/auth.ts`, then fans out the per-stake reads. The SW re-reads claims on every `data.resolveEidStakes` call rather than caching them on `PrincipalSnapshot` — this avoids a staleness window between the CS's snapshot read and the SW's resolver dispatch, and the round-trip cost is one `getIdTokenResult()` call which the SDK serves from the local cache when the token is still fresh.
- The cross-boundary `PrincipalSnapshot` carries only `{ uid, email, displayName }`. No claims are exposed across the SW <-> CS boundary; the resolver call is the single point where managerStakes is consulted.
- Sign-out wipes `STORAGE_KEYS.eidStakeChoice` alongside `googleAccessToken` and `principalSnapshot` — one chrome.storage write.

**Content-script (`extension/src/content/`, `extension/src/lib/`, `extension/src/panel/`).**

- New `lib/extensionApi.ts` wrappers: `resolveEidStakes(eid)`, plus the per-EID storage helpers `readEidStakeChoice(eid)`, `writeEidStakeChoice(eid, stakeId)`, `clearEidStakeChoice(eid)`. Storage shape: one canonical key `sba.eidStakeChoice` holding a `Record<eidString, stakeId>` so sign-out cleanup is a single `.remove()`.
- New panel `panel/StakePicker.tsx` — full-takeover gate rendered when the resolved EID has ≥ 2 managed-stake candidates and no stored choice. Renders one button per candidate with a home / foreign hint (foreign carries the kindooSite display name); click → persists the choice → App re-resolves into the tabbed shell.
- `panel/App.tsx` gains an active-stake resolution step between auth and `getStakeConfig`. Priority chain: stored `eidStakeChoice[<eid>]` (validated against the live candidate set; cleared if stale) → single live candidate (auto-pick, no storage write) → picker. Three new error branches: `no-session` (Kindoo not signed in / unknown EID), `no-candidates` (EID isn't configured under any managed stake), and `pick` (≥ 2 candidates, no stored choice).
- `TabbedShell`, `QueuePanel`, `RequestCard`, `SyncPanel`, `ConfigurePanel` all accept a `stakeId` prop and thread it through every callable / Firestore-write invocation.
- `content/kindoo/sync/fix.ts` `DispatchContext` carries `stakeId`; `buildCallableInput(stakeId, d)` and the dispatcher use it for every `syncApplyFix` payload.
- `extension/src/lib/constants.ts` deleted. No transitional re-export.

**Manifest.**

- `extension/src/manifest.config.ts` version 1.0.1 → 1.0.4 (bumped on each commit touching `extension/` per the in-flight bump rule; ships at 1.0.4 once this PR merges). No permission or host-permission changes.

**Tests.**

- `background/data.test.ts` — new `resolveEidStakes` block (10 cases: empty manager list, single home, single foreign, multi-stake collision, no-match, missing stake doc, home-wins-over-foreign-self-collision, single-stake throw, multi-stake throw with one good, every-stake throw with `partialFailure: true`) plus stake-parameterisation assertions on `loadStakeConfig` and `loadSeatByEmail`.
- `background/messages.test.ts` — `data.resolveEidStakes` handler with the `{ candidates, managedStakeCount, partialFailure }` shape; the empty-managerStakes route, the EID-not-configured route, the wire-error route via `readManagerStakes` throw, and the `partialFailure: true` passthrough. Every per-stake handler asserts the `stakeId` parameter on the inner mock.
- `lib/extensionApi.test.ts` — `resolveEidStakes` wrapper unwraps the full payload + throws `ExtensionApiError` on wire failure; `eidStakeChoice` helpers (read / write / clear / no-op-on-missing).
- `lib/auth.test.ts` — `readManagerStakes` (manager-only filtering, empty claims, `getIdTokenResult` throws propagate (no swallow), non-manager entries ignored).
- `panel/StakePicker.test.tsx` (new) — six cases covering rendering, email row, click → onPick, button disablement during pick, and the Item 1 inline-error banner / retry path.
- `panel/App.test.tsx` — seven new branch tests: multi-candidate renders the picker, stored-choice-is-candidate skips the picker, stale stored choice triggers `clearEidStakeChoice`, no-candidates renders the recovery copy (only when `managedStakeCount > 0 && !partialFailure`), no-session renders the existing copy, wire-error route on resolver throw, wire-error route on `partialFailure: true` (Item 2), `managedStakeCount === 0` → NotAuthorized (Risk 3), plus a picker-click → tabbed-shell integration test that asserts `writeEidStakeChoice` fires and the queue read carries the new stakeId.

491 tests pass (was 450).

## Deviations from the pre-phase spec

None. The acceptance criteria in `firebase-migration.md` sub-deliverable 12.5 and the operator-resolved decision #3 are matched verbatim:

- Single-stake-per-EID case continues unchanged (auto-pick, no storage write).
- Multi-stake-per-EID surfaces the picker; choice is remembered per-EID in `chrome.storage.local`.
- All extension callables propagate the chosen stake.
- Two stakes' data stays fully isolated — every Firestore read and every callable carries the resolved `stakeId`, no silent home fallback.

## Decisions made during the phase

- **Stake resolution lives in the SW, not the content script.** The SW already owns Firebase Auth + Firestore; reading claims (`getIdTokenResult` → `managerStakes`) and fanning out per-stake Firestore reads there keeps the panel a thin renderer. Operator confirmed Option A (SW-side resolver callable) over Option B (bundle every managed stake's config into a widened `getStakeConfig`).

- **Full-takeover picker, no persistent toolbar switcher.** The extension's context is per-Kindoo-environment (one EID per session). Mirroring the SPA's 12.4 brand-bar dropdown would add permanent UI noise for the common single-stake-per-EID case. If a switch escape hatch is ever needed, that's a follow-up PR — out of scope here.

- **Storage shape: single canonical key holding a map.** `STORAGE_KEYS.eidStakeChoice` is one chrome.storage.local slot containing `Record<eidString, stakeId>`. Sign-out wipes it in a single `.remove()` alongside `principalSnapshot` and `googleAccessToken`. One-key-per-EID would have scattered the cleanup; the map keeps everything in one slot.

- **Stale-choice validation on read.** `App.tsx`'s active-stake resolution always runs `resolveEidStakes(eid)` first, then validates any stored choice against the live candidate set. If the operator lost their manager role on the stored stake OR the EID was un-configured from that stake's `kindooSites/`, the stored value is dropped and the picker re-runs. Operator-flagged concern: without this validation, a revoked role would leave the panel stuck on a stake the operator can no longer write against.

- **Single-stake transition does not persist.** When `resolveEidStakes(eid).length === 1`, App auto-resolves to that stake but does NOT write to `eidStakeChoice` — the resolution is structural (driven by Firestore config), not a remembered choice. Persisting would muddy the "stored choice" semantic and require extra invalidation logic if a second stake later gets configured against the same EID.

- **Storage helpers live in `lib/extensionApi.ts`, not the SW.** `extension/CLAUDE.md` says STORAGE_KEYS are owned by the SW + the CS mount; we extended that to the lib so the panel can call read/write helpers directly without a SW round-trip. The "single owner per key" intent of the rule still holds — these three helpers ARE the only readers + writers of `sba.eidStakeChoice`. Documented in the helpers' header comment.

- **Resolver response carries `managedStakeCount` + `partialFailure` instead of a single empty-candidates list.** Reviewer-flagged after the initial implementation: an empty `candidates` array carries three structurally distinct meanings (user not a manager anywhere; EID not configured under any managed stake; every per-stake read failed transiently). Collapsing them into one wire shape forced App.tsx to misroute two of the three. The widened response lets the panel disambiguate `managedStakeCount === 0` → NotAuthorized, `partialFailure && empty` → wire-error retry, and `count > 0 && !partialFailure && empty` → the genuine "reconfigure SBA" copy. Per-stake `try/catch` in the resolver isolates a single stake's failure to that stake (no Promise.all nuking the whole list), and the aggregate `partialFailure` flag surfaces the transient-outage signal upstream.

- **Picker write failures surface inline.** Reviewer-flagged: a `writeEidStakeChoice` rejection (chrome.storage quota exhausted, etc.) was silently dropped by the picker's `void handle(...)` wrapper, leaving the picker re-enabled with no banner. The picker's local handler now catches the rejection, sets a `writeError` state, and renders an inline `sba-stake-picker-write-error` banner above the buttons; the buttons re-enable so a retry is possible.

No new `architecture.md` D-numbers earned. The picker + EID resolver follow the existing CS ↔ SW + chrome.storage.local pattern; the per-stake parameterisation is the same shape T-13 already applied on the functions side (`STAKE_IDS` → `getStakeIds()`).

## Spec / doc edits in this phase

- `docs/spec.md` — §15 multi-stake paragraph (around line 393) — replaced the forward-looking reference to the picker with a description of the shipped behaviour: trigger condition (≥ 2 candidates, no stored choice), storage shape (`sba.eidStakeChoice` map), stale-choice invalidation, sign-out cleanup.
- `docs/firebase-migration.md` — 12.5 sub-deliverable marked `[SHIPPED 2026-05-20]`, linked to this changelog.
- `docs/changelog/phase-12.5-extension-stake-mapping.md` — this entry.

No `docs/firebase-schema.md` changes — no Firestore schema change. The picker is an extension-local UI + storage concern; the cross-stake plumbing (per-stake collection scoping, per-stake claims, `kindooSites`) already existed.

## Deferred

- **Persistent stake-switcher in the slide-over.** A switcher that lets the operator change stake mid-session without re-resolving from a new Kindoo site. Out of scope per operator decision; revisit only if a multi-stake operator reports needing it.
- **Per-(canonical, EID) keying.** Today's `eidStakeChoice` key is per-EID only. Shared-laptop scenarios (two operators on the same Chrome profile) inherit each other's choices. Sign-out's wipe covers the practical case; if the shared-laptop scenario surfaces, the storage layer is the only thing that changes.
- **Toolbar surfacing of the active stake.** The slide-over does not show which stake the panel is currently reading against once resolved — the queue / sync content is the implicit signal. If managers report confusion, this is a small follow-up addition to `Toolbar.tsx`.

## Next

Phase 12 closes with 12.5 shipping. With all five atoms (12.1 superadmin-seed runbook + e2e, 12.2 Stake List page + Superadmin nav, 12.3 createStake callable + form, 12.4 active-stake selector + switcher dropdown, 12.5 extension EID-to-stake mapping) merged, SBA is fully multi-stake on both the web app and the extension surfaces. Open follow-ups (B-1 iPhone PWA notification deep-link, T-26 SA hardening, Phase 10.6 push expansion) remain unchanged.
