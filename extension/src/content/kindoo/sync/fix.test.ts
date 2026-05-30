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
import type { Discrepancy, KindooBlock } from './detector';

/** Build a KindooBlock with sensible defaults so each test only states
 * the fields it exercises. `directGrantBuildings` defaults to null
 * (derivation skipped) — tests that drive promote / demote set it. */
function kb(over: Partial<KindooBlock> = {}): KindooBlock {
  return {
    description: 'Maple Ward (Sunday School Teacher)',
    isTempUser: false,
    memberName: 'Alice Person',
    primaryScope: 'CO',
    intendedType: 'auto',
    intendedCallings: ['Sunday School Teacher'],
    intendedFreeText: '',
    ruleIds: [6248],
    buildingNames: ['Maple Building'],
    derivedBuildings: null,
    directGrantBuildings: null,
    ...over,
  };
}

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
    // Default kindoo-only fixture: church-backed auto (the common case).
    kindoo: kb({ grantTargetType: 'auto' }),
    ...over,
  };
}

function ctxWith(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    stakeId: 'csnorth',
    stake: stake(),
    wards: [ward('CO', 'Maple Ward', 'Maple Building')],
    buildings: [building('Maple Building', 6248)],
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

  it('extra-kindoo-calling on an AUTO seat returns one Add to SBA seat action', () => {
    // The callable appends to roster `callings[]`, correct for auto.
    const actions = fixActionsFor(
      discrepancy({
        code: 'extra-kindoo-calling',
        sba: { scope: 'CO', type: 'auto', callings: ['Sunday School Teacher'], buildingNames: [] },
      }),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ side: 'sba', testId: 'add-callings-sba' });
  });

  it('extra-kindoo-calling on a MANUAL seat returns no action (review-only)', () => {
    // Manual seats record their calling in `reason`, not `callings[]`;
    // appending to `callings[]` would mint a hybrid seat, so no
    // one-click fix — the operator reconciles `reason` in the web app.
    const actions = fixActionsFor(
      discrepancy({
        code: 'extra-kindoo-calling',
        sba: { scope: 'CO', type: 'manual', callings: [], reason: 'Greeter', buildingNames: [] },
      }),
    );
    expect(actions).toEqual([]);
  });

  it('extra-kindoo-calling on a TEMP seat returns no action (review-only)', () => {
    const actions = fixActionsFor(
      discrepancy({
        code: 'extra-kindoo-calling',
        sba: { scope: 'CO', type: 'temp', callings: [], reason: 'Visiting', buildingNames: [] },
      }),
    );
    expect(actions).toEqual([]);
  });

  it('scope-mismatch / buildings-mismatch each return two actions (Update Kindoo + Update SBA)', () => {
    for (const code of ['scope-mismatch', 'buildings-mismatch'] as const) {
      const actions = fixActionsFor(discrepancy({ code }));
      expect(actions).toHaveLength(2);
      expect(actions.map((a) => a.side)).toEqual(['kindoo', 'sba']);
    }
  });

  it('type-mismatch returns only an Update SBA action (grants own type; no Update Kindoo)', () => {
    const actions = fixActionsFor(discrepancy({ code: 'type-mismatch' }));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ side: 'sba', testId: 'update-sba' });
  });

  it('kindoo-unparseable returns no actions', () => {
    expect(fixActionsFor(discrepancy({ code: 'kindoo-unparseable' }))).toEqual([]);
  });
});

describe('buildCallableInput', () => {
  it('kindoo-only on an auto seat carries scope/type/callings + building names', () => {
    const input = buildCallableInput('csnorth', discrepancy({ code: 'kindoo-only' }));
    expect(input.stakeId).toBe('csnorth');
    expect(input.fix.code).toBe('kindoo-only');
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.memberEmail).toBe('a@example.com');
    expect(payload.memberName).toBe('Alice Person');
    expect(payload.scope).toBe('CO');
    expect(payload.type).toBe('auto');
    expect(payload.callings).toEqual(['Sunday School Teacher']);
    expect(payload.buildingNames).toEqual(['Maple Building']);
    expect(payload.isTempUser).toBe(false);
    // No reason on auto.
    expect(payload.reason).toBeUndefined();
  });

  it('kindoo-only church-backed creates an auto seat with derivedBuildings over buildingNames', () => {
    // Church-backed → auto (grantTargetType). The bulk-listing
    // AccessSchedules-derived `buildingNames` misses direct grants;
    // `derivedBuildings` is the truth.
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'kindoo-only',
        kindoo: kb({
          memberName: 'Auto Person',
          ruleIds: [],
          buildingNames: [],
          derivedBuildings: ['Maple Building', 'Pine Creek Building'],
          directGrantBuildings: ['Maple Building', 'Pine Creek Building'],
          grantTargetType: 'auto',
        }),
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.type).toBe('auto');
    expect(payload.buildingNames).toEqual(['Maple Building', 'Pine Creek Building']);
  });

  it('kindoo-only falls back to buildingNames when derivedBuildings is null (born manual)', () => {
    // Null derivation → not church-backed → manual; buildings fall back
    // to the AccessSchedules-derived set.
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'kindoo-only',
        kindoo: kb({
          description: 'Maple Ward (Building Greeter)',
          memberName: 'Auto Person',
          intendedType: 'manual',
          intendedCallings: [],
          intendedFreeText: 'Building Greeter',
          ruleIds: [6248],
          buildingNames: ['Maple Building'],
          derivedBuildings: null,
          directGrantBuildings: null,
          grantTargetType: 'manual',
        }),
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.type).toBe('manual');
    expect(payload.buildingNames).toEqual(['Maple Building']);
  });

  it('kindoo-only NOT church-backed creates a manual seat preferring derivedBuildings', () => {
    // Effective access exists (derivedBuildings=[Lexington]) but not via
    // a direct grant → manual. A Kindoo user with direct door grants but
    // empty AccessSchedules would otherwise seed an empty building set.
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'kindoo-only',
        kindoo: kb({
          description: 'Maple Ward (Building Greeter)',
          memberName: 'M M',
          intendedType: 'manual',
          intendedCallings: [],
          intendedFreeText: 'Building Greeter',
          ruleIds: [6248],
          buildingNames: [],
          derivedBuildings: ['Lexington'],
          directGrantBuildings: [],
          grantTargetType: 'manual',
        }),
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.type).toBe('manual');
    expect(payload.buildingNames).toEqual(['Lexington']);
  });

  it('kindoo-only manual carries all parsed callings + the free-text reason', () => {
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'kindoo-only',
        kindoo: kb({
          description: 'Maple Ward (Building Greeter, Janitor)',
          memberName: 'Mike Manual',
          intendedType: 'manual',
          intendedCallings: [],
          intendedFreeText: 'Building Greeter, Janitor',
          ruleIds: [6248],
          buildingNames: ['Maple Building'],
          derivedBuildings: null,
          directGrantBuildings: null,
          grantTargetType: 'manual',
        }),
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.callings).toEqual(['Building Greeter', 'Janitor']);
    expect(payload.reason).toBe('Building Greeter, Janitor');
    expect(payload.type).toBe('manual');
  });

  it('kindoo-only auto carries the full parsed calling list even when the classifier only matched a subset', () => {
    // Type is grant-derived (auto); callings = matched + unmatched =
    // the full parsed list, so a grant-promoted seat keeps every calling
    // Kindoo named rather than only the auto-template matches.
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'kindoo-only',
        kindoo: kb({
          description: 'Maple Ward (Sunday School Teacher, Accompanist)',
          intendedType: 'auto',
          intendedCallings: ['Sunday School Teacher'],
          intendedFreeText: 'Accompanist',
          derivedBuildings: ['Maple Building'],
          directGrantBuildings: ['Maple Building'],
          grantTargetType: 'auto',
        }),
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.type).toBe('auto');
    expect(payload.callings).toEqual(['Sunday School Teacher', 'Accompanist']);
    // Auto → no reason.
    expect(payload.reason).toBeUndefined();
  });

  it('kindoo-only temp carries startDate/endDate', () => {
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'kindoo-only',
        kindoo: kb({
          description: 'Maple Ward (Visiting speaker)',
          isTempUser: true,
          memberName: 'Tina Temp',
          intendedType: 'temp',
          intendedCallings: [],
          intendedFreeText: 'Visiting speaker',
          ruleIds: [6248],
          buildingNames: ['Maple Building'],
          derivedBuildings: null,
          directGrantBuildings: null,
          grantTargetType: 'temp',
          startDate: '2026-05-13',
          endDate: '2026-05-20',
        }),
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.type).toBe('temp');
    expect(payload.startDate).toBe('2026-05-13');
    expect(payload.endDate).toBe('2026-05-20');
    expect(payload.isTempUser).toBe(true);
  });

  it('extra-kindoo-calling sends the detector-supplied extraKindooCallings', () => {
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'extra-kindoo-calling',
        kindoo: kb({
          description: 'Maple Ward (Sunday School Teacher, Janitor, Greeter)',
          memberName: 'Eric Extra',
          intendedFreeText: '',
          extraKindooCallings: ['Janitor', 'Greeter'],
        }),
      }),
    );
    expect(input.fix.code).toBe('extra-kindoo-calling');
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.extraCallings).toEqual(['Janitor', 'Greeter']);
  });

  it('extra-kindoo-calling sends [] when the detector set no extras', () => {
    const input = buildCallableInput(
      'csnorth',
      discrepancy({ code: 'extra-kindoo-calling', kindoo: kb({}) }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.extraCallings).toEqual([]);
  });

  it('scope-mismatch sends Kindoo primary scope', () => {
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'scope-mismatch',
        sba: { scope: 'PC', type: 'auto', callings: [], buildingNames: [] },
        kindoo: kb({ memberName: 'S M' }),
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.newScope).toBe('CO');
  });

  it('type-mismatch promote sends grantTargetType=auto (NOT intendedType)', () => {
    // intendedType is template-derived (manual here); the payload must
    // carry the grant-derived target (auto).
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'type-mismatch',
        sba: { scope: 'CO', type: 'manual', callings: [], buildingNames: ['Maple Building'] },
        kindoo: kb({
          intendedType: 'manual',
          intendedCallings: [],
          intendedFreeText: 'Sunday School Teacher',
          derivedBuildings: ['Maple Building'],
          directGrantBuildings: ['Maple Building'],
          grantTargetType: 'auto',
        }),
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.newType).toBe('auto');
  });

  it('type-mismatch demote sends grantTargetType=manual', () => {
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'type-mismatch',
        sba: { scope: 'CO', type: 'auto', callings: [], buildingNames: ['Maple Building'] },
        kindoo: kb({
          derivedBuildings: ['Maple Building'],
          directGrantBuildings: [],
          grantTargetType: 'manual',
        }),
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.newType).toBe('manual');
  });

  it('type-mismatch throws when grantTargetType is absent', () => {
    // kb() leaves grantTargetType unset by default.
    expect(() =>
      buildCallableInput(
        'csnorth',
        discrepancy({
          code: 'type-mismatch',
          sba: { scope: 'CO', type: 'auto', callings: [], buildingNames: [] },
          kindoo: kb({}),
        }),
      ),
    ).toThrow(/grant-derived target type/i);
  });

  it('buildings-mismatch on a manual seat sends derivedBuildings, NOT AccessSchedules buildingNames', () => {
    // `derivedBuildings` (the door-grant chain) is the authoritative
    // Kindoo door-access truth for ALL seat types — it sees both direct
    // grants and rule-based grants. The AccessSchedules-derived
    // `buildingNames` misses direct grants, so it must never be the
    // source even on a manual seat.
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'buildings-mismatch',
        sba: { scope: 'CO', type: 'manual', callings: [], buildingNames: [] },
        kindoo: kb({
          description: 'Maple Ward (Building Greeter)',
          memberName: 'B M',
          intendedType: 'manual',
          intendedCallings: [],
          intendedFreeText: 'Building Greeter',
          ruleIds: [],
          buildingNames: [],
          derivedBuildings: ['Maple Building'],
        }),
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.newBuildingNames).toEqual(['Maple Building']);
  });

  it('buildings-mismatch on a manual seat with null derivedBuildings throws (no valid source — never wipe)', () => {
    // Regression guard: without door-grant derivation there is no
    // trustworthy source. Falling back to the empty AccessSchedules
    // `buildingNames` would wipe a seat that truly has access.
    expect(() =>
      buildCallableInput(
        'csnorth',
        discrepancy({
          code: 'buildings-mismatch',
          sba: { scope: 'CO', type: 'manual', callings: [], buildingNames: ['Maple Building'] },
          kindoo: kb({
            description: 'Maple Ward (Building Greeter)',
            memberName: 'B M',
            intendedType: 'manual',
            intendedCallings: [],
            intendedFreeText: 'Building Greeter',
            ruleIds: [6249],
            buildingNames: ['Pine Creek Building'],
            derivedBuildings: null,
          }),
        }),
      ),
    ).toThrow(/derivation/i);
  });

  it('buildings-mismatch on an auto seat sends derivedBuildings, NOT buildingNames', () => {
    // Auto seats: the bulk listing's AccessSchedules-derived
    // `buildingNames` excludes Church Access Automation direct grants
    // (empty for ~310 of 313 users). Sending `buildingNames` would wipe
    // the seat's correct buildings server-side. `derivedBuildings` is
    // the truth.
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'buildings-mismatch',
        sba: { scope: 'CO', type: 'auto', callings: [], buildingNames: ['Maple Building'] },
        kindoo: kb({
          memberName: 'A A',
          ruleIds: [],
          buildingNames: [],
          derivedBuildings: ['Maple Building', 'Pine Creek Building'],
        }),
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.newBuildingNames).toEqual(['Maple Building', 'Pine Creek Building']);
  });

  it('buildings-mismatch on an auto seat with null derivedBuildings throws (no valid source)', () => {
    expect(() =>
      buildCallableInput(
        'csnorth',
        discrepancy({
          code: 'buildings-mismatch',
          sba: { scope: 'CO', type: 'auto', callings: [], buildingNames: ['Maple Building'] },
          kindoo: kb({ memberName: 'A A', ruleIds: [], buildingNames: [], derivedBuildings: null }),
        }),
      ),
    ).toThrow(/derivation/i);
  });

  it('throws for sba-only (no SBA-side path)', () => {
    expect(() => buildCallableInput('csnorth', discrepancy({ code: 'sba-only' }))).toThrow();
  });

  it('throws for kindoo-unparseable (no SBA-side path)', () => {
    expect(() =>
      buildCallableInput('csnorth', discrepancy({ code: 'kindoo-unparseable' })),
    ).toThrow();
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
        buildingNames: ['Maple Building'],
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
        buildingNames: ['Maple Building'],
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
      sba: { scope: 'CO', type: 'auto', callings: [], buildingNames: ['Maple Building'] },
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
      sba: { scope: 'CO', type: 'auto', callings: [], buildingNames: ['Maple Building'] },
      kindoo: kb({ memberName: 'A A', ruleIds: [], buildingNames: [], derivedBuildings: null }),
    });
    const sbaAction = fixActionsFor(d).find((a) => a.side === 'sba')!;
    const outcome = await applyFix(d, sbaAction, ctx);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatch(/derivation/i);
    }
    expect(ctx.callSyncApplyFix).not.toHaveBeenCalled();
  });

  it('type-mismatch exposes only an Update SBA action (no Update Kindoo)', async () => {
    // Grants are the source of truth for type; the extension cannot
    // write church grants, so there is no Kindoo-side action.
    const d = discrepancy({
      code: 'type-mismatch',
      sba: { scope: 'CO', type: 'manual', callings: [], buildingNames: ['Maple Building'] },
      kindoo: kb({
        intendedType: 'manual',
        intendedCallings: [],
        intendedFreeText: 'Sunday School Teacher',
        derivedBuildings: ['Maple Building'],
        directGrantBuildings: ['Maple Building'],
        grantTargetType: 'auto',
      }),
    });
    const actions = fixActionsFor(d);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ side: 'sba', testId: 'update-sba' });
  });

  it('type-mismatch Update SBA dispatches the callable with the grant target', async () => {
    const ctx = ctxWith();
    const d = discrepancy({
      code: 'type-mismatch',
      sba: { scope: 'CO', type: 'manual', callings: [], buildingNames: ['Maple Building'] },
      kindoo: kb({
        intendedType: 'manual',
        intendedCallings: [],
        intendedFreeText: 'Sunday School Teacher',
        derivedBuildings: ['Maple Building'],
        directGrantBuildings: ['Maple Building'],
        grantTargetType: 'auto',
      }),
    });
    const action = fixActionsFor(d).find((a) => a.side === 'sba')!;
    const outcome = await applyFix(d, action, ctx);
    expect(outcome).toEqual({ ok: true });
    expect(ctx.callSyncApplyFix).toHaveBeenCalledTimes(1);
    const sent = (ctx.callSyncApplyFix as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.fix.code).toBe('type-mismatch');
    expect(sent.fix.payload.newType).toBe('auto');
    expect(ctx.syncProvisionFromSeat).not.toHaveBeenCalled();
  });
});
