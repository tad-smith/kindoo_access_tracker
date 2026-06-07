# Hide the ward code; auto-derive it as an immutable slug

**Shipped:** 2026-06-07
**Commits:** PR #229 (branch `feat/ward-code-autoslug-hidden`)

## What shipped

`ward_code` stopped being a user-typed field. The ward create/edit form (both the manager Configuration → Wards tab and the bootstrap wizard) no longer has a "Ward code" input, list rows render `ward_name` only, and the edit dialog title is just "Edit ward". On create the code is derived once from `ward_name` via `buildingSlug()` (`'Maple Ward'` → `'maple-ward'`) and pinned as the immutable Firestore doc ID at `stakes/{stakeId}/wards/{wardCode}`; on edit the existing doc ID is carried through unchanged and never re-derived. Because the name is now the only visible ward identifier, ward display names are unique across the stake — a create or edit whose name collides (case-insensitive, trimmed) with another ward is rejected. Legacy wards keep their original 2-letter codes (e.g. `CO`) as immutable doc IDs; only their display changed.

## Why

The ward code was the last user-typed natural key in the UI. It forced operators to invent a short identifier and keep it unique by hand, and it leaked an internal Firestore doc ID into a form field. The code is already immutable — it *is* the doc ID, read-only on edit — so the only real work was to stop showing it and to generate it from the name. This is the same move D18 made for buildings (slug from `building_name`) and D21 made for organizations (slug from `name`), now applied to the last collection that still asked the operator to type the slug.

Duplicate display names had to be blocked the moment the name became the sole visible identifier. Without the guard a create whose name slugs to an existing ID would silently merge into that ward, and a new ward whose name matches a legacy 2-letter-coded ward would produce two wards indistinguishable in the UI. The guard keys on the **name**, not the derived slug, on purpose: a new "Maple" slugs to `maple`, which would not collide with a legacy "Maple" stored at doc ID `CO`, so a slug-only check would let the two coexist. The name comparison catches the legacy case the slug comparison misses. The create path additionally backstops in its `runTransaction` — if the derived doc ID already exists it throws rather than `merge`-ing into the existing doc — so two concurrent adds racing on the same name can't both pass the live-snapshot check.

Legacy 2-letter codes were deliberately **not** regenerated. Re-slugging an existing ward would rewrite its doc ID and orphan every seat, request, and access grant keyed on the old code by value. The display already renders `ward_name` everywhere a user sees a scope (§3.3), so the legacy codes were never visible anyway — regenerating them would be a destructive rewrite for a cosmetic gain.

## What didn't change (load-bearing non-changes)

- **No Firestore rules change.** `match /wards/{wardCode}` gates on role + `lastActor` with an unconstrained doc ID, so a hyphenated slug writes freely. The rules-test fixtures using `ward_code: 'CO'` still pass.
- **No Cloud Functions change.** `ward_code` is a foreign key **by value** in `seat.scope`, `request.scope`, and the `access.importer_callings` / `manual_grants` map keys — string equality, form-agnostic. `functions/src/lib/wardSites.ts` matches `scope === ward_code` regardless of whether the code is a slug or a legacy 2-letter string, so every server consumer is untouched.
- **The `Ward` type didn't change shape.** `ward_code` is still `string`; only its doc comment was rewritten. The persisted-doc validator (`packages/shared/src/schemas/ward.ts`) was widened from `^[A-Za-z0-9]+$` to `^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$` so a hyphenated slug validates while legacy uppercase codes still do.
- **`scopeLabel()`'s raw-code fallback was left in place.** It renders the raw scope string only for an orphaned grant whose ward no longer exists — an error fallback, not normal display.

## Spec / doc edits

- `docs/spec.md` — §3.2 ward doc bullet (code is auto-derived from `ward_name`, hidden, immutable; legacy codes retained); §3.3 ward-doc-ID convention (slug not user-typed; the Configuration → Wards admin screen now shows the name, so only the audit-log renderer keeps the raw code — was "two surfaces," now one); §5.3 Configuration bullet (no Ward code field; unique ward display names + the name-vs-slug rationale + transaction backstop; name-sorted list); §10 bootstrap Step 3 (no code field; inline + transaction dup guard).
- `docs/firebase-schema.md` — §4.2 Doc ID line + the `ward_code` / `ward_name` field comments (slug from `ward_name` at create, legacy codes retained, immutable; name unique).
- `docs/architecture.md` — D22 added, extending the D18 / D21 immutable-slug pattern to wards. D3's "2-char user-chosen" `ward_code` clause is retained as Apps Script-era history; D22 supersedes its live half.

## Deferred

None.
