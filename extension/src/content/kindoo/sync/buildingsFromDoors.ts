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
// Two building sets (plus a footprint flag) come out of the same
// per-user door fetch:
//   - `derivedBuildings` — strict-subset over ALL of the user's doors
//     (direct + rule-derived). The authoritative effective-access set.
//   - `directGrantBuildings` — strict-subset over only the doors held
//     via a Church Access Automation DIRECT grant (`accessScheduleId
//     === 0`). Drives the grant-based seat-type decision: a seat is
//     church-backed iff every one of its buildings is direct-granted.
//   - `hasNoDoorFootprint` — `true` when the fetch returned zero door
//     rows of any kind. Keyed off the raw total door set, not the
//     derived buildings (a user can hold doors that map to no SBA
//     building, yielding empty `derivedBuildings` yet a real footprint).
//     The detector skips grant-based reconciliation for these users.
//
// `buildRuleDoorMap` + `getUserDoorGrants` do the I/O;
// `deriveEffectiveRuleIds` + `derivedBuildingNames` are pure and
// test-friendly and run twice (once per door subset).

import type { Building } from '@kindoo/shared';
import type { KindooSession } from '../auth';
import {
  getEnvironmentRuleWithEntryPoints,
  getUserAccessRulesWithEntryPoints,
  KINDOO_GUEST_ROLE,
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
 * Partition a user's door-grant rows into two door sets in a SINGLE
 * fetch:
 *   - `all` — every DoorID the user can open (direct + rule-derived).
 *   - `direct` — only the DoorIDs the user holds via a Church Access
 *     Automation **direct grant** (`accessScheduleId === 0` rows).
 *
 * Rows are one-per-(door, source), so a door granted by both a rule
 * AND a direct grant appears in both forms; it lands in `all` (always)
 * and in `direct` (because at least one of its rows is direct). The
 * enrichment worker uses `all` for `derivedBuildings` and `direct` for
 * `directGrantBuildings` (the grant-based seat-type decision).
 */
export async function getUserDoorGrants(
  session: KindooSession,
  userId: string,
  eid: number,
  fetchImpl?: typeof fetch,
): Promise<{ all: Set<number>; direct: Set<number> }> {
  const rows = await getUserAccessRulesWithEntryPoints(session, userId, eid, fetchImpl);
  const all = new Set<number>();
  const direct = new Set<number>();
  for (const r of rows) {
    all.add(r.doorId);
    if (r.accessScheduleId === 0) direct.add(r.doorId);
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
 *   - `derivedBuildings` — strict-subset over the user's full door set
 *     (direct + rule-derived). The effective-access signal.
 *   - `directGrantBuildings` — strict-subset over the user's
 *     direct-granted door subset only. The provenance signal that
 *     drives promote / demote.
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
 *
 * `skipDoorFetchForNonGuests` (default `false`): when `true`, the
 * per-user door fetch is ELIDED for any user whose `userRole` is a known
 * non-Guest (managers / admins hold no SBA door grants, and the detector
 * already skips grant-based reconciliation for them by role — so the
 * fetch would be wasted). Skipped users keep their (unset) door fields;
 * `onProgress` still ticks for them so the count stays truthful. Users
 * with an unknown role (lookup failed) are NEVER skipped — they still
 * need a door read for the footprint fallback. Off by default so
 * existing callers / tests that don't pass roles are unaffected.
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
    skipDoorFetchForNonGuests?: boolean;
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
      // Elide the door fetch for a KNOWN non-Guest when asked: managers /
      // admins hold no SBA door grants and the detector skips them by
      // role anyway, so the round-trip is pure waste. Unknown role
      // (undefined) is never skipped — it still needs the footprint
      // fallback. Leave the door fields unset; still tick progress.
      if (
        options.skipDoorFetchForNonGuests &&
        typeof user.userRole === 'number' &&
        user.userRole !== KINDOO_GUEST_ROLE
      ) {
        completed += 1;
        options.onProgress?.(completed, total);
        continue;
      }
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
          deriveEffectiveRuleIds(all, ruleDoorMap),
          buildings,
        );
        user.directGrantBuildings = derivedBuildingNames(
          deriveEffectiveRuleIds(direct, ruleDoorMap),
          buildings,
        );
        // No-footprint signal: the fetch SUCCEEDED and the user holds
        // zero doors of any kind. Keyed off the raw total door-row count
        // (`all`), NOT the derived building sets — a user with doors that
        // map to no SBA-tracked building still has a footprint even though
        // `derivedBuildings` would be `[]`. The detector uses this to skip
        // grant-based type / buildings reconciliation for Kindoo Managers
        // and other non-door-access accounts whose grant absence is not
        // "the church revoked this seat."
        user.hasNoDoorFootprint = all.size === 0;
      } catch (err) {
        console.log(
          `[sba-ext] enrichUsersWithDerivedBuildings: ${user.username} failed; falling back to null. ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        user.derivedBuildings = null;
        user.directGrantBuildings = null;
        // Fetch failed — we can't tell whether the user has a footprint.
        // Leave `hasNoDoorFootprint` unset (undefined → "has footprint"):
        // the `derivedBuildings === null` guards already skip grant-based
        // reconciliation on a failed fetch. `delete` rather than assign
        // `undefined` (exactOptionalPropertyTypes rejects the explicit
        // assignment), clearing any value a prior pass may have stamped.
        delete user.hasNoDoorFootprint;
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
