# Organizations for the Stake scope

**Shipped:** 2026-06-06
**Commits:** PR #224 (`feat/stake-organizations`); architecture decision D21.

## What shipped

Stake managers can now group stake-scope seats into named **organizations** — pools with their own (display-only) seat caps, tracked alongside wards / buildings. A new `stakes/{stakeId}/organizations/{orgId}` collection holds them; a new Configuration → **Organizations** tab (last, right of Wards) manages them; seats and stake-scope requests gain an optional `organization_id` slug FK; the request forms gain an optional stake-scope org selector; and the **Stake Roster** gains an inline org chip plus per-organization utilization bars. Meaningful only at stake scope — `null` / absent everywhere = "No Organization."

## What it does

- **Collection.** `organizations/{orgId}` = `{ organization_id (= doc.id, immutable `buildingSlug(name)`), name, seat_cap, created_at, last_modified_at, lastActor }`. Manager CRUD over `name` + `seat_cap`; the slug is derived once at create and **never re-slugged** on edit. Two client-side guards: unique display name (case-insensitive, trimmed) and a delete guard blocking removal while any seat references the org (primary `organization_id` OR any `duplicate_grants[].organization_id`). No rename ref-guard — seats reference the slug, not the name.
- **Seats & requests.** Optional `organization_id` on `Seat` (primary grant) + each `DuplicateGrant`, and on `AccessRequest`. Stake-scope only; ward / `remove` / `edit_auto` never carry one.
- **Request forms.** Org selector on stake-scope `add_manual` / `add_temp` / `edit_manual` / `edit_temp` (NewRequestForm + EditSeatDialog), default "No Organization." `markRequestComplete` carries the value onto the seat (new-seat primary, the stake-grant slot in the auto-merge path, the resolved edit slot); `null` clears.
- **Stake Roster.** Each card's top line shows an org chip ("{name}" / "No Organization") with a dropdown affordance. Selecting an org writes the seat immediately — a direct client write, the **only** client seat-update path. Editable by anyone with stake app access (`stakes[stakeId].stake == true`), targeting the **primary stake grant** only; a parallel-site stake *duplicate* grant's chip is read-only (org set via the request form). Below the stake bar — relabelled **"Stake Total"** — one committed bar per organization (label "{name}"); the org cap drives ok / warn ≥90% / over but never blocks.
- **Rules.** `organizations` — read `isAnyMember`, create/update/delete `isManager` + `lastActorMatchesAuth`. New `seats` `allow update`: `isStakeMember(stakeId) && resource.data.scope == 'stake' && diff().affectedKeys().hasOnly(['organization_id','last_modified_at','last_modified_by','lastActor']) && lastActorMatchesAuth`.
- **Audit.** `auditOrganizationWrites` fans rows as `entity_type='stake'`, `entity_id='organization:<slug>'`; `reconcileAuditGaps` includes the collection; inline seat org edits audit as `update_seat`. No new composite index.

## Why

Two decisions are load-bearing, both recorded as **D21**.

**Slug reference, not name-snapshot.** The pre-existing building-grant arrays (`seat.building_names` / `request.building_names`) key cross-references on display names, which is exactly the cascade hazard D18's building-rename block and delete-guard exist to contain. Organizations were a fresh collection with no legacy baggage, so they key on the immutable slug from day one and resolve slug → name at render time. Renaming an org is therefore a single-doc write that orphans nothing and needs no rename-time ref-guard — only a unique-name guard and a delete ref-guard. This applies D18's lesson to a brand-new reference rather than retrofitting it.

**Inline org edit as a direct client seat-write.** Organizations are bookkeeping over an already-granted stake seat, not an access change. Routing a re-org through the submit → approve → complete pipeline would be ceremony with no approval value, and the roster is where a stake member already reasons about which org a seat belongs to. The risk of opening a client `seats.update` path is field-escalation; the `hasOnly` 4-key allowlist plus `scope == 'stake'` scoping reduces the writable surface to precisely the org field, so the path can't be used to mutate access-bearing fields. Alternatives ruled out: an `edit_org` request type (pipeline ceremony for a non-access field), a server callable (a round-trip for a single-field write the rules gate directly), and snapshotting the org name onto the seat (reintroduces the rename cascade).

## What didn't change that you'd expect to

- **All Seats stays view-only for edits.** The org chip lives only on the Stake Roster (the org concept is stake-scope); ward / bishopric surfaces reuse `PerGrantRosterCard` and pass no org prop, so they render no chip. All Seats grows no edit affordance — the inline org write is roster-only.
- **No org over-cap enforcement.** The org `seat_cap` is display-only on the per-org bars. Unlike the stake/ward caps, it never blocks a write — organizations are a grouping, not a hard pool.
- **`markRequestComplete` over-cap recompute is unchanged.** Org carry rides existing add/edit write paths; an org-only change is the sole update on a stake-scope merge, tested by key presence (the value can be `null`), but it does not alter per-pool counts, so the callable's existing recompute split with `removeSeatOnRequestComplete` is untouched.
- **§4.8 / §4.9 stay tombstoned.** The new collection takes the next free number, §4.12, leaving the removed calling-template slots' numbering stable for existing cross-references.

## Deferred (intentional v1 scope, not defects)

- **Per-organization PENDING utilization bars.** The per-org bars are committed-only; pending adds/removes are not split per org. → T-71.
- **Inline org editing for parallel-site stake DUPLICATE grants.** The chip edits only the primary stake grant; a parallel-site stake duplicate's org is set through the request form. → T-71.

## Spec / doc edits

- `docs/spec.md` — §3.2 (organizations collection; `organization_id` on the seats / requests bullets); §5.1 (org selector in the New Request fields list); §5.2 (Stake Roster org chip + inline direct-write + who-can-edit + per-org bars + "Stake Total"); §5.3 (Organizations Configuration tab, last; slug-immutable, unique-name + delete guards, no rename guard); §6 (org carry on completion; the inline-org-edit direct-write exception); §6.1 (org on `edit_manual` / `edit_temp`); §8 (`applyScopeMismatch` clears org off-stake; other Sync paths preserve it).
- `docs/firebase-schema.md` — new §4.12 organizations; §4.6 seat (`organization_id` on primary + duplicate, Written-by direct-write note); §4.7 request `organization_id`; §4.10 sub-entity-audit list + structured entity_id; §5 (no index); §6 (organizations match block + seats `allow update` clause); §7 (organizations function deltas).
- `docs/architecture.md` — D21 added (slug reference + direct client seat-write).
- `docs/TASKS.md` — T-71 added (the two intentional v1 deferrals).
