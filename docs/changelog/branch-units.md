# Branches as units — one shared unit-name → Kindoo scope-name rule

**Shipped:** 2026-08-09
**Commits:** `feat/branch-units` (PR #268), docs on `feat/branch-units-docs`

## What shipped

A stake can hold **branches** alongside wards, and the system can tell them apart. It does so from the unit's name alone — a name ending in `" Branch"` is a branch — and the whole rule now lives in one module, `packages/shared/src/unitName.ts` (`unitType`, `kindooScopeName`, `kindooScopeNameVariants`).

| `ward_name` | unit type | Kindoo scope name | resolves from |
|---|---|---|---|
| `Maple` | ward | `Maple Ward` | `maple`, `maple ward` |
| `Maple Ward` | ward | `Maple Ward` | `maple`, `maple ward` |
| `Peterson Branch` | branch | `Peterson Branch` | `peterson branch` |

Four surfaces were rewired onto it: `resolveScopeName` in `extension/src/content/kindoo/provision.ts` (write), `parseDescription` in `extension/src/content/kindoo/sync/parser.ts` (read), `collidesWithOwnWard` in `packages/shared/src/kindooIgnoredWards.ts` (ignore-list collision), and `scopeRowLabel` in `functions/src/services/EmailService.ts` — whose notification row now reads `Branch:` for a branch instead of `Ward: Peterson Branch`.

The web copy for the three fields that take a unit name — the bootstrap wizard's Step 3, Configuration → Wards, and Wards to Ignore in Kindoo — is now `Ward or branch name`, from `WARD_NAME_LABEL` in `apps/web/src/lib/wardCopy.ts`. The two fields that *create* a unit also carry `WARD_NAME_HINT`, which states the suffix rule.

**A fifth module is new — the uniqueness guard, `packages/shared/src/unitNameCollision.ts`.** `findUnitNameCollision(name, existingNames)` returns the first existing unit whose `kindooScopeNameVariants` set intersects the candidate's, and `unitNameCollisionMessage` wraps it in the rejection copy. Both surfaces that create a unit consume it: Configuration → Wards through `duplicateWardNameBlocker`, and the wizard's Step 3 directly against its pending list. This is a behaviour change, not a refactor — a create or rename into a collision is now **blocked** where it previously saved. `Maple` beside a stored `Maple Ward` is refused, and so is a branch `Olive Branch` beside a ward `Olive Branch Ward`, whose canonical names differ but which both claim the lookup key `olive branch`. The message names which of the three cases fired, because the latter two read as false positives otherwise. That closes **B-20**, which this PR surfaced and fixed in the same PR.

Rewiring `collidesWithOwnWard` onto the shared variants (the third surface above) flips a result too: `collidesWithOwnWard('Pine', ['Pine Ward'])` was `false` and is now `true`, so Wards to Ignore refuses an entry naming the stake's own unit whichever form either side is spelled in.

## Why

**The rule already existed; it just existed three times.** The `" Ward"` suffix has always been optional in SBA and mandatory in Kindoo's rendering, and each consumer had solved that for itself. Their comments had drifted into mutual contradiction: `kindooIgnoredWards.ts` asserted SBA "stores `ward_name` without the trailing `" Ward"`", `packages/shared/src/types/ward.ts` documented the field as a display name reading `"3rd Ward"`, and `provision.ts`'s `wardScopeDisplayName` appended conditionally, agreeing with neither. Each was right about its own path and wrong about the others'. That is the invisible-drift failure `packages/shared` exists to prevent (`packages/shared/CLAUDE.md`), and it is why the branch case could not be added by patching any single site — three copies would have become three copies with a branch case each.

**The name is the discriminator, and there is deliberately no `unit_type` field.** Kindoo has no structured notion of unit type: the Description string is the entire interface, and Church Access Automation writes it off the unit's own name. A stored type would be a second copy of a fact the name already carries, settable independently of it, so its failure mode is a doc whose type says `branch` and whose name says `Maple` — with the write side still having to decide which one Kindoo's string follows. It would also cost a migration across every existing ward doc and a form control the operator has to keep in agreement with the name they just typed. Recorded as `architecture.md` D31, including the instruction not to propose the field later.

**The asymmetry between the two suffixes is not an oversight.** A ward's `" Ward"` is optional in both directions because SBA has accepted both forms since the first stake and Kindoo always renders the suffixed one; both must resolve. A branch's `" Branch"` is required and its scope name is verbatim, because appending `" Ward"` to `"Peterson Branch"` produces a string Church Access Automation never writes — and the provisioner compares descriptions with a strict `!==`, so it would rewrite the Description on every single pass. For the same reason the read side registers **no** `"Peterson Branch Ward"` key: symmetry with wards would buy nothing, since that key could only ever mis-resolve.

**`Ward or branch name` on the ignore-list field, but not its hint.** That field matches against Kindoo's own description text, where nothing is optional, so the create-side hint would be wrong guidance there. It keeps its `Ward name as Kindoo shows it` placeholder.

## What didn't change that you'd expect to

- **`ward_code` is still `buildingSlug(ward_name)` verbatim**, not `buildingSlug(kindooScopeName(ward_name))`. So `"Maple"` lands at `maple` and `"Maple Ward"` at `maple-ward` — the doc ID records which form the operator typed. Normalising it would have been a migration on an immutable foreign key by value (D3), and the code is never rendered and never matched against Kindoo, so the divergence is inert.
- **No `unit_type` field, no schema change at all.** `stakes/{stakeId}/wards/{wardCode}` is byte-identical to before; branches have always been storable, just not distinguishable.
- **No new collection.** Branches live in `wards`, which is why `firebase-schema.md` §4.2 now says "unit" where it used to say "ward" and the collection name stays.
- **The calling tables are untouched.** `callingSortOrder.ts` and `appAccessCallings.ts` remain ward/stake only, so a Branch President parses to a valid scope and an unknown calling: bottom of its sort band, no derived app access. Deliberate — see T-96.
- **No rules change.** Nothing about the unit's kind reaches `firestore.rules`.

## Known issues / deferred

- **T-96 — branch-specific callings.** Fully specified and deliberately not implemented: the six branch callings, the 19 ward-family entries that carry over unchanged, and the four that grant app access — Branch President, Branch Presidency First / Second Counselor, Branch Clerk, plus Elders Quorum President when `stake.eq_president_app_access` is on, which the operator confirmed extends to branches. Matching stays exact with no wildcards; the four "families" are the entries already in `callingSortOrder.ts`, not a prefix rule. What remains open is the implementation shape: `AppAccessOptions` needs a `unitType`, and `syncApplyFix.ts` calls `filterAppAccessCallings` at `:302`, before the ward doc is read at `:311`, under a read that is itself conditional — plus three sibling call sites with no ward read at all.
- **B-20 — `Maple` and `Maple Ward` could both be created. Fixed in this PR**, by `unitNameCollision.ts` above. Listed here because it was found while documenting the PR, not carried out of it.
- **B-21 — a lone ward in a place named "…Branch" is silently classified as a branch.** The field hint stops short of the `Olive Branch` / `Olive Branch Ward` case, an accepted operator call to keep it short, and the collision guard does **not** compensate: it needs two units to compare, so it only covers the stake holding both. The single-unit case — the stake's only unit there is a ward, the operator types `Olive Branch`, nothing collides — stores a branch, and the provisioner's strict `!==` then rewrites the church-provisioned Description on every pass. Unmitigated by design for now.

## Doc edits

- `docs/architecture.md` — new **D31**, the unit-name → Kindoo scope-name contract.
- `docs/spec.md` — §3.2 wards bullet carries the contract; §5.3 gains the ward-form label + hint, the variant-set uniqueness rule, and the B-21 caveat naming what the guard does *not* cover; §9's email row label is no longer always `Ward`; §10 Step 3 states the variant rule against the pending list; §15's two "bare form + `" Ward"`-suffixed form" claims replaced with the variants rule.
- `docs/firebase-schema.md` — §4.2: `ward_name` field comment, the contract table, and the doc-ID note that the slug is not normalised.
- `docs/TASKS.md` — new **T-96**; T-88's own-ward-collision claim amended.
- `docs/BUGS.md` — **B-20**, filed and closed within this PR; new **B-21**.
- `docs/user-guide/kindoo-managers.html` — §2 gains a "Naming a ward or a branch" callout.
- `packages/shared/src/types/ward.ts` — the `ward_name` docstring, which said "Display name (`"3rd Ward"`, etc.)" and contradicted the extension.
- `packages/shared/CLAUDE.md` — the unit-name rule named alongside the other shared predicates.
- `extension/docs/sync-design.md` — the parser's scope resolution was documented as "exact match against any `ward.ward_name`"; it has registered dual keys for longer than that line has been accurate.
- `extension/docs/v2-design.md` — the v2.2 Description merge spec now says where `scopeName` comes from.
