// Unit tests for the Sync Phase 2 fix dispatcher. Verifies:
//   - `fixActionsFor` returns the expected buttons per discrepancy code.
//   - `buildCallableInput` constructs the discriminated union payload
//     correctly for each SBA-side fix.
//   - `applyFix` routes SBA codes to the callable mock and Kindoo codes
//     to the orchestrator mock, never crossing wires.

import { describe, expect, it, vi } from 'vitest';
import type { Building, Stake, Ward } from '@kindoo/shared';
import type { KindooEnvironment } from '../endpoints';
import { applyFix, buildCallableInput, fixActionsFor, type DispatchContext } from './fix';
import type { Discrepancy } from './detector';

function stake(): Stake {
  return { stake_id: 'csnorth', stake_name: 'CSN' } as Stake;
}

function ward(code: string, name: string, building: string): Ward {
  return { ward_code: code, ward_name: name, building_name: building } as Ward;
}

function building(name: string, ruleId: number | null): Building {
  const b: Partial<Building> = { building_id: name, building_name: name };
  if (ruleId !== null) b.kindoo_rule = { rule_id: ruleId, rule_name: `${name} Doors` };
  return b as Building;
}

function env(): KindooEnvironment {
  return { EID: 27994, Name: 'CSN', TimeZone: 'Mountain Standard Time' };
}

function discrepancy(over: Partial<Discrepancy> = {}): Discrepancy {
  return {
    canonical: 'a@example.com',
    displayEmail: 'a@example.com',
    code: 'kindoo-only',
    severity: 'drift',
    reason: 'r',
    sba: null,
    kindoo: {
      description: 'Cordera Ward (Sunday School Teacher)',
      isTempUser: false,
      memberName: 'Alice Person',
      primaryScope: 'CO',
      intendedType: 'auto',
      intendedCallings: ['Sunday School Teacher'],
      intendedFreeText: '',
      ruleIds: [6248],
      buildingNames: ['Cordera Building'],
      derivedBuildings: null,
    },
    ...over,
  };
}

function ctxWith(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    stake: stake(),
    wards: [ward('CO', 'Cordera Ward', 'Cordera Building')],
    buildings: [building('Cordera Building', 6248)],
    kindooSites: [],
    envs: [env()],
    session: { token: 't', eid: 27994 },
    callSyncApplyFix: vi.fn().mockResolvedValue({ success: true, seatId: 'a@example.com' }),
    syncProvisionFromSeat: vi.fn().mockResolvedValue({
      kindoo_uid: 'u1',
      action: 'invited',
      note: 'ok',
    }),
    ...overrides,
  };
}

describe('fixActionsFor', () => {
  it('sba-only returns one Provision in Kindoo action', () => {
    const actions = fixActionsFor(
      discrepancy({ code: 'sba-only', sba: {} as never, kindoo: null }),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ side: 'kindoo', testId: 'provision-kindoo' });
  });

  it('kindoo-only returns one Create SBA seat action', () => {
    const actions = fixActionsFor(discrepancy({ code: 'kindoo-only' }));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ side: 'sba', testId: 'create-sba' });
  });

  it('extra-kindoo-calling returns one Add to SBA seat action', () => {
    const actions = fixActionsFor(discrepancy({ code: 'extra-kindoo-calling' }));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ side: 'sba', testId: 'add-callings-sba' });
  });

  it('scope-mismatch / type-mismatch / buildings-mismatch each return two actions', () => {
    for (const code of ['scope-mismatch', 'type-mismatch', 'buildings-mismatch'] as const) {
      const actions = fixActionsFor(discrepancy({ code }));
      expect(actions).toHaveLength(2);
      expect(actions.map((a) => a.side)).toEqual(['kindoo', 'sba']);
    }
  });

  it('kindoo-unparseable returns no actions', () => {
    expect(fixActionsFor(discrepancy({ code: 'kindoo-unparseable' }))).toEqual([]);
  });
});

describe('buildCallableInput', () => {
  it('kindoo-only on an auto seat carries scope/type/callings + building names', () => {
    const input = buildCallableInput(discrepancy({ code: 'kindoo-only' }));
    expect(input.stakeId).toBe('csnorth');
    expect(input.fix.code).toBe('kindoo-only');
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.memberEmail).toBe('a@example.com');
    expect(payload.memberName).toBe('Alice Person');
    expect(payload.scope).toBe('CO');
    expect(payload.type).toBe('auto');
    expect(payload.callings).toEqual(['Sunday School Teacher']);
    expect(payload.buildingNames).toEqual(['Cordera Building']);
    expect(payload.isTempUser).toBe(false);
    // No reason on auto.
    expect(payload.reason).toBeUndefined();
  });

  it('kindoo-only on an auto seat uses derivedBuildings over buildingNames when available', () => {
    // The bulk-listing AccessSchedules-derived `buildingNames` misses
    // Church Access Automation direct grants; `derivedBuildings`
    // (from the door-grant chain) is the truth for auto seats.
    const input = buildCallableInput(
      discrepancy({
        code: 'kindoo-only',
        kindoo: {
          description: 'Cordera Ward (Sunday School Teacher)',
          isTempUser: false,
          memberName: 'Auto Person',
          primaryScope: 'CO',
          intendedType: 'auto',
          intendedCallings: ['Sunday School Teacher'],
          intendedFreeText: '',
          ruleIds: [],
          buildingNames: [],
          derivedBuildings: ['Cordera Building', 'Pine Creek Building'],
        },
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.buildingNames).toEqual(['Cordera Building', 'Pine Creek Building']);
  });

  it('kindoo-only on an auto seat falls back to buildingNames when derivedBuildings is null', () => {
    const input = buildCallableInput(
      discrepancy({
        code: 'kindoo-only',
        kindoo: {
          description: 'Cordera Ward (Sunday School Teacher)',
          isTempUser: false,
          memberName: 'Auto Person',
          primaryScope: 'CO',
          intendedType: 'auto',
          intendedCallings: ['Sunday School Teacher'],
          intendedFreeText: '',
          ruleIds: [6248],
          buildingNames: ['Cordera Building'],
          derivedBuildings: null,
        },
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.buildingNames).toEqual(['Cordera Building']);
  });

  it('kindoo-only on a manual seat ignores derivedBuildings (manual path uses AccessSchedules buildingNames)', () => {
    // Manual seats have authoritative AccessSchedules → buildingNames;
    // derivedBuildings is only the truth for auto. Even if both are
    // populated, the manual branch sticks with buildingNames.
    const input = buildCallableInput(
      discrepancy({
        code: 'kindoo-only',
        kindoo: {
          description: 'Cordera Ward (Building Greeter)',
          isTempUser: false,
          memberName: 'M M',
          primaryScope: 'CO',
          intendedType: 'manual',
          intendedCallings: [],
          intendedFreeText: 'Building Greeter',
          ruleIds: [6248],
          buildingNames: ['Cordera Building'],
          derivedBuildings: ['Pine Creek Building'],
        },
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.buildingNames).toEqual(['Cordera Building']);
  });

  it('kindoo-only on a manual seat splits intended free-text into callings + reason', () => {
    const input = buildCallableInput(
      discrepancy({
        code: 'kindoo-only',
        kindoo: {
          description: 'Cordera Ward (Building Greeter, Janitor)',
          isTempUser: false,
          memberName: 'Mike Manual',
          primaryScope: 'CO',
          intendedType: 'manual',
          intendedCallings: [],
          intendedFreeText: 'Building Greeter, Janitor',
          ruleIds: [6248],
          buildingNames: ['Cordera Building'],
          derivedBuildings: null,
        },
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.callings).toEqual(['Building Greeter', 'Janitor']);
    expect(payload.reason).toBe('Building Greeter, Janitor');
    expect(payload.type).toBe('manual');
  });

  it('kindoo-only on a temp seat carries startDate/endDate', () => {
    const input = buildCallableInput(
      discrepancy({
        code: 'kindoo-only',
        kindoo: {
          description: 'Cordera Ward (Visiting speaker)',
          isTempUser: true,
          memberName: 'Tina Temp',
          primaryScope: 'CO',
          intendedType: 'temp',
          intendedCallings: [],
          intendedFreeText: 'Visiting speaker',
          ruleIds: [6248],
          buildingNames: ['Cordera Building'],
          derivedBuildings: null,
          startDate: '2026-05-13',
          endDate: '2026-05-20',
        },
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.type).toBe('temp');
    expect(payload.startDate).toBe('2026-05-13');
    expect(payload.endDate).toBe('2026-05-20');
    expect(payload.isTempUser).toBe(true);
  });

  it('extra-kindoo-calling splits free text into extraCallings', () => {
    const input = buildCallableInput(
      discrepancy({
        code: 'extra-kindoo-calling',
        kindoo: {
          description: 'Cordera Ward (Sunday School Teacher, Janitor, Greeter)',
          isTempUser: false,
          memberName: 'Eric Extra',
          primaryScope: 'CO',
          intendedType: 'auto',
          intendedCallings: ['Sunday School Teacher'],
          intendedFreeText: 'Janitor, Greeter',
          ruleIds: [6248],
          buildingNames: ['Cordera Building'],
          derivedBuildings: null,
        },
      }),
    );
    expect(input.fix.code).toBe('extra-kindoo-calling');
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.extraCallings).toEqual(['Janitor', 'Greeter']);
  });

  it('scope-mismatch sends Kindoo primary scope', () => {
    const input = buildCallableInput(
      discrepancy({
        code: 'scope-mismatch',
        sba: { scope: 'PC', type: 'auto', callings: [], buildingNames: [] },
        kindoo: {
          description: 'Cordera Ward (Sunday School Teacher)',
          isTempUser: false,
          memberName: 'S M',
          primaryScope: 'CO',
          intendedType: 'auto',
          intendedCallings: ['Sunday School Teacher'],
          intendedFreeText: '',
          ruleIds: [6248],
          buildingNames: ['Cordera Building'],
          derivedBuildings: null,
        },
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.newScope).toBe('CO');
  });

  it('type-mismatch sends Kindoo intended type', () => {
    const input = buildCallableInput(
      discrepancy({
        code: 'type-mismatch',
        sba: { scope: 'CO', type: 'auto', callings: [], buildingNames: [] },
        kindoo: {
          description: 'Cordera Ward (Visiting speaker)',
          isTempUser: true,
          memberName: 'T M',
          primaryScope: 'CO',
          intendedType: 'temp',
          intendedCallings: [],
          intendedFreeText: 'Visiting speaker',
          ruleIds: [6248],
          buildingNames: ['Cordera Building'],
          derivedBuildings: null,
          startDate: '2026-05-13',
          endDate: '2026-05-20',
        },
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.newType).toBe('temp');
  });

  it('buildings-mismatch on a manual seat sends AccessSchedules-derived buildingNames', () => {
    const input = buildCallableInput(
      discrepancy({
        code: 'buildings-mismatch',
        sba: { scope: 'CO', type: 'manual', callings: [], buildingNames: ['Cordera Building'] },
        kindoo: {
          description: 'Cordera Ward (Building Greeter)',
          isTempUser: false,
          memberName: 'B M',
          primaryScope: 'CO',
          intendedType: 'manual',
          intendedCallings: [],
          intendedFreeText: 'Building Greeter',
          ruleIds: [6249],
          buildingNames: ['Pine Creek Building'],
          derivedBuildings: null,
        },
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.newBuildingNames).toEqual(['Pine Creek Building']);
  });

  it('buildings-mismatch on an auto seat sends derivedBuildings, NOT buildingNames', () => {
    // Auto seats: the bulk listing's AccessSchedules-derived
    // `buildingNames` excludes Church Access Automation direct grants
    // (empty for ~310 of 313 users). Sending `buildingNames` would wipe
    // the seat's correct buildings server-side. `derivedBuildings` is
    // the truth.
    const input = buildCallableInput(
      discrepancy({
        code: 'buildings-mismatch',
        sba: { scope: 'CO', type: 'auto', callings: [], buildingNames: ['Cordera Building'] },
        kindoo: {
          description: 'Cordera Ward (Sunday School Teacher)',
          isTempUser: false,
          memberName: 'A A',
          primaryScope: 'CO',
          intendedType: 'auto',
          intendedCallings: ['Sunday School Teacher'],
          intendedFreeText: '',
          ruleIds: [],
          buildingNames: [],
          derivedBuildings: ['Cordera Building', 'Pine Creek Building'],
        },
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.newBuildingNames).toEqual(['Cordera Building', 'Pine Creek Building']);
  });

  it('buildings-mismatch on an auto seat with null derivedBuildings throws (no valid source)', () => {
    expect(() =>
      buildCallableInput(
        discrepancy({
          code: 'buildings-mismatch',
          sba: { scope: 'CO', type: 'auto', callings: [], buildingNames: ['Cordera Building'] },
          kindoo: {
            description: 'Cordera Ward (Sunday School Teacher)',
            isTempUser: false,
            memberName: 'A A',
            primaryScope: 'CO',
            intendedType: 'auto',
            intendedCallings: ['Sunday School Teacher'],
            intendedFreeText: '',
            ruleIds: [],
            buildingNames: [],
            derivedBuildings: null,
          },
        }),
      ),
    ).toThrow(/derivation/i);
  });

  it('throws for sba-only (no SBA-side path)', () => {
    expect(() => buildCallableInput(discrepancy({ code: 'sba-only' }))).toThrow();
  });

  it('throws for kindoo-unparseable (no SBA-side path)', () => {
    expect(() => buildCallableInput(discrepancy({ code: 'kindoo-unparseable' }))).toThrow();
  });
});

describe('applyFix', () => {
  it('SBA-side action calls the callable wrapper and returns ok on success', async () => {
    const ctx = ctxWith();
    const action = fixActionsFor(discrepancy({ code: 'kindoo-only' }))[0]!;
    const outcome = await applyFix(discrepancy({ code: 'kindoo-only' }), action, ctx);
    expect(outcome).toEqual({ ok: true });
    expect(ctx.callSyncApplyFix).toHaveBeenCalledTimes(1);
    expect(ctx.syncProvisionFromSeat).not.toHaveBeenCalled();
  });

  it('SBA-side action surfaces the callable error envelope', async () => {
    const ctx = ctxWith({
      callSyncApplyFix: vi.fn().mockResolvedValue({ success: false, error: 'seat not found' }),
    });
    const action = fixActionsFor(discrepancy({ code: 'kindoo-only' }))[0]!;
    const outcome = await applyFix(discrepancy({ code: 'kindoo-only' }), action, ctx);
    expect(outcome).toEqual({ ok: false, error: 'seat not found' });
  });

  it('Kindoo-side action calls the orchestrator and returns ok', async () => {
    const ctx = ctxWith();
    const d = discrepancy({
      code: 'sba-only',
      sba: {
        scope: 'CO',
        type: 'auto',
        callings: ['Sunday School Teacher'],
        buildingNames: ['Cordera Building'],
      },
      kindoo: null,
    });
    const action = fixActionsFor(d)[0]!;
    const outcome = await applyFix(d, action, ctx);
    expect(outcome).toEqual({ ok: true });
    expect(ctx.syncProvisionFromSeat).toHaveBeenCalledTimes(1);
    expect(ctx.callSyncApplyFix).not.toHaveBeenCalled();
  });

  it('T-42: threads kindooSites from the dispatch context through to syncProvisionFromSeat', async () => {
    // The Kindoo-side fix path must pass `kindooSites` so the
    // orchestrator's `unionSeatBuildings` per-site filter can resolve
    // the active session's site and exclude parallel-site duplicate
    // buildings from the write. Without this, a multi-site seat
    // surfaced on the Sync drift report would push foreign-site
    // buildings into the active environment.
    const kindooSites = [
      {
        id: 'east-stake',
        display_name: 'East Stake',
        kindoo_expected_site_name: 'East Stake',
        kindoo_eid: 4321,
        created_at: { seconds: 0, nanoseconds: 0 },
        last_modified_at: { seconds: 0, nanoseconds: 0 },
        lastActor: { email: 'sys', canonical: 'sys' },
      },
    ] as unknown as DispatchContext['kindooSites'];
    const provisionMock = vi.fn().mockResolvedValue({
      kindoo_uid: 'u1',
      action: 'invited',
      note: 'ok',
    });
    const ctx = ctxWith({ kindooSites, syncProvisionFromSeat: provisionMock });
    const d = discrepancy({
      code: 'sba-only',
      sba: {
        scope: 'CO',
        type: 'auto',
        callings: ['Sunday School Teacher'],
        buildingNames: ['Cordera Building'],
      },
      kindoo: null,
    });
    const action = fixActionsFor(d)[0]!;
    await applyFix(d, action, ctx);
    expect(provisionMock).toHaveBeenCalledTimes(1);
    const callArgs = provisionMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs['kindooSites']).toBe(kindooSites);
  });

  it('Kindoo-side action wraps a thrown orchestrator error as a flat error', async () => {
    const ctx = ctxWith({
      syncProvisionFromSeat: vi.fn().mockRejectedValue(new Error('Kindoo 401')),
    });
    const d = discrepancy({
      code: 'sba-only',
      sba: { scope: 'CO', type: 'auto', callings: [], buildingNames: ['Cordera Building'] },
      kindoo: null,
    });
    const action = fixActionsFor(d)[0]!;
    const outcome = await applyFix(d, action, ctx);
    expect(outcome).toEqual({ ok: false, error: 'Kindoo 401' });
  });

  it('Update SBA on auto buildings-mismatch with null derivedBuildings is refused as a flat error', async () => {
    const ctx = ctxWith();
    const d = discrepancy({
      code: 'buildings-mismatch',
      sba: { scope: 'CO', type: 'auto', callings: [], buildingNames: ['Cordera Building'] },
      kindoo: {
        description: 'Cordera Ward (Sunday School Teacher)',
        isTempUser: false,
        memberName: 'A A',
        primaryScope: 'CO',
        intendedType: 'auto',
        intendedCallings: ['Sunday School Teacher'],
        intendedFreeText: '',
        ruleIds: [],
        buildingNames: [],
        derivedBuildings: null,
      },
    });
    const sbaAction = fixActionsFor(d).find((a) => a.side === 'sba')!;
    const outcome = await applyFix(d, sbaAction, ctx);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatch(/derivation/i);
    }
    expect(ctx.callSyncApplyFix).not.toHaveBeenCalled();
  });

  it('Update Kindoo on a type-mismatch with an auto SBA seat is rejected with a clear error', async () => {
    const ctx = ctxWith();
    const d = discrepancy({
      code: 'type-mismatch',
      sba: { scope: 'CO', type: 'auto', callings: [], buildingNames: ['Cordera Building'] },
    });
    const kindooAction = fixActionsFor(d).find((a) => a.side === 'kindoo')!;
    const outcome = await applyFix(d, kindooAction, ctx);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('Church Access Automation');
    }
    expect(ctx.syncProvisionFromSeat).not.toHaveBeenCalled();
  });
});
