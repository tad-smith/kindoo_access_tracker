// Tests for the door-grant → buildings derivation helpers.
// Pure-function tests exercise strict-subset semantics directly; the
// I/O wrappers mock the fetch boundary via the existing fetchImpl
// injection pattern.

import { describe, expect, it, vi } from 'vitest';
import type { Building } from '@kindoo/shared';
import type { KindooEnvironmentUser } from '../endpoints';
import {
  buildRuleDoorMap,
  derivedBuildingNames,
  deriveEffectiveRuleIds,
  enrichUsersWithDerivedBuildings,
  getUserDoorGrants,
  getUserDoorIds,
} from './buildingsFromDoors';

const SESSION = { token: 'sess', eid: 27994 };

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function building(name: string, ruleId: number | null): Building {
  const b: Partial<Building> = { building_id: name, building_name: name, address: '' };
  if (ruleId !== null) {
    b.kindoo_rule = { rule_id: ruleId, rule_name: `${name} Doors` };
  }
  return b as Building;
}

describe('deriveEffectiveRuleIds', () => {
  it('claims a rule when the user has ALL of its doors (strict equality)', () => {
    const userDoors = new Set([1, 2, 3]);
    const ruleMap = new Map<number, Set<number>>([[6248, new Set([1, 2, 3])]]);
    const out = deriveEffectiveRuleIds(userDoors, ruleMap);
    expect(out).toEqual(new Set([6248]));
  });

  it('claims a rule when the user has its doors PLUS extras (superset)', () => {
    const userDoors = new Set([1, 2, 3, 4, 5]);
    const ruleMap = new Map<number, Set<number>>([[6248, new Set([1, 2, 3])]]);
    const out = deriveEffectiveRuleIds(userDoors, ruleMap);
    expect(out).toEqual(new Set([6248]));
  });

  it('does NOT claim a rule when the user is missing one of its doors (partial)', () => {
    const userDoors = new Set([1, 2]); // missing door 3
    const ruleMap = new Map<number, Set<number>>([[6248, new Set([1, 2, 3])]]);
    const out = deriveEffectiveRuleIds(userDoors, ruleMap);
    expect(out).toEqual(new Set());
  });

  it('does NOT claim a rule when the user has none of its doors (disjoint)', () => {
    const userDoors = new Set([10, 20]);
    const ruleMap = new Map<number, Set<number>>([[6248, new Set([1, 2])]]);
    const out = deriveEffectiveRuleIds(userDoors, ruleMap);
    expect(out).toEqual(new Set());
  });

  it('does NOT claim a rule whose door set is empty (defensive — would otherwise vacuously match)', () => {
    const userDoors = new Set([1, 2, 3]);
    const ruleMap = new Map<number, Set<number>>([[6248, new Set()]]);
    const out = deriveEffectiveRuleIds(userDoors, ruleMap);
    expect(out).toEqual(new Set());
  });

  it('returns an empty set when the user has no door grants', () => {
    const userDoors = new Set<number>();
    const ruleMap = new Map<number, Set<number>>([[6248, new Set([1, 2])]]);
    const out = deriveEffectiveRuleIds(userDoors, ruleMap);
    expect(out).toEqual(new Set());
  });

  it('returns an empty set when the rule map is empty', () => {
    const userDoors = new Set([1, 2, 3]);
    const ruleMap = new Map<number, Set<number>>();
    const out = deriveEffectiveRuleIds(userDoors, ruleMap);
    expect(out).toEqual(new Set());
  });

  it('claims multiple rules independently — each evaluated separately', () => {
    const userDoors = new Set([1, 2, 3, 10]); // covers A fully, B partial, C empty-overlap
    const ruleMap = new Map<number, Set<number>>([
      [6248, new Set([1, 2])], // claimed
      [6249, new Set([1, 2, 4])], // missing 4 → not claimed
      [6250, new Set([10])], // claimed
    ]);
    const out = deriveEffectiveRuleIds(userDoors, ruleMap);
    expect(out).toEqual(new Set([6248, 6250]));
  });
});

describe('derivedBuildingNames', () => {
  it('returns building names for buildings whose rule id is in the effective set', () => {
    const effective = new Set([6248, 6250]);
    const buildings = [
      building('Maple Building', 6248),
      building('Pine Creek Building', 6249),
      building('Jamboree Building', 6250),
    ];
    expect(derivedBuildingNames(effective, buildings)).toEqual([
      'Jamboree Building',
      'Maple Building',
    ]);
  });

  it('excludes buildings whose rule id is not in the effective set', () => {
    const effective = new Set([6248]);
    const buildings = [building('Maple Building', 6248), building('Pine Creek Building', 6249)];
    expect(derivedBuildingNames(effective, buildings)).toEqual(['Maple Building']);
  });

  it('excludes buildings with no kindoo_rule (rule_id absent)', () => {
    const effective = new Set([6248]);
    const buildings = [building('Maple Building', 6248), building('Unconfigured Building', null)];
    expect(derivedBuildingNames(effective, buildings)).toEqual(['Maple Building']);
  });

  it('returns alphabetically sorted, deduplicated list', () => {
    const effective = new Set([6248, 6249, 6250]);
    const buildings = [
      building('Zebra Building', 6250),
      building('Apple Building', 6248),
      building('Mango Building', 6249),
    ];
    expect(derivedBuildingNames(effective, buildings)).toEqual([
      'Apple Building',
      'Mango Building',
      'Zebra Building',
    ]);
  });

  it('returns [] when no rule ids match', () => {
    const effective = new Set([9999]);
    const buildings = [building('Maple Building', 6248)];
    expect(derivedBuildingNames(effective, buildings)).toEqual([]);
  });

  it('returns [] for an empty effective set', () => {
    const effective = new Set<number>();
    const buildings = [building('Maple Building', 6248)];
    expect(derivedBuildingNames(effective, buildings)).toEqual([]);
  });
});

describe('buildRuleDoorMap', () => {
  function ruleResp(id: number, name: string, selectedIds: number[], extraIds: number[] = []) {
    const doors = [
      ...selectedIds.map((did) => ({
        ID: did,
        Name: `door-${did}`,
        Description: 'Meetinghouse',
        IsSelected: true,
      })),
      ...extraIds.map((did) => ({
        ID: did,
        Name: `door-${did}`,
        Description: 'Meetinghouse',
        IsSelected: false,
      })),
    ];
    return ok({ ID: id, Name: name, doors });
  }

  it('makes one call per rule and assembles a RID → Set<DoorID> map', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return ruleResp(6248, 'Maple - Everyday', [1, 2, 3], [10, 20]);
      if (call === 2) return ruleResp(6249, 'Pine Creek', [10, 11]);
      return ruleResp(6250, 'Jamboree', [20, 21, 22]);
    });
    const map = await buildRuleDoorMap(SESSION, 27994, [6248, 6249, 6250], fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(map.size).toBe(3);
    expect(map.get(6248)).toEqual(new Set([1, 2, 3]));
    expect(map.get(6249)).toEqual(new Set([10, 11]));
    expect(map.get(6250)).toEqual(new Set([20, 21, 22]));
  });

  it('handles a rule with no selected doors (claims would never fire — empty-set guarded by derive)', async () => {
    const fetchImpl = vi.fn(async () => ruleResp(6248, 'Empty', []));
    const map = await buildRuleDoorMap(SESSION, 27994, [6248], fetchImpl);
    expect(map.get(6248)).toEqual(new Set());
  });

  it('returns an empty map when no rule ids are passed', async () => {
    const fetchImpl = vi.fn();
    const map = await buildRuleDoorMap(SESSION, 27994, [], fetchImpl);
    expect(map.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('enrichUsersWithDerivedBuildings', () => {
  function ku(over: Partial<KindooEnvironmentUser>): KindooEnvironmentUser {
    return {
      euid: 'e1',
      userId: 'u1',
      username: 'a@example.com',
      description: '',
      isTempUser: false,
      startAccessDoorsDateAtTimeZone: null,
      expiryDateAtTimeZone: null,
      expiryTimeZone: 'MST',
      accessSchedules: [],
      ...over,
    };
  }

  function pageResp(rows: Array<{ DoorID: number; AccessScheduleID?: number }>, total: number) {
    return ok({
      CurrentNumberOfRows: rows.length,
      TotalRecordNumber: total,
      // Default AccessScheduleID 0 (direct grant) when a row omits it.
      RulesList: rows.map((r) => ({ AccessScheduleID: 0, ...r })),
    });
  }

  it('populates derivedBuildings + directGrantBuildings for each user based on their door grants', async () => {
    const users = [
      ku({ euid: 'e1', userId: 'u1', username: 'alice@example.com' }),
      ku({ euid: 'e2', userId: 'u2', username: 'bob@example.com' }),
    ];
    const ruleDoorMap = new Map<number, Set<number>>([
      [6248, new Set([1, 2])],
      [6249, new Set([10, 11])],
    ]);
    const buildings = [building('Maple Building', 6248), building('Pine Creek Building', 6249)];

    // alice → doors [1, 2] all direct (claims Maple via both derived +
    // direct); bob → doors [10, 11] all direct (claims Pine Creek).
    const responses = new Map<string, ReturnType<typeof pageResp>>();
    responses.set('u1', pageResp([{ DoorID: 1 }, { DoorID: 2 }], 2));
    responses.set('u2', pageResp([{ DoorID: 10 }, { DoorID: 11 }], 2));
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      const form = await new Request('https://test.invalid/', init).formData();
      const uid = String(form.get('UID') ?? '');
      const resp = responses.get(uid);
      if (!resp) throw new Error(`unexpected uid ${uid}`);
      return resp;
    });

    const enriched = await enrichUsersWithDerivedBuildings(
      SESSION,
      27994,
      users,
      ruleDoorMap,
      buildings,
      { concurrency: 2, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(enriched[0]?.derivedBuildings).toEqual(['Maple Building']);
    expect(enriched[0]?.directGrantBuildings).toEqual(['Maple Building']);
    expect(enriched[1]?.derivedBuildings).toEqual(['Pine Creek Building']);
    expect(enriched[1]?.directGrantBuildings).toEqual(['Pine Creek Building']);
    // Both users hold ≥1 door → they have a footprint.
    expect(enriched[0]?.hasNoDoorFootprint).toBe(false);
    expect(enriched[1]?.hasNoDoorFootprint).toBe(false);
  });

  it('flags hasNoDoorFootprint=true when the fetch succeeds with zero door rows', async () => {
    // A Kindoo Manager / non-door-access account: the per-user fetch
    // succeeds but returns no doors of any kind. derivedBuildings and
    // directGrantBuildings are both [] (derived, not null), and the
    // raw-door-count signal `hasNoDoorFootprint` is true.
    const users = [ku({ userId: 'u1', username: 'manager@example.com' })];
    const ruleDoorMap = new Map<number, Set<number>>([[6248, new Set([1, 2])]]);
    const buildings = [building('Maple Building', 6248)];
    const fetchImpl = vi.fn(async () => pageResp([], 0));
    const enriched = await enrichUsersWithDerivedBuildings(
      SESSION,
      27994,
      users,
      ruleDoorMap,
      buildings,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(enriched[0]?.derivedBuildings).toEqual([]);
    expect(enriched[0]?.directGrantBuildings).toEqual([]);
    expect(enriched[0]?.hasNoDoorFootprint).toBe(true);
  });

  it('flags hasNoDoorFootprint=false when doors exist but map to no SBA building', async () => {
    // The user holds a door, but it belongs to no SBA-tracked rule →
    // derivedBuildings === [] EVEN THOUGH the user has a footprint.
    // hasNoDoorFootprint must distinguish this from the zero-door case
    // (it keys off the raw door count, not derivedBuildings).
    const users = [ku({ userId: 'u1', username: 'untracked@example.com' })];
    const ruleDoorMap = new Map<number, Set<number>>([[6248, new Set([1, 2])]]);
    const buildings = [building('Maple Building', 6248)];
    // Door 99 is not in any tracked rule's door set.
    const fetchImpl = vi.fn(async () => pageResp([{ DoorID: 99 }], 1));
    const enriched = await enrichUsersWithDerivedBuildings(
      SESSION,
      27994,
      users,
      ruleDoorMap,
      buildings,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(enriched[0]?.derivedBuildings).toEqual([]);
    expect(enriched[0]?.hasNoDoorFootprint).toBe(false);
  });

  it('a rule-only door is in derivedBuildings but NOT directGrantBuildings', async () => {
    // Maple's doors [1,2] come via a granting rule (AccessScheduleID
    // nonzero), not a direct grant. derivedBuildings claims Maple (the
    // doors are present); directGrantBuildings does not (none direct).
    const users = [ku({ userId: 'u1', username: 'rule@example.com' })];
    const ruleDoorMap = new Map<number, Set<number>>([[6248, new Set([1, 2])]]);
    const buildings = [building('Maple Building', 6248)];
    const fetchImpl = vi.fn(async () =>
      pageResp(
        [
          { DoorID: 1, AccessScheduleID: 6248 },
          { DoorID: 2, AccessScheduleID: 6248 },
        ],
        2,
      ),
    );
    const enriched = await enrichUsersWithDerivedBuildings(
      SESSION,
      27994,
      users,
      ruleDoorMap,
      buildings,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(enriched[0]?.derivedBuildings).toEqual(['Maple Building']);
    expect(enriched[0]?.directGrantBuildings).toEqual([]);
  });

  it('a direct-only door is in BOTH derivedBuildings and directGrantBuildings', async () => {
    const users = [ku({ userId: 'u1', username: 'direct@example.com' })];
    const ruleDoorMap = new Map<number, Set<number>>([[6248, new Set([1, 2])]]);
    const buildings = [building('Maple Building', 6248)];
    const fetchImpl = vi.fn(async () =>
      pageResp(
        [
          { DoorID: 1, AccessScheduleID: 0 },
          { DoorID: 2, AccessScheduleID: 0 },
        ],
        2,
      ),
    );
    const enriched = await enrichUsersWithDerivedBuildings(
      SESSION,
      27994,
      users,
      ruleDoorMap,
      buildings,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(enriched[0]?.derivedBuildings).toEqual(['Maple Building']);
    expect(enriched[0]?.directGrantBuildings).toEqual(['Maple Building']);
  });

  it('an overlap door (both rule + direct rows) lands in directGrantBuildings', async () => {
    // Door 1 emits two rows — one direct, one via rule. Door 2 direct
    // only. Both are direct-covered, so directGrantBuildings claims
    // Maple (the overlap/lag case the design calls out).
    const users = [ku({ userId: 'u1', username: 'overlap@example.com' })];
    const ruleDoorMap = new Map<number, Set<number>>([[6248, new Set([1, 2])]]);
    const buildings = [building('Maple Building', 6248)];
    const fetchImpl = vi.fn(async () =>
      pageResp(
        [
          { DoorID: 1, AccessScheduleID: 0 },
          { DoorID: 1, AccessScheduleID: 6248 },
          { DoorID: 2, AccessScheduleID: 0 },
        ],
        3,
      ),
    );
    const enriched = await enrichUsersWithDerivedBuildings(
      SESSION,
      27994,
      users,
      ruleDoorMap,
      buildings,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(enriched[0]?.derivedBuildings).toEqual(['Maple Building']);
    expect(enriched[0]?.directGrantBuildings).toEqual(['Maple Building']);
  });

  it('partial direct coverage does NOT claim the rule for directGrantBuildings (strict subset)', async () => {
    // Maple needs doors [1,2]. The user holds door 1 direct + door 2
    // via rule only. derivedBuildings claims Maple (both doors present);
    // directGrantBuildings does NOT (door 2 is not direct).
    const users = [ku({ userId: 'u1', username: 'partial@example.com' })];
    const ruleDoorMap = new Map<number, Set<number>>([[6248, new Set([1, 2])]]);
    const buildings = [building('Maple Building', 6248)];
    const fetchImpl = vi.fn(async () =>
      pageResp(
        [
          { DoorID: 1, AccessScheduleID: 0 },
          { DoorID: 2, AccessScheduleID: 6248 },
        ],
        2,
      ),
    );
    const enriched = await enrichUsersWithDerivedBuildings(
      SESSION,
      27994,
      users,
      ruleDoorMap,
      buildings,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(enriched[0]?.derivedBuildings).toEqual(['Maple Building']);
    expect(enriched[0]?.directGrantBuildings).toEqual([]);
  });

  it('sets BOTH derivedBuildings and directGrantBuildings to null when a per-user call throws', async () => {
    const users = [ku({ userId: 'u1', username: 'fail@example.com' })];
    const ruleDoorMap = new Map<number, Set<number>>([[6248, new Set([1])]]);
    const buildings = [building('Maple Building', 6248)];
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    });
    const enriched = await enrichUsersWithDerivedBuildings(
      SESSION,
      27994,
      users,
      ruleDoorMap,
      buildings,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(enriched[0]?.derivedBuildings).toBeNull();
    expect(enriched[0]?.directGrantBuildings).toBeNull();
    // Fetch FAILED — we can't tell whether the user has a footprint, so
    // the flag is left unset (the null derivation guard handles the skip).
    expect(enriched[0]?.hasNoDoorFootprint).toBeUndefined();
  });

  it('reports progress after each completed user', async () => {
    const users = [
      ku({ userId: 'u1', username: 'a@example.com' }),
      ku({ userId: 'u2', username: 'b@example.com' }),
      ku({ userId: 'u3', username: 'c@example.com' }),
    ];
    const ruleDoorMap = new Map<number, Set<number>>();
    const buildings: Building[] = [];
    const fetchImpl = vi.fn(async () => pageResp([], 0));
    const progress: number[] = [];
    await enrichUsersWithDerivedBuildings(SESSION, 27994, users, ruleDoorMap, buildings, {
      concurrency: 1,
      onProgress: (completed) => progress.push(completed),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(progress).toEqual([1, 2, 3]);
  });

  it('returns empty array when no users to enrich (no fetch calls)', async () => {
    const fetchImpl = vi.fn();
    const enriched = await enrichUsersWithDerivedBuildings(SESSION, 27994, [], new Map(), [], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(enriched).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skipDoorFetchForNonGuests elides the fetch for known non-Guests but not Guests/unknowns', async () => {
    // Three users: a Guest (role 2 — fetched), a Manager (role 0 —
    // elided), and an unknown-role user (role unset — fetched for the
    // footprint fallback). Only the Guest + unknown trigger a door call.
    const users = [
      ku({ userId: 'guest', username: 'guest@example.com', userRole: 2 }),
      ku({ userId: 'mgr', username: 'mgr@example.com', userRole: 0 }),
      ku({ userId: 'unknown', username: 'unknown@example.com' }),
    ];
    const ruleDoorMap = new Map<number, Set<number>>([[6248, new Set([1])]]);
    const buildings = [building('Maple Building', 6248)];
    const fetchedUids: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      const form = await new Request('https://test.invalid/', init).formData();
      fetchedUids.push(String(form.get('UID') ?? ''));
      return pageResp([{ DoorID: 1 }], 1);
    });
    const enriched = await enrichUsersWithDerivedBuildings(
      SESSION,
      27994,
      users,
      ruleDoorMap,
      buildings,
      {
        concurrency: 1,
        skipDoorFetchForNonGuests: true,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    // Manager's door fetch was elided.
    expect(fetchedUids.sort()).toEqual(['guest', 'unknown']);
    // Manager keeps unset door fields (the detector skips it by role).
    expect(enriched[1]?.derivedBuildings).toBeUndefined();
    expect(enriched[1]?.hasNoDoorFootprint).toBeUndefined();
    // Guest + unknown were derived normally.
    expect(enriched[0]?.derivedBuildings).toEqual(['Maple Building']);
    expect(enriched[2]?.derivedBuildings).toEqual(['Maple Building']);
  });

  it('without skipDoorFetchForNonGuests, every user (incl. non-Guests) is fetched', async () => {
    // The flag is off by default — backward-compatible: a non-Guest is
    // still fetched.
    const users = [ku({ userId: 'mgr', username: 'mgr@example.com', userRole: 0 })];
    const ruleDoorMap = new Map<number, Set<number>>([[6248, new Set([1])]]);
    const buildings = [building('Maple Building', 6248)];
    const fetchImpl = vi.fn(async () => pageResp([{ DoorID: 1 }], 1));
    const enriched = await enrichUsersWithDerivedBuildings(
      SESSION,
      27994,
      users,
      ruleDoorMap,
      buildings,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(enriched[0]?.derivedBuildings).toEqual(['Maple Building']);
  });
});

describe('getUserDoorIds', () => {
  function pageResp(rows: Array<{ DoorID: number; AccessScheduleID?: number }>, total: number) {
    return ok({
      CurrentNumberOfRows: rows.length,
      TotalRecordNumber: total,
      RulesList: rows.map((r) => ({ AccessScheduleID: 0, ...r })),
    });
  }

  it('flattens paginated grants into a Set of DoorIDs', async () => {
    const fetchImpl = vi.fn(async () =>
      pageResp([{ DoorID: 1001 }, { DoorID: 1002 }, { DoorID: 1003, AccessScheduleID: 6248 }], 3),
    );
    const result = await getUserDoorIds(SESSION, 'user-1', 27994, fetchImpl);
    expect(result).toEqual(new Set([1001, 1002, 1003]));
  });

  it('dedupes door ids that appear under multiple access schedules', async () => {
    const fetchImpl = vi.fn(async () =>
      pageResp(
        [
          { DoorID: 1001, AccessScheduleID: 6248 },
          { DoorID: 1001, AccessScheduleID: 6250 },
        ],
        2,
      ),
    );
    const result = await getUserDoorIds(SESSION, 'user-1', 27994, fetchImpl);
    expect(result).toEqual(new Set([1001]));
  });

  it('returns an empty set when the user has no grants', async () => {
    const fetchImpl = vi.fn(async () => pageResp([], 0));
    const result = await getUserDoorIds(SESSION, 'user-1', 27994, fetchImpl);
    expect(result).toEqual(new Set());
  });
});

describe('getUserDoorGrants', () => {
  function pageResp(rows: Array<{ DoorID: number; AccessScheduleID?: number }>, total: number) {
    return ok({
      CurrentNumberOfRows: rows.length,
      TotalRecordNumber: total,
      RulesList: rows.map((r) => ({ AccessScheduleID: 0, ...r })),
    });
  }

  it('partitions rows into all-doors and direct-only door sets', async () => {
    const fetchImpl = vi.fn(async () =>
      pageResp(
        [
          { DoorID: 1, AccessScheduleID: 0 }, // direct
          { DoorID: 2, AccessScheduleID: 6248 }, // rule-derived
          { DoorID: 3, AccessScheduleID: 0 }, // direct
        ],
        3,
      ),
    );
    const { all, direct } = await getUserDoorGrants(SESSION, 'user-1', 27994, fetchImpl);
    expect(all).toEqual(new Set([1, 2, 3]));
    expect(direct).toEqual(new Set([1, 3]));
  });

  it('counts an overlap door (both direct + rule rows) as direct', async () => {
    const fetchImpl = vi.fn(async () =>
      pageResp(
        [
          { DoorID: 1, AccessScheduleID: 6248 },
          { DoorID: 1, AccessScheduleID: 0 },
        ],
        2,
      ),
    );
    const { all, direct } = await getUserDoorGrants(SESSION, 'user-1', 27994, fetchImpl);
    expect(all).toEqual(new Set([1]));
    expect(direct).toEqual(new Set([1]));
  });

  it('returns empty sets when the user has no grants', async () => {
    const fetchImpl = vi.fn(async () => pageResp([], 0));
    const { all, direct } = await getUserDoorGrants(SESSION, 'user-1', 27994, fetchImpl);
    expect(all).toEqual(new Set());
    expect(direct).toEqual(new Set());
  });

  it('direct set is empty when every row is rule-derived', async () => {
    const fetchImpl = vi.fn(async () =>
      pageResp(
        [
          { DoorID: 1, AccessScheduleID: 6248 },
          { DoorID: 2, AccessScheduleID: 6249 },
        ],
        2,
      ),
    );
    const { all, direct } = await getUserDoorGrants(SESSION, 'user-1', 27994, fetchImpl);
    expect(all).toEqual(new Set([1, 2]));
    expect(direct).toEqual(new Set());
  });
});
