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
- **Edit requires superadmin AND manager of the stake.** The superadmin half is the intent; the manager half is what the write needs, since the rules are unchanged. Gating on the claim alone rendered a button whose save died on `permission-denied` — caught in the final review round, and reachable precisely because this PR retargets the Stake List link here.
- **The Stake List's stake-name link now targets Configuration** instead of the manager Dashboard — a superadmin opening someone else's stake wants its settings, not its request queue. Both routes already admitted a superadmin, so this is usefulness, not access.

**The superadmin-without-a-manager-role case is deliberately not in this PR** — see "Held back" below.

This breaks a real deadlock, which is what prompted it: `resolveEidStakes` matches an active EID only against stakes that **already record it**, so a stake whose home site has never been configured is never a candidate and cannot be reached from the panel in order to configure it. Worse, when a sibling stake already carries that environment as a *foreign* site, the EID resolves to exactly one candidate and the panel auto-picks the sibling — no picker, no override. Setting the home EID here makes the stranded stake a second candidate, which surfaces the picker.

## Sync pre-filter (review follow-up)

The ignore-list drop ran inside `detect`, which is after Phase C — so every ignored member still cost one `getUserDoorGrants` round-trip per Sync run. In the motivating case that is a neighbouring stake's entire membership billed to our Kindoo call budget for a result we discard.

Split into Phase B.5, ahead of enrichment. The ignored users are still handed to `detect` un-enriched, which costs nothing (it drops them before reading `derivedBuildings`), so its pass stays the backstop and `ignoredCount` keeps coming from one place.

## `(` guard (review follow-up)

Matching is on a description's scope-name portion, so pasting `Aspen Grove Ward (Bishop)` produced an entry matching nothing, with no feedback. Now refused, alongside the duplicate and own-ward rules. All three moved into the dialog's zod schema — two of them close over live catalogues, so it's a factory (`makeIgnoredWardSchema`) rebuilt when the ignore list or wards snapshot changes, validating on change so the operator learns before submitting.

## Implementation note

The EID field carries **no `min` attribute**. Native constraint validation suppresses the submit event outright, so React never sees it and the zod message can never render — the bound silently became browser-enforced instead of app-enforced. Found by instrumenting `handleSubmit` after a test expecting the zod message got no error at all. Zod owns the bound.

## Held back: the superadmin-without-a-manager-role path (T-91)

Attempted in this branch and removed before merge, because it never worked end to end and each layer only revealed the next.

The rules widening came first, unscoped, and review caught it as a **privilege-escalation path**: it also handed a superadmin `setup_complete` + `bootstrap_admin_email` on any *existing* stake. `isBootstrapAdmin` is exactly those two fields, so: write them → the bootstrap hatch re-opens → `kindooManagers` create is allowed → `syncManagersClaims` mints a real manager claim over that stake's seats, requests and members. Flipping `setup_complete` alone also routes every user of the stake to SetupInProgress. The commit shipping it claimed this was "not a new tier of authority"; that was wrong — before it, a superadmin's only rules write was `create` on a *new* stake doc, which cannot reach existing data. Pinning both fields fixes it, and that shape is what T-91 should carry.

Then the feature still didn't work, and two more layers surfaced:

- **Five sub-collection reads are `isAnyMember`-gated** (`wards`, `buildings`, `kindooManagers`, `kindooSites`, `organizations`). The Home Kindoo Site save reads `kindooSites` for its collision guard, so it died on `permission-denied` before writing — for the exact persona the surface exists for. Widening exactly those five (and *not* seats or requests, which carry member names and emails) is the agreed shape.
- **No active stake resolves at all** for a superadmin holding no role. An E2E for the persona showed the page rendering with `?stake=` consumed and stripped, no console errors, and every read simply never fired. Rules were necessary and insufficient.

Two of my own justifications turned out false along the way, and both are worth not re-deriving: `useRequireRole('manager')` was never the blocker (`holdsAnyRole` short-circuits on `isPlatformSuperadmin`), and the Dashboard therefore never "bounced a superadmin out" — the Stake List link failed on its data reads, not its role gate.

## Caught in review

Two more defects, both in code this branch keeps.

**An EID-only edit clobbered `kindoo_config.site_name`.** That field is Kindoo's own display name, captured by the wizard from the live session; `homeSiteName()` prefers it precisely because it's what a manager sees in the tab they're being told to open. The form's name field edits `kindoo_expected_site_name`, a different value — so saving wrote the wrong string over the capture and the Requests Queue then named the wrong thing. Now preserved, seeded only when the map is created.

**No home/foreign EID collision guard.** `identifyActiveSite` tests home first, so a home `site_id` equal to a configured foreign `kindoo_eid` reclassifies that foreign site as home for all of Sync and waves home-ward requests onto the foreign environment through the Phase 3 guard. The extension refuses this exact write; the hand-entry form didn't.

One correction to this document's own earlier reasoning: `kindoo_config` is written by **dotted path**, and the justification originally given for writing it whole was wrong on its own terms — `validKindooConfig` reads `request.resource.data`, the *merged* result, so a dotted write satisfies it equally. The real reason to use dotted paths is that a whole-map literal drops keys, which is what made the clobber above possible.

## Spec / doc edits

- `docs/spec.md` — §244 tab list; §15 new "Home Kindoo Site surface" subsection; ignore-list guards; Phase B.5 pre-filter.
- `docs/firebase-schema.md` — §4.1 "Written by" now names the superadmin path and the wizard.
- `docs/TASKS.md` — T-90 (T-89 was taken by PR #260 on main while this branch was open).
- User-facing "Configuration → Kindoo Sites" strings updated to "Kindoo Config" across the extension panel (`App`, `ConfigurePanel`, `SyncPanel`).
