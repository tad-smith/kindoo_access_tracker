# Stake-gated Elders Quorum President app access

**Shipped:** 2026-08-02
**Commits:** PR #241 (`feat/eq-president-app-access`); architecture decision D23.

## What shipped

A stake can now grant in-app (web/SPA) access to its Elders Quorum Presidents. One boolean on the stake doc — `eq_president_app_access`, opt-in and off when absent — adds **Elders Quorum President** to the ward app-access calling set for that stake only. Everything else about the app-access list is unchanged. Flipping the switch is not retroactive, so the Configuration → Config tab offers a one-pass backfill (or un-backfill) over the seats that already hold the calling, backed by a new `backfillEqPresidentAccess` callable.

This is the first per-stake app-access configuration since D17 deleted the calling templates, and it is a deliberate partial reversal of D17(a)'s "the list is exclusive — no per-stake customization" clause. It is a *gate on the fixed list*, not a mechanism for expressing arbitrary lists.

## Deviations from the pre-change spec

The spec was updated in the same PR; these are the behavioural deltas it now reflects.

- **One ward calling is stake-gated.** `stake.eq_president_app_access === true` adds Elders Quorum President to the **ward** set; the stake set is never affected, and the match is on the exact title — the quorum's counselors and its secretary never grant access. `WARD_APP_ACCESS_CALLINGS` / `STAKE_APP_ACCESS_CALLINGS` are unchanged; the gate rides on a new optional `AppAccessOptions { eqPresidentAccess?: boolean }` trailing parameter on `appAccessCallingsForScope` / `filterAppAccessCallings`. Spec: §8; schema §4.1 / §4.5 / §4.8.
- **Absent means off, and the read idiom is `=== true`.** Deliberately the opposite defaulting from `notifications_enabled` (`?? true`). Every reader — schemas, forms, `syncApplyFix`, the callable, the extension — tests `=== true`. `createStake` writes `false` explicitly on new stakes. Spec: §3.2, §8; schema §4.1.
- **`syncApplyFix` threads the flag.** It reads the stake doc once per invocation (after the manager gate, before the drift-type switch) and passes the options into `applyKindooOnly`, `applyCallingsMismatch`, `applyTypeMismatch`, and `applyKindooUnparseable` (inert there — that path probes the stake set). A missing stake doc reads as off. A config flip landing mid-Sync-run is a benign race the next run heals. Spec: §8.
- **The Config tab gains a switch and a flip-triggered dialog.** "Elders Quorum Presidents Get App Access" sits below the notifications switch. A save that *changes* the value opens a confirm dialog offering "Grant access now" (OFF→ON) or "Revoke access now" (ON→OFF); declining leaves existing access untouched. The config save lands whichever way the dialog is answered. Suppressed unless `setup_complete === true`. Spec: §5.3, §8.
- **The bootstrap wizard's Step 1 gains the same switch, with no dialog.** A stake still in setup has no seats to reconcile. Spec: §10.
- **New `backfillEqPresidentAccess` callable.** `{stakeId, direction:'grant'|'revoke'}` → `{ok, seats_matched, docs_written, docs_deleted}`. Active-Kindoo-Manager auth; `direction` guarded against the stake's current flag. Merge-only writes into `importer_callings[scope]`; idempotent both ways. Spec: §8; schema §4.5 / §7.
- **The extension's primary-segment tiebreak reads the same flag.** `pickPrimarySegment` / `pickSegmentForSite` (parser) and `pickSegmentForSite` / `buildKindooBlock` (detector) thread it so drift rows agree with the server on which segment grants access. Manifest 1.0.50 → 1.0.51.

## Decisions made during the phase

- **Elders Quorum President app access is the single per-stake app-access degree of freedom — one opt-in boolean, not a template revival.** Recorded as **D23**, partially superseding D17(a). D17 deleted config nobody varied; D23 adds config stakes demonstrably do vary — Elders Quorum Presidents assign temporary access for building cleaning and building lockup assignments, and not every stake works that way, so no single churchwide answer is right. Alternatives ruled out: adding the calling churchwide (grants a real authorization surface in stakes that don't want it), reviving the template collections (D17's whole point, and an editor UI plus a matcher to express one boolean), and leaving it to per-person manual grants (hand bookkeeping every time a quorum presidency turns over — exactly what calling-derived access exists to avoid). See `architecture.md` D23 for the full rationale.
- **The backfill is a confirmed second action, not a side effect of the save.** The save is cheap and reversible; the sweep writes access docs across the whole stake. Implicit reconciliation would let a mis-click revoke app access for every Elders Quorum President in the stake with no confirmation.
- **`direction` is an explicit parameter guarded against the stake's current config,** rather than inferred server-side. A retry is unambiguous, a stale dialog confirmation (config never saved, or flipped back since) fails `failed-precondition` instead of writing the wrong side, and the two paths can be tested in isolation.
- **Merge-only, not `writeAccessForAutoScope`'s wholesale replace.** Rebuilding a scope's list from the seat's callings would also silently "fix" unrelated stale entries — beyond the action the operator consented to.

## What didn't change (load-bearing non-changes)

- **The calling list is otherwise still fixed.** Only this one ward calling is gated. There is still no wildcard mechanism, no per-stake list editing, and no template collection. `WARD_APP_ACCESS_CALLINGS` and `STAKE_APP_ACCESS_CALLINGS` are byte-for-byte unchanged.
- **Counselors and the quorum secretary are excluded.** The match is the exact title `Elders Quorum President`. Elders Quorum First/Second Counselor and Elders Quorum Secretary grant nothing in either toggle state.
- **The stake set is never gated.** `appAccessCallingsForScope('stake', opts)` returns the same set regardless of the options, which is why `applyKindooUnparseable`'s threading is inert.
- **`manual_grants` is untouched by the backfill in both directions.** An Elders Quorum President who also holds a manual grant keeps it on revoke, and a manual-grants-only access doc is never deleted.
- **Seat type is unaffected.** It stays role-derived (`DepartmentType`) + door-grant-derived. App access and seat type remain independent, as they have been since D17.
- **Roster and access sort order are unaffected.** `callingSortOrder` already ranks Elders Quorum President; the opt-in changes who gets access, never how anyone sorts.
- **No Firestore rules change and no new index.** The stake-doc `update` rule carries no per-field allowlist, so a new config field needs no rules edit (verified against the emulator); the backfill sweep runs a single-field `where('type','==','auto')` query.
- **No wire, protocol, or permission change in the extension.** The stake doc already flows whole to the content script — the flag was already on the wire, just unread.
- **Audit and claims stay automatic.** `auditTrigger` fans the access rows and `syncAccessClaims` re-mints claims from the resulting writes; the callable writes neither.

## Spec / doc edits in this PR

- `docs/spec.md` — §3.2 stake parent-doc field list + `access` doc bullet; §5.3 Config-tab key list and the "no per-stake config" assertion; §8 "App access" rewritten (gated ward calling, the opt-in and its `=== true` idiom, non-retroactivity in both directions, the backfill dialog, the callable), plus `callings-mismatch` / `kindoo-unparseable` reworded off "hard-coded"; §10 bootstrap Step 1.
- `docs/architecture.md` — added **D23**; cites the partially superseded D17(a) clause. D17's row is unedited.
- `docs/firebase-schema.md` — §4.1 the new field with the opt-in / absent-is-off note; §4.5 `importer_callings` may carry the calling on ward scopes, plus the callable's merge-only write semantics; §4.8 tombstone qualified; §6 stake-doc rule note (no per-field allowlist); §7 the new callable row.
- `docs/user-guide/kindoo-managers.html` — §2 setup wizard step 1; §4 Configuration tab fields; §6 "When to run Sync" callout; §8 "App access: who can sign in" (the fixed-across-the-Church claim qualified, Ward row annotated, new subsection on the switch and the backfill); §10 notifications pointer; §12 troubleshooting entry.
- `docs/user-guide/creating-requests.html` — §1 "Who you are in the app".
- `docs/changelog/eq-president-app-access.md` — this entry.
- `docs/TASKS.md` — T-72 closed.

## Migration note

None needed. The field is opt-in and absent means off, so every existing stake keeps today's behaviour until a manager turns the switch on. The callable **is** the opt-in migration: it is what carries existing Elders Quorum Presidents from "the toggle is on" to "they actually hold access", and its revoke direction is the same pass in reverse. Without it, the toggle only changes what future Sync runs derive.

## Known issues / deferred work

- **No drift code detects "access disagrees with the toggle."** If a manager declines the backfill (or the callable fails), existing grants persist until Sync next rewrites that seat's callings. This is the designed behaviour, not a defect — but it means the toggle alone is never a revocation. Re-running the dialog's action is possible only by flipping the switch back and forth; the callable itself is idempotent and safe to retry.
