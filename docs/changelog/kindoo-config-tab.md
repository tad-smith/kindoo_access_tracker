# Kindoo Config tab — Home Kindoo Site, section renames, Sync pre-filter

**Shipped:** 2026-08-08
**Commits:** `feat/kindoo-config-tab` (T-90)

Follow-ups to T-88 (`kindoo-ignored-wards.md`), plus the two items PR #261's review filed as non-blocking.

## What shipped

**Configuration → Kindoo Config** (was "Kindoo Sites"), now three stacked sections:

1. **Home Kindoo Site** — new. Shows the stake's own Kindoo environment; superadmin-editable.
2. **Foreign Kindoo Sites** — the existing list, renamed from "Kindoo Sites" (button: "Add Foreign Kindoo Site").
3. **Wards to Ignore in Kindoo** — moved from an inline text field to the same header-button + dialog pattern as the other two.

The tab **key** stays `kindoo-sites`. It is in the URL (`?tab=…`), so renaming it would break every existing deep link for no visible gain.

## Home Kindoo Site

The home site has no `KindooSite` doc — it lives on the parent stake doc — so it had no UI at all: `stake.kindoo_config` was written only by the extension's configure wizard, and `stake.kindoo_expected_site_name` had **no writer anywhere**.

- **Site name** shows `kindoo_expected_site_name`, falling back to `stake_name` and labelling the row as defaulted when it does — the same fallback `parseDescription` and the wizard's home-by-name resolution apply, so the row shows the string those actually compare against rather than an empty field. Saving writes **only** that field: `kindoo_config.site_name` is Kindoo's own captured display name and is preserved (see "Caught in review"). The override is also left unset when the entered name still equals `stake_name` and none existed, so an EID-only edit doesn't freeze today's stake name into stored state a later rename would strand.
- **Kindoo EID** shows `kindoo_config.site_id`, or `Not set`. Refused when it collides with a configured foreign `kindoo_eid` — the mirror of the guard the extension's `writeKindooConfig` already applies.
- **Superadmin-only editing** in the UI; the rules still let any manager write these fields as part of an ordinary stake update, so the gate is "the SPA offers this control to superadmins," not enforcement.
- **The rules gate admits superadmins** so the control is reachable without a per-stake role: `isManager || isBootstrapAdmin || (isPlatformSuperadmin && setup_complete and bootstrap_admin_email unchanged)`. Those pins matter — see below.
- **Reaching the page.** `/manager/configuration` admits `manager || platformSuperadmin` and shows the whole tab set; sub-collection writes stay gated on `isManager`, so a superadmin browsing the other tabs sees them and an unentitled write fails at the rules layer. A zero-role superadmin has no active stake of their own and only the **URL** tier of `resolveActiveStake` is superadmin-permissive, so the Stake List's new per-row **Kindoo Config** deep-link is the entry point rather than a convenience.

This breaks a real deadlock, which is what prompted it: `resolveEidStakes` matches an active EID only against stakes that **already record it**, so a stake whose home site has never been configured is never a candidate and cannot be reached from the panel in order to configure it. Worse, when a sibling stake already carries that environment as a *foreign* site, the EID resolves to exactly one candidate and the panel auto-picks the sibling — no picker, no override. Setting the home EID here makes the stranded stake a second candidate, which surfaces the picker.

## Sync pre-filter (review follow-up)

The ignore-list drop ran inside `detect`, which is after Phase C — so every ignored member still cost one `getUserDoorGrants` round-trip per Sync run. In the motivating case that is a neighbouring stake's entire membership billed to our Kindoo call budget for a result we discard.

Split into Phase B.5, ahead of enrichment. The ignored users are still handed to `detect` un-enriched, which costs nothing (it drops them before reading `derivedBuildings`), so its pass stays the backstop and `ignoredCount` keeps coming from one place.

## `(` guard (review follow-up)

Matching is on a description's scope-name portion, so pasting `Aspen Grove Ward (Bishop)` produced an entry matching nothing, with no feedback. Now refused, alongside the duplicate and own-ward rules. All three moved into the dialog's zod schema — two of them close over live catalogues, so it's a factory (`makeIgnoredWardSchema`) rebuilt when the ignore list or wards snapshot changes, validating on change so the operator learns before submitting.

## Implementation note

The EID field carries **no `min` attribute**. Native constraint validation suppresses the submit event outright, so React never sees it and the zod message can never render — the bound silently became browser-enforced instead of app-enforced. Found by instrumenting `handleSubmit` after a test expecting the zod message got no error at all. Zod owns the bound.

## Caught in review

Three defects, all in code this branch introduced.

**The superadmin rules branch was an escalation path.** Unscoped, it also handed a superadmin `setup_complete` + `bootstrap_admin_email` on any *existing* stake. `isBootstrapAdmin` is exactly those two fields, so: write them → the bootstrap hatch re-opens → `kindooManagers` create is allowed → `syncManagersClaims` mints a real manager claim over that stake's seats, requests and members. Flipping `setup_complete` alone also routes every user of the stake to SetupInProgress. The commit shipping it claimed this was "not a new tier of authority"; that was wrong — before it, a superadmin's only rules write was `create` on a *new* stake doc, which cannot reach existing data. Both fields are now pinned on that branch, with tests for the two escalation attempts and one proving the pin didn't narrow the manager path the wizard's own flip uses.

**An EID-only edit clobbered `kindoo_config.site_name`.** That field is Kindoo's own display name, captured by the wizard from the live session; `homeSiteName()` prefers it precisely because it's what a manager sees in the tab they're being told to open. The form's name field edits `kindoo_expected_site_name`, a different value — so saving wrote the wrong string over the capture and the Requests Queue then named the wrong thing. Now preserved, seeded only when the map is created.

**No home/foreign EID collision guard.** `identifyActiveSite` tests home first, so a home `site_id` equal to a configured foreign `kindoo_eid` reclassifies that foreign site as home for all of Sync and waves home-ward requests onto the foreign environment through the Phase 3 guard. The extension refuses this exact write; the hand-entry form didn't.

One correction to this document's own earlier reasoning: `kindoo_config` is written by **dotted path**, and the justification originally given for writing it whole was wrong on its own terms — `validKindooConfig` reads `request.resource.data`, the *merged* result, so a dotted write satisfies it equally. The real reason to use dotted paths is that a whole-map literal drops keys, which is what made the clobber above possible.

## Spec / doc edits

- `docs/spec.md` — §244 tab list; §15 new "Home Kindoo Site surface" subsection; ignore-list guards; Phase B.5 pre-filter.
- `docs/firebase-schema.md` — §4.1 "Written by" now names the superadmin path and the wizard.
- `docs/TASKS.md` — T-90 (T-89 was taken by PR #260 on main while this branch was open).
- User-facing "Configuration → Kindoo Sites" strings updated to "Kindoo Config" across the extension panel (`App`, `ConfigurePanel`, `SyncPanel`).
