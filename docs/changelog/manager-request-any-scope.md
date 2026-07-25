# Kindoo Managers may request in any scope

**Shipped:** 2026-07-24
**Commits:** PR #240 (`feat/admin-request-any-scope`) — `78d480c` (rules), `77bf91f` (shared / functions / web requester label), `45df34b` (web scope authority), `6b73c22` (extension), docs (this commit)

## What shipped

A Kindoo Manager may now create a request in **any** scope — the stake and every ward — for every request type (`add_manual`, `add_temp`, `edit_manual`, `edit_temp`, `edit_auto`, `remove`), holding nothing but `stakes[stakeId].manager === true`. No `access` row, no stake claim, no bishopric claim. The affordances follow: the "New Request" button renders for them on the Stake Roster and on every ward in Ward Rosters, and the per-row Edit / Remove affordances render on every row Policy 1 doesn't hide. Because a manager-submitted request has no `access` row to name its requester, the requester line now falls back to the `kindooManagers` doc and renders `{Name} (Kindoo Manager)` on the manager Queue, in the manager notification emails, and in the extension panel.

This **reverses the B-3 / T-36 hardening** (PR #52), which had deliberately removed the `isManager` blanket from the requests `create` predicate, and deletes the `add_manual` / `scope: 'stake'` carve-out (PR #223) that had already punctured it.

## Why

The premise behind B-3 / T-36 was that a Kindoo Manager is a downstream fulfiller, not a requester, so offering them scope options for roles they didn't hold was a UI bug. Production use inverted that premise. The manager is frequently the person who knows a grant is needed and can describe it precisely, and requiring a parallel `access` row purely to unlock the submit button is bookkeeping with no safety value — the same person can already complete any request in the queue, including one they submitted themselves (the self-approval policy, `spec.md` §6).

PR #223 had already conceded the point for the flow that hurt most. What remained was arbitrary: the same manager could create a stake-scope `add_manual` but not a stake-scope `add_temp`. Blanket authority is the honest model, and it collapses three rule branches into one sentence a reader can hold in their head.

Worth noting for anyone reading the history: this is where Phase 6 originally landed. `docs/changelog/phase-6-request-lifecycle.md` records commit `982be4e` OR-ing `isManager(stakeId)` into the head of the create rule's role clause precisely because the then-current spec said managers submit in any scope, and a manager-only submit was failing. PR #52 removed it three days later, on the opposite reading. D23 restores the Phase 6 shape with the rationale written down this time.

Three sub-decisions, all recorded as `architecture.md` D23:

- **Blanket, not an intersection.** Manager authority is not intersected with the caller's claim-derived scopes. A **manager who also holds a Bishopric claim may now submit for wards outside that claim** — this changes behaviour for managers who already had an `access` row, not only for those without one. The alternative (intersect) would mean a manager+Bishopric user reaches *fewer* wards than a manager-only user, which is indefensible, and would reproduce exactly the "your reach depends on which other roles you happen to hold" confusion B-3 was filed about.
- **Platform superadmin status alone still grants nothing.** Only the per-stake manager claim carries request authority. A superadmin administers stakes structurally and has no business authoring access requests inside one. This deliberately diverges from `apps/web/src/components/layout/navModel.ts:75`, whose `isManager` helper *does* treat a superadmin as a manager — that is a nav-visibility convenience, not an authority claim. The divergence is regression-guarded in `apps/web/src/features/requests/tests/scopeOptions.test.ts`.
- **The rule does not verify the ward code exists.** A manager could write a `scope` naming a ward absent from the `wards` collection. Checking would cost an `exists()` read on every submit; the only principal who can reach the gap is a trusted manager, the SPA only ever offers codes from the live catalogue, and the failure mode is a request rendering under an unresolved label — a data-quality gap, not an escalation. Accepted deliberately, not overlooked.

## What didn't change

- **`GrantStakeAccessDialog` is unchanged and still shipping.** The rule branch that backed it is gone (subsumed), but the dialog is not: its Kindoo-license warning banner and home-site building filter are what make it distinct, not the authority it carries. `spec.md` §6.1 / §15 describe it exactly as before.
- **Policy 1 binds managers.** `edit_auto` at `scope == 'stake'` is still forbidden for everyone. It is an independent conjunct in the rule, evaluated before the role branches, and the first early-return in `canEditSeat` — no role branch can satisfy it. Test-guarded on both sides.
- **The payload contract.** The manager branch widens WHO may create, never WHAT the request must carry. Non-empty `member_name` for add types, non-empty `building_names` for stake-scope add/edit types, the required `comment` on edit types, `lastActor` matching the auth token — all still bind a manager submit, and the rules tests assert it.
- **The stake and bishopric branches.** Untouched. A bishopric user with no stake claim still reaches only their own wards; the B-3 fix's bishopric half stands.
- **Route gating.** `holdsAnyRole` already treated a manager claim as a superset passing the `stake` and `bishopric` route gates, so `/stake/roster` and `/stake/wards` were already reachable by a manager without a stake claim. No route change was needed — the affordances inside those pages were the only thing missing.
- **The Bishopric Roster is still not a manager surface.** That page draws its ward list from `principal.bishopricWards`, so a manager holding no bishopric claim sees no ward to render there. Ward Rosters is their cross-ward reach. Left as-is deliberately: two cross-ward surfaces would be one too many.
- **No rule change for the new reads.** `kindooManagers` is already manager-read-only, which the manager-gated Queue, the SW token, and the Admin SDK all satisfy.

## Deviations from the pre-change spec

None silently. `spec.md` asserted the "manager status alone does not qualify" premise in five places (§5 default-landing, §5.2 Stake Roster and Ward Rosters, §6 step 1, §6.1 "Who can submit"); all are corrected in this commit, along with the three requester-line derivations (§5.3, §9, §15) that described the `access` doc as the only source.

## Spec / doc edits in this change

- `docs/spec.md` — §5 route-gating paragraph gains the `holdsAnyRole` superset note; §5 default-landing rule's closing sentence rewritten (a manager *can* create a request, on the Stake Roster and every ward in Ward Rosters, but not on the Bishopric Roster); §5.2 Stake Roster and Ward Rosters gating corrected; §5.3 requester-line derivation gains the `kindooManagers` backstop; §6 step 1's rules-enforced-scope sentence; §6.1 "Who can submit" replaced by the three-branch table plus the blanket / superadmin / Policy 1 / payload / ward-code-non-guard paragraphs; §6.1's "only path on which manager status alone authorises a stake-scope create" sentence replaced with the dialog's unchanged-and-shipping note; §9 and §15 requester-label derivations updated to the two-doc read.
- `docs/architecture.md` — new **D23**, the full decision: reversal rationale, blanket-not-intersection, the superadmin exclusion and its deliberate divergence from `navModel.ts`, Policy 1 survival, the accepted ward-code non-guard, and the requester-display backstop. Cites D15 and D21.
- `docs/firebase-schema.md` — §4.4 "Read by" now names the requester-label derivation; §4.7 invariants replace the `add_manual` carve-out with the blanket-authority statement and extend the requester-display invariant to `kindooManagers`; the §6 rules mirror updated to the landed three-branch predicate; §6.1 notes replace the B-3 / T-36 role-for-scope bullet and the carve-out bullet with the current gate plus a bullet on the ward-code non-guard.
- `docs/BUGS.md` — B-3 gains a `[REVERSED 2026-07-24]` trail; original wording preserved.
- `docs/TASKS.md` — T-36 gains a `[REVERSED 2026-07-24]` trail; original wording preserved.

## Deferred

- Nothing gated on this change. The ward-code existence gap (D23e) is accepted, not tracked — file a task only if a bad scope ever reaches production data.
