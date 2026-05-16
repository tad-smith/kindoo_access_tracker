// Auto-user buildings derivation. Bridges Kindoo's per-door grant data
// (which covers BOTH Church Access Automation's direct door grants AND
// AccessRule-derived grants) into SBA's building model.
//
// The bulk listing's `AccessSchedules` array misses direct door grants
// (~310 of 313 csnorth users in production), so we can't derive
// auto-user buildings from it. This module fills the gap:
//
//   per-rule doors  ─┐
//                    ├─► strict-subset → effective rule ids → buildings
//   per-user doors  ─┘
//
// A user is considered to "have" a rule iff EVERY DoorID in that rule's
// door set is present in the user's door set. Strict subset; partial
// overlap doesn't claim the rule.
//
// `buildRuleDoorMap` + `getUserDoorIds` do the I/O; `deriveEffectiveRuleIds`
// + `derivedBuildingNames` are pure and test-friendly.

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
 * rule-derived grants AND Church Access Automation direct grants
 * (`AccessScheduleID === 0` rows).
 */
export async function getUserDoorIds(
  session: KindooSession,
  userId: string,
  eid: number,
  fetchImpl?: typeof fetch,
): Promise<Set<number>> {
  const rows = await getUserAccessRulesWithEntryPoints(session, userId, eid, fetchImpl);
  return new Set(rows.map((r) => r.doorId));
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
 * Enrich every Kindoo env-user with a `derivedBuildings` field. Walks
 * the user list with a small concurrency limit so wall time stays
 * tolerable for 313-user sync runs without hammering Kindoo's API.
 *
 * On per-user error: log with the `[sba-ext]` prefix, set
 * `derivedBuildings = null`, continue. One user's network blip never
 * fails the whole sync.
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
        const userDoorIds = await getUserDoorIds(session, user.userId, eid, options.fetchImpl);
        const effectiveRuleIds = deriveEffectiveRuleIds(userDoorIds, ruleDoorMap);
        user.derivedBuildings = derivedBuildingNames(effectiveRuleIds, buildings);
      } catch (err) {
        console.log(
          `[sba-ext] enrichUsersWithDerivedBuildings: ${user.username} failed; falling back to null. ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        user.derivedBuildings = null;
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
