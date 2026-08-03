# Limited app access

**Shipped:** 2026-08-02
**Commits:** PR #244 (`feat/limited-app-access`); architecture decision D25.

## What shipped

A Kindoo Manager can now grant someone **limited** app access instead of full. A limited user may create only temporary requests, edit and remove only temporary seats, request a temp window of at most 90 days, and — at ward scope — request only their own ward's building. Everyone else is untouched: the marker is absent on every existing grant, absence means full, and no user, grant, or token was backfilled.

The shape is deliberately small — one optional field on a manual grant, one derived boolean on the per-stake claim block, and one extra conjunct on the requests `create` predicate. The direct motivation is ward-level helpers who need to arrange short-term building access without acquiring authority over ongoing grants; the immediate next step is Elders Quorum Presidents arriving limited through the importer / Sync flow (D23 gave them access; this gives the access a tier).

## Deviations from the pre-change spec

The spec was updated in the same PR; these are the behavioural deltas it now reflects.

- **`manual_grants[].level?: 'limited'`.** A per-grant tier marker, manager-written, absent means full, and **never written `'full'`** — grant deletion is an `arrayRemove` matching by deep equality, so a stray `'full'` would make the grant undeletable. No access-rules change was needed: `manual_grants` already sits in the access-update `affectedKeys()` allowlist. Spec: §5.3; schema §4.5.
- **`StakeClaims.limited?: boolean`.** Minted by `computeStakeClaims` when the user holds ≥1 grant in the stake, **every** grant is limited, and they are not an active Kindoo Manager. Written only when true. Spec: §4; schema §2.
- **Importer callings get a tier by name.** `LIMITED_ACCESS_CALLINGS` + `isLimitedAccessCalling()` in `packages/shared/src/appAccessCallings.ts`. Nothing is stored on the access doc. **The set ships empty.** Spec: §4; schema §4.5.
- **The requests `create` predicate narrows for a limited caller.** Type restricted to `add_temp` / `edit_temp` / `remove`; temp windows ≤ 90 days; ward-scope temp requests locked to exactly the ward's own building; `remove` and `edit_temp` each only against a seat whose `type == 'temp'` (keyed on `seat_member_canonical` and `member_canonical` respectively). Last conjunct in the predicate, short-circuiting on `!isLimited(stakeId)`. Spec: §6, §6.1; schema §6, §6.1.
- **The New Request form and the Edit Seat dialog narrow to match.** Temporary is the only offered type (and the mount default, and the post-submit reset value); the 90-day cap is stated as helper text and validated on `end_date` **as soon as both dates are filled in**, not at submit — `useLiveTempWindowCheck` re-runs react-hook-form's `trigger('end_date')` once both values are well-formed, so the message appears and clears live while every other field keeps submit-time validation; at ward scope the buildings checklist collapses to a read-only row naming the ward's building. Stake scope keeps the normal site-filtered checklist. Spec: §5.1, §5.2.
- **Edit and Remove affordances disappear on non-temp rows.** `canEditSeat` and `canRemoveSeat` gate all three roster pages at once. Spec: §5.1, §6.1.
- **The App Access page gains an access-level selector, and every row states its tier.** Full / Limited on the "Add manual access" modal. Every row is then labelled — `Full` as a quiet blue chip, `LIMITED` as a red bordered uppercase one — in the **Scope** column in the table, and beside each grant's reason in the card view (a single scope can hold grants at different tiers, so the card chip has to stay per-grant). Importer rows read `Full`: `importer_callings` is a `Record<scope, string[]>` of bare calling strings with nowhere to store a tier, so importer access is full by construction. There is no edit-level control — re-tiering is delete-and-re-add. Spec: §5.3.
  - Labelling **both** tiers rather than only Limited was operator-directed, and it is a correctness fix rather than polish: while an unlabelled row meant "full", a full grant, a genuine bug, and a stale service-worker bundle all rendered as the same empty cell. That ambiguity cost an hour of staging debugging on this very PR before the cause turned out to be a cached bundle.
- **Temp-window arithmetic runs on UTC midnights.** `packages/shared/src/tempWindow.ts` is the single copy of the comparison the client and the rules must agree on; parsing `YYYY-MM-DD` in local time would make a DST-straddling window measure 89.96 days in one place and 90.04 in the other. Exactly 90 passes, 91 does not, everywhere.

## Decisions made during the phase

- **One marker plus one derived boolean, defaults off.** Recorded as **D25**. Absence means full at every layer: the grant carries no key, the claim omits the field, the rules guard on `'limited' in …`, and the parse counts only positive evidence as a restriction. Shipping the feature therefore changed nothing for anybody until a manager deliberately used it.
- **The claim is never written `false`.** `applyClaims`'s `claimsEqual` is a canonical-JSON compare, so emitting `limited: false` for every full user would read as a claim change on the next sync and revoke their refresh token to communicate nothing.
- **Malformed data reads as full, not limited.** A missing `level`, `'full'`, wrong casing, a null / string / array entry where an object was expected — all full. The failure direction for garbage data is toward more access; a half-written grant must not silently lock someone out of a surface they had yesterday.
- **An active Kindoo Manager is never limited,** regardless of what their access doc says. The manager row is a full-trust role and the rules' manager carve-outs already assume it.
- **Two enforcement layers, both at creation time — no `markRequestComplete` third layer.** See "What didn't change" below; this is the deliberate contrast with Policy 1.
- **The ward-building lock resolves id-first on both sides.** Landed as a follow-up on the rules half after the first cut read `ward.building_name` directly. See "Known issues" and T-74.

## What didn't change (load-bearing non-changes)

- **The `access` collection's security rules.** `manual_grants` was already the manager's writable lane and already in the update `affectedKeys()` allowlist; the `create` predicate only counts entries. A grant object with one extra key rides the existing rule untouched. This is why the whole storage decision came down to "put a marker on the grant."
- **`markRequestComplete`.** No tier check at completion, deliberately. A requester's tier can legitimately change between submit and complete — a manager adds a full grant, or deletes the last limited one, while the request sits in the queue — and a completion-time re-check would reject a request that was valid when submitted, for a reason the completing manager can neither see on the card nor fix. Every field the limited clause constrains is immutable on the request between submit and complete (the update rule's `affectedKeys()` allowlists exclude `type`, `scope`, `start_date`, `end_date`, `building_names`, and `seat_member_canonical`), so nothing can be smuggled past the create gate afterwards. Policy 1 earns its third layer because "stake auto seats are not editable" is a permanent property of the *seat*; a tier is a property of the *requester* and can drift.
- **`applyClaims`.** The claim-writing path is unchanged — it compares, writes, and revokes exactly as before. Only the payload `computeStakeClaims` hands it gained a field, and only for the users who have one.
- **The `seats` rules block.** Nothing about seat writes moved. A limited user's authority is expressed entirely through which *requests* they may create; seat mutation stays request-only (and the inline organization chip stays the sole direct client seat-write, D21).
- **Full users' claim blocks are byte-identical.** No key added, no refresh token revoked, no re-sign-in. The rollout is invisible to every existing user.
- **`WARD_APP_ACCESS_CALLINGS` / `STAKE_APP_ACCESS_CALLINGS` and the D23 opt-in.** Who gets app access is unchanged; this PR only adds a tier to access that was already being granted. `LIMITED_ACCESS_CALLINGS` ships empty, so no importer-derived grant is limited today.
- **Stake scope keeps the free building choice.** The ward-building lock is conditional on `scope != 'stake'` in both the form and the rule — there is no single ward to lock a stake-scope request to, so a stake-scope limited user sees the normal home-site-filtered checklist.
- **No backfill, no migration, no new index.** The `remove` and ward-building checks are point `get()`s / `exists()`s on documents the path already names.

## Spec / doc edits in this PR

- `docs/spec.md` — §4 claims block gains `limited?: boolean`, plus a "Limited app access" passage (semantics, the precedence rule, absent-means-full, the no-token-churn reason); §5.1 the roster remove/edit narrowing and the narrowed New Request form; §5.2 the stake-scope case (cap yes, building lock no); §5.3 the App Access access-level selector and Limited badge; §6 the limited clause on the "Rules enforce" line; §6.1 a Limited column on the edit table, a constraint table pairing each rule predicate with its SPA mirror, the id-first ward-building resolution, the client-stricter-than-rules invariant, and the creation-time-only enforcement decision.
- `docs/architecture.md` — added **D25**. D24 (manager blanket request authority, PR #240) is unedited.
- `docs/firebase-schema.md` — §2 the `limited` claim and its write conditions; §4.5 `manual_grants[].level`, the manager-written / never-`'full'` rule, importer-calling tier derivation, and the no-access-rules-change note; §6 the `isLimited` helper, the four limited helpers, and the create-predicate clause; §6.1 two new rules notes.
- `docs/user-guide/creating-requests.html` — §1 "Who you are in the app" (who has limited access and how to tell); §5 the narrowed request type; §6 the 90-day maximum and the ward-building lock; §7 / §8 temporary-only removal and editing; §11 two FAQ entries.
- `docs/user-guide/kindoo-managers.html` — §4 App Access page summary; §8 a new "Full and Limited access" subsection (choosing a tier, what Limited restricts, the badge, delete-and-re-add to change tier); §12 a troubleshooting entry.
- `docs/changelog/limited-app-access.md` — this entry.
- `docs/TASKS.md` — added T-74 (`buildingRenameBlocker` ignores ward references) and T-75 (code comments cite D24; the decision is D25).

## Migration note

None. Absent means full, so every existing grant, claim block, and token keeps today's behaviour. There is nothing to backfill, and nothing to un-backfill if the feature is never used.

The one migration this design *defers* is the Elders Quorum President follow-up: adding `EQ_PRESIDENT_CALLING` to `LIMITED_ACCESS_CALLINGS` changes only what the claim computation derives, and `syncAccessClaims` fires on access-doc writes — nothing about those docs changes when the constant does. That step will need an explicit claim re-mint for existing EQ-President access docs.

## Known issues / deferred work

- **A limited user with direct API access can remove a manual duplicate grant that sits under a temp primary seat.** Stated plainly rather than as an abstract asymmetry, because it is a real if narrow widening of what a limited user can reach. `limitedRemoveTargetIsTemp` and `limitedEditTargetIsTemp` can only read the seat's **primary** `type` — a rules `get()` cannot cheaply prove which `duplicate_grants[]` row a request targets — so a hand-crafted `remove` naming a seat whose primary is temp passes the create predicate even when the row being removed is a manual duplicate in that user's scope. `canRemoveSeat` blocks it in the UI by also inspecting the grant row, but the rule is the trust boundary and the UI is not. What contains it: the request still lands in the queue as `pending` and a Kindoo Manager must complete it, so it is a request for privileged action rather than the action itself. Accepted at this scale; closing it would mean either denormalising the duplicate-grant tier onto the seat or moving removal behind a callable.
- **T-74 — `buildingRenameBlocker` does not count ward references.** A ward with no seats can have its building renamed out from under its `building_name` snapshot. Not a blocker here (both sides resolve id-first, which is exactly why the rules helper was revised), but a latent data-integrity gap.
- **No UI for re-tiering a grant in place.** Changing someone from Full to Limited (or back) means deleting the grant and adding a new one. Deliberate for a first cut — the alternative is an edit-level control on a doc whose deletion path matches by deep equality.
- **A limited user cannot shorten someone else's over-long temp seat without also shrinking it below 90 days.** If a full user previously granted a 180-day temp window, a limited user opening that seat must bring the window inside the cap before the form will submit. The cap is on what a limited user may *request*, not on what already exists, so the seat is otherwise unaffected.
