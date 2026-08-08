# Kindoo Config tab — Home Kindoo Site, section renames, Sync pre-filter

**Shipped:** 2026-08-08
**Commits:** `feat/kindoo-config-tab` (T-89)

Follow-ups to T-88 (`kindoo-ignored-wards.md`), plus the two items PR #261's review filed as non-blocking.

## What shipped

**Configuration → Kindoo Config** (was "Kindoo Sites"), now three stacked sections:

1. **Home Kindoo Site** — new. Shows the stake's own Kindoo environment; superadmin-editable.
2. **Foreign Kindoo Sites** — the existing list, renamed from "Kindoo Sites" (button: "Add Foreign Kindoo Site").
3. **Wards to Ignore in Kindoo** — moved from an inline text field to the same header-button + dialog pattern as the other two.

The tab **key** stays `kindoo-sites`. It is in the URL (`?tab=…`), so renaming it would break every existing deep link for no visible gain.

## Home Kindoo Site

The home site has no `KindooSite` doc — it lives on the parent stake doc — so it had no UI at all: `stake.kindoo_config` was written only by the extension's configure wizard, and `stake.kindoo_expected_site_name` had **no writer anywhere**.

- **Site name** shows `kindoo_expected_site_name`, falling back to `stake_name` and labelling the row as defaulted when it does — the same fallback `parseDescription` and the wizard's home-by-name resolution apply, so the row shows the string those actually compare against rather than an empty field. Saving writes both it and `kindoo_config.site_name`, so the wizard's capture doesn't go stale beside a new name.
- **Kindoo EID** shows `kindoo_config.site_id`, or `Not set`.
- **Superadmin-only editing.** The value is discovered automatically in the ordinary case and a wrong EID silently points every Kindoo operation at another environment. Note the rules gate is unchanged and narrower — `stakes/{stakeId}` update still requires `isManager(stakeId)` — so the editor must be a manager *and* a superadmin. No rules change; a superadmin who manages no stakes cannot use this.
- **`kindoo_config` is written whole.** `validKindooConfig` checks all four keys against the merged result on every stake-doc update, so a partial write would deny every subsequent client write to the doc, the Config tab included.

This also breaks a real deadlock, which is what prompted it: the extension resolves an active EID to a stake only among stakes that **already record that EID**, so a stake whose home site has never been configured cannot be reached from the panel in order to configure it — and when a sibling stake carries the same environment as a *foreign* site, the panel silently resolves to the sibling with no picker and no override. Setting the home EID here makes the stake a candidate, which is what surfaces the picker.

## Sync pre-filter (review follow-up)

The ignore-list drop ran inside `detect`, which is after Phase C — so every ignored member still cost one `getUserDoorGrants` round-trip per Sync run. In the motivating case that is a neighbouring stake's entire membership billed to our Kindoo call budget for a result we discard.

Split into Phase B.5, ahead of enrichment. The ignored users are still handed to `detect` un-enriched, which costs nothing (it drops them before reading `derivedBuildings`), so its pass stays the backstop and `ignoredCount` keeps coming from one place.

## `(` guard (review follow-up)

Matching is on a description's scope-name portion, so pasting `Aspen Grove Ward (Bishop)` produced an entry matching nothing, with no feedback. Now refused, alongside the duplicate and own-ward rules. All three moved into the dialog's zod schema — two of them close over live catalogues, so it's a factory (`makeIgnoredWardSchema`) rebuilt when the ignore list or wards snapshot changes, validating on change so the operator learns before submitting.

## Implementation note

The EID field carries **no `min` attribute**. Native constraint validation suppresses the submit event outright, so React never sees it and the zod message can never render — the bound silently became browser-enforced instead of app-enforced. Found by instrumenting `handleSubmit` after a test expecting the zod message got no error at all. Zod owns the bound.

## Spec / doc edits

- `docs/spec.md` — §244 tab list; §15 new "Home Kindoo Site surface" subsection; ignore-list guards; Phase B.5 pre-filter.
- `docs/firebase-schema.md` — §4.1 "Written by" now names the superadmin path and the wizard.
- `docs/TASKS.md` — T-89.
- User-facing "Configuration → Kindoo Sites" strings updated to "Kindoo Config" across the extension panel (`App`, `ConfigurePanel`, `SyncPanel`).
