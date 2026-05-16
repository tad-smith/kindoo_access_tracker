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
      building('Cordera Building', 6248),
      building('Pine Creek Building', 6249),
      building('Jamboree Building', 6250),
    ];
    expect(derivedBuildingNames(effective, buildings)).toEqual([
      'Cordera Building',
      'Jamboree Building',
    ]);
  });

  it('excludes buildings whose rule id is not in the effective set', () => {
    const effective = new Set([6248]);
    const buildings = [building('Cordera Building', 6248), building('Pine Creek Building', 6249)];
    expect(derivedBuildingNames(effective, buildings)).toEqual(['Cordera Building']);
  });

  it('excludes buildings with no kindoo_rule (rule_id absent)', () => {
    const effective = new Set([6248]);
    const buildings = [building('Cordera Building', 6248), building('Unconfigured Building', null)];
    expect(derivedBuildingNames(effective, buildings)).toEqual(['Cordera Building']);
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
    const buildings = [building('Cordera Building', 6248)];
    expect(derivedBuildingNames(effective, buildings)).toEqual([]);
  });

  it('returns [] for an empty effective set', () => {
    const effective = new Set<number>();
    const buildings = [building('Cordera Building', 6248)];
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
      if (call === 1) return ruleResp(6248, 'Cordera - Everyday', [1, 2, 3], [10, 20]);
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

  function pageResp(rows: Array<{ DoorID: number }>, total: number) {
    return ok({
      CurrentNumberOfRows: rows.length,
      TotalRecordNumber: total,
      RulesList: rows.map((r) => ({ AccessScheduleID: 0, ...r })),
    });
  }

  it('populates derivedBuildings for each user based on their door grants', async () => {
    const users = [
      ku({ euid: 'e1', userId: 'u1', username: 'alice@example.com' }),
      ku({ euid: 'e2', userId: 'u2', username: 'bob@example.com' }),
    ];
    const ruleDoorMap = new Map<number, Set<number>>([
      [6248, new Set([1, 2])],
      [6249, new Set([10, 11])],
    ]);
    const buildings = [building('Cordera Building', 6248), building('Pine Creek Building', 6249)];

    // alice → doors [1, 2] (claims Cordera); bob → doors [10, 11] (claims Pine Creek).
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
    expect(enriched[0]?.derivedBuildings).toEqual(['Cordera Building']);
    expect(enriched[1]?.derivedBuildings).toEqual(['Pine Creek Building']);
  });

  it('sets derivedBuildings to null when a per-user call throws', async () => {
    const users = [ku({ userId: 'u1', username: 'fail@example.com' })];
    const ruleDoorMap = new Map<number, Set<number>>([[6248, new Set([1])]]);
    const buildings = [building('Cordera Building', 6248)];
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
