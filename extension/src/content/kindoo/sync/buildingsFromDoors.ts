// Auto-user buildings derivation. Bridges Kindoo's per-door grant data
// (which covers BOTH Church Access Automation's direct door grants AND
// AccessRule-derived grants) into SBA's building model.
//
// The bulk listing's `AccessSchedules` array misses direct door grants
// (~310 of 313 csnorth users in production), so we can't derive
// auto-user buildings from it. This module fills the gap:
//
//   per-rule doors  ─┐
//                    ├─► any-overlap → claimed rule ids → buildings
//   per-user doors  ─┘
//
// ONE rule predicate, applied to two door subsets. **A member is in a
// building if they can open ANY of its doors** — a door they can open is
// a way in, and holding two of three is not two-thirds of a building
// (B-25). So `deriveOverlappingRuleIds` claims a rule on a single shared
// door, and both sets below use it. What differs is which doors go in:
//   - `derivedBuildings` — over ALL of the user's doors (church-direct +
//     rule-derived). Where the member can go. Drives
//     `buildings-mismatch` and is the source `applyKindooOnly` writes a
//     new seat's `building_names` from.
//   - `directGrantBuildings` — over only the doors held via a grant from
//     the Church Access Automation (`churchGranted` rows). Who
//     provisions the member. Drives the seat-type decision.
//
// `deriveEffectiveRuleIds` (strict subset — EVERY door) is a different
// question and has one remaining caller: `provision.ts`, deciding
// whether writing an AccessRule would be redundant. Nothing in Sync
// should use it; see B-25 for what happens when access is read that way.
//
// `buildRuleDoorMap` + `getUserDoorGrants` do the I/O;
// `deriveOverlappingRuleIds` + `derivedBuildingNames` are pure and
// test-friendly.

import type { Building } from '@kindoo/shared';
import type { KindooSession } from '../auth';
import {
  getEnvironmentRuleWithEntryPoints,
  getUserAccessRulesWithEntryPoints,
  type KindooEnvironmentUser,
} from '../endpoints';

/**
 * Build a map from RuleID → Set<DoorID> for the given rule list. Calls
 * `getEnvironmentRuleWithEntryPoints` once per rule.
 *
 * Network cost: N rule calls (csnorth has 4 — cheap). Run once per
 * sync session; the result is stable for the duration of that sync.
 */
export async function buildRuleDoorMap(
  session: KindooSession,
  eid: number,
  ruleIds: number[],
  fetchImpl?: typeof fetch,
): Promise<Map<number, Set<number>>> {
  const map = new Map<number, Set<number>>();
  for (const ruleId of ruleIds) {
    const rule = await getEnvironmentRuleWithEntryPoints(session, ruleId, eid, fetchImpl);
    map.set(ruleId, new Set(rule.selectedDoorIds));
  }
  return map;
}

/**
 * Fetch the full set of DoorIDs a Kindoo user can open. Includes both
 * rule-derived grants AND Church Access Automation grants — every door
 * regardless of grantor.
 */
export async function getUserDoorIds(
  session: KindooSession,
  userId: string,
  eid: number,
  fetchImpl?: typeof fetch,
): Promise<Set<number>> {
  const { rows } = await getUserAccessRulesWithEntryPoints(session, userId, eid, fetchImpl);
  return new Set(rows.map((r) => r.doorId));
}

/**
 * Partition a user's door-grant rows into two door sets in a SINGLE
 * fetch:
 *   - `all` — every DoorID the user can open (church + rule-derived).
 *   - `direct` — only the DoorIDs the user holds via a grant from the
 *     Church Access Automation (`churchGranted` rows).
 *
 * Rows are one-per-door (collapsed church-preferring), so a door
 * granted by both a rule AND the church lands in `all` (always) and in
 * `direct` (its collapsed row is `churchGranted`). The enrichment
 * worker uses `all` for `derivedBuildings` and `direct` for
 * `directGrantBuildings` (the grant-based seat-type decision).
 */
export async function getUserDoorGrants(
  session: KindooSession,
  userId: string,
  eid: number,
  fetchImpl?: typeof fetch,
): Promise<{ all: Set<number>; direct: Set<number> }> {
  const { rows } = await getUserAccessRulesWithEntryPoints(session, userId, eid, fetchImpl);
  const all = new Set<number>();
  const direct = new Set<number>();
  for (const r of rows) {
    all.add(r.doorId);
    if (r.churchGranted) direct.add(r.doorId);
  }
  return { all, direct };
}

/**
 * Strict-subset derivation: returns the set of RuleIDs the user has
 * effective access to. A rule is "effectively held" iff EVERY door in
 * the rule's door set is present in the user's door set. Partial
 * overlap does not claim the rule.
 *
 * Empty rule door sets are NEVER claimed — `every` on an empty array
 * returns true, which would falsely claim every "empty" rule. Guard
 * explicitly.
 *
 * Pure function — no I/O.
 */
export function deriveEffectiveRuleIds(
  userDoorIds: Set<number>,
  ruleDoorMap: Map<number, Set<number>>,
): Set<number> {
  const out = new Set<number>();
  for (const [ruleId, doorIds] of ruleDoorMap) {
    if (doorIds.size === 0) continue;
    let allPresent = true;
    for (const did of doorIds) {
      if (!userDoorIds.has(did)) {
        allPresent = false;
        break;
      }
    }
    if (allPresent) out.add(ruleId);
  }
  return out;
}

/**
 * Returns the set of RuleIDs whose door set the user's doors TOUCH — at
 * least one door in common. The predicate BOTH Sync derivations use.
 *
 * A member is in a building if they can open any of its doors. One door
 * is a way in; there is no partial entry. A rule's door set is the
 * building's doors, so sharing one of them means the member gets inside.
 *
 * Reading that as a strict subset was B-25, and it was wrong twice over.
 * The Church Access Automation does not reliably reach every door of a
 * rule — it granted a production ward's members two of three and missed
 * the third, which a Kindoo Manager then granted by hand:
 *   - Over the church-only doors, no rule was claimed, so
 *     `directGrantBuildings` came back `[]` — the value a member the
 *     church grants NOTHING produces. Their seats read `manual`, and
 *     the ones already `auto` were offered up for demotion.
 *   - Over all doors, a member holding some of a building's doors
 *     claimed nothing either, so `derivedBuildings` omitted a building
 *     they can walk into — and `buildings-mismatch` sources its Update
 *     SBA from that set, so the offered fix was to strip the building
 *     off their seat.
 *
 * Over-claim is possible where two rules share a door: one grant on the
 * shared door names both buildings. Physical doors belong to one
 * building, so this needs a rule that selects another building's door —
 * a mapping error, and one this surfaces rather than hides.
 *
 * Empty rule door sets are NEVER claimed, matching
 * `deriveEffectiveRuleIds`.
 *
 * Pure function — no I/O.
 */
export function deriveOverlappingRuleIds(
  userDoorIds: Set<number>,
  ruleDoorMap: Map<number, Set<number>>,
): Set<number> {
  const out = new Set<number>();
  for (const [ruleId, doorIds] of ruleDoorMap) {
    for (const did of doorIds) {
      if (userDoorIds.has(did)) {
        out.add(ruleId);
        break;
      }
    }
  }
  return out;
}

/**
 * Map effective RuleIDs to SBA building names via
 * `building.kindoo_rule.rule_id`. Buildings whose `kindoo_rule.rule_id`
 * is not in `effectiveRuleIds` are excluded.
 *
 * Returns a deduplicated, alphabetically-sorted array — matches the
 * existing SBA convention for `building_names`.
 */
export function derivedBuildingNames(
  effectiveRuleIds: Set<number>,
  buildings: Building[],
): string[] {
  const out = new Set<string>();
  for (const b of buildings) {
    const ruleId = b.kindoo_rule?.rule_id;
    if (typeof ruleId !== 'number') continue;
    if (effectiveRuleIds.has(ruleId)) out.add(b.building_name);
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

/**
 * Enrich every Kindoo env-user with `derivedBuildings` AND
 * `directGrantBuildings`, both computed from a SINGLE per-user door
 * fetch. Walks the user list with a small concurrency limit so wall
 * time stays tolerable for 313-user sync runs without hammering
 * Kindoo's API.
 *
 *   - `derivedBuildings` — over the user's full door set (church-direct
 *     + rule-derived). Where the member can go.
 *   - `directGrantBuildings` — over the church-granted subset only. Who
 *     provisions them; drives promote / demote.
 *
 * Same predicate for both (`deriveOverlappingRuleIds` — any door claims
 * the building); only the door subset differs.
 *
 * On per-user error: log with the `[sba-ext]` prefix, set BOTH fields
 * to `null`, continue. One user's network blip never fails the whole
 * sync, and a partial fetch must not produce a half-populated
 * (and therefore misclassified) result.
 *
 * `onProgress` fires as users complete; the panel uses it to update
 * "Reading Kindoo user N of M…" text. Throttle in the caller — every
 * user firing a React state update for a 313-user run thrashes the
 * reconciler.
 */
export async function enrichUsersWithDerivedBuildings(
  session: KindooSession,
  eid: number,
  users: KindooEnvironmentUser[],
  ruleDoorMap: Map<number, Set<number>>,
  buildings: Building[],
  options: {
    concurrency?: number;
    onProgress?: (completed: number, total: number) => void;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<KindooEnvironmentUser[]> {
  const concurrency = options.concurrency ?? 4;
  const total = users.length;
  let completed = 0;
  let nextIndex = 0;
  const enriched: KindooEnvironmentUser[] = users.map((u) => ({ ...u }));

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= total) return;
      const user = enriched[i]!;
      try {
        // Fetch rows once; derive both the all-doors and direct-only
        // building sets so the seat-type decision and the effective-
        // access check share a single network round-trip.
        const { all, direct } = await getUserDoorGrants(
          session,
          user.userId,
          eid,
          options.fetchImpl,
        );
        user.derivedBuildings = derivedBuildingNames(
          deriveOverlappingRuleIds(all, ruleDoorMap),
          buildings,
        );
        user.directGrantBuildings = derivedBuildingNames(
          deriveOverlappingRuleIds(direct, ruleDoorMap),
          buildings,
        );
      } catch (err) {
        console.log(
          `[sba-ext] enrichUsersWithDerivedBuildings: ${user.username} failed; falling back to null. ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        user.derivedBuildings = null;
        user.directGrantBuildings = null;
      }
      completed += 1;
      options.onProgress?.(completed, total);
    }
  }

  if (total === 0) return enriched;
  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  await Promise.all(workers);
  return enriched;
}
