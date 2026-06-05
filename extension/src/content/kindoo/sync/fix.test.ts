// Unit tests for the Sync Phase 2 fix dispatcher. Verifies:
//   - `fixActionsFor` returns the expected buttons per discrepancy code.
//   - `buildCallableInput` constructs the discriminated union payload
//     correctly for each fix.
//   - `applyFix` routes every code through the SBA-side callable mock
//     (Kindoo is authoritative — sync never writes SBA → Kindoo).

import { describe, expect, it, vi } from 'vitest';
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
    intendedType: 'manual',
    intendedCallings: ['Sunday School Teacher'],
    intendedFreeText: '',
    ruleIds: [6248],
    buildingNames: ['Maple Building'],
    derivedBuildings: null,
    directGrantBuildings: null,
    ...over,
  };
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
    callSyncApplyFix: vi.fn().mockResolvedValue({ success: true, seatId: 'a@example.com' }),
    ...overrides,
  };
}

describe('fixActionsFor', () => {
  it('sba-only returns one Remove From SBA danger action', () => {
    const actions = fixActionsFor(
      discrepancy({ code: 'sba-only', sba: {} as never, kindoo: null }),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      side: 'sba',
      testId: 'remove-sba',
      label: 'Remove From SBA',
      variant: 'danger',
    });
  });

  it('kindoo-only returns one Create SBA seat action', () => {
    const actions = fixActionsFor(discrepancy({ code: 'kindoo-only' }));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ side: 'sba', testId: 'create-sba' });
  });

  it('callings-mismatch returns one Update SBA action (auto-only by construction)', () => {
    // The detector only emits callings-mismatch for auto seats; the
    // callable REPLACES roster `callings[]` with Kindoo's full target
    // set. It's a true Update-SBA sibling — testId `update-sba`.
    const actions = fixActionsFor(
      discrepancy({
        code: 'callings-mismatch',
        sba: { scope: 'CO', type: 'auto', callings: ['Sunday School Teacher'], buildingNames: [] },
      }),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      side: 'sba',
      testId: 'update-sba',
      label: 'Update SBA',
    });
  });

  it('scope-mismatch / buildings-mismatch each return a single Update SBA action', () => {
    // Kindoo-authoritative: the "Update Kindoo" action is gone; only the
    // SBA-tracking action remains.
    for (const code of ['scope-mismatch', 'buildings-mismatch'] as const) {
      const actions = fixActionsFor(discrepancy({ code }));
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ side: 'sba', testId: 'update-sba' });
    }
  });

  it('type-mismatch returns only an Update SBA action (grants own type)', () => {
    const actions = fixActionsFor(discrepancy({ code: 'type-mismatch' }));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ side: 'sba', testId: 'update-sba' });
  });

  it('kindoo-unparseable (drift) returns one Update SBA action', () => {
    const actions = fixActionsFor(discrepancy({ code: 'kindoo-unparseable', severity: 'drift' }));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ side: 'sba', testId: 'update-sba', label: 'Update SBA' });
  });

  it('kindoo-unparseable (review) returns no actions', () => {
    // A review-severity unparseable row (the no-resolvable-primary-segment
    // defensive branch) is display-only; the review guard suppresses any
    // action so an Update SBA can never derive a corrupt calling.
    expect(fixActionsFor(discrepancy({ code: 'kindoo-unparseable', severity: 'review' }))).toEqual(
      [],
    );
  });

  it('kindoo-no-description (review) returns no actions', () => {
    expect(
      fixActionsFor(discrepancy({ code: 'kindoo-no-description', severity: 'review' })),
    ).toEqual([]);
  });

  it('a review kindoo-unparseable with a parens-bearing description offers no action (D)', () => {
    // The `!primary` defensive branch emits review even though the
    // description DID parse (carries scope + parens). No action button
    // means buildCallableInput is never called with it — its
    // scope-and-parens text can never reach the wire as a `calling`.
    expect(
      fixActionsFor(
        discrepancy({
          code: 'kindoo-unparseable',
          severity: 'review',
          kindoo: kb({ description: 'Maple Ward (Bishop)' }),
        }),
      ),
    ).toEqual([]);
  });

  it('any review-severity row returns no actions regardless of code (invariant)', () => {
    // Even a code that is normally actionable yields no buttons when the
    // detector marked the row review.
    for (const code of [
      'scope-mismatch',
      'type-mismatch',
      'buildings-mismatch',
      'callings-mismatch',
      'kindoo-unparseable',
    ] as const) {
      expect(fixActionsFor(discrepancy({ code, severity: 'review' }))).toEqual([]);
    }
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

  it('kindoo-only manual records the calling in reason with empty callings[] (spec.md §13 shape)', () => {
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
    // Manual seat: callings[] stays empty; the calling text lives in reason.
    expect(payload.callings).toEqual([]);
    expect(payload.reason).toBe('Building Greeter, Janitor');
    expect(payload.type).toBe('manual');
  });

  it('kindoo-only manual records the calling in reason even when the classifier matched it (no re-fire loop)', () => {
    // Classifier matched the calling to a template (intendedFreeText
    // empty) but the user is NOT church-backed → manual. The calling
    // must still land in `reason` (the §6.1 manual shape), with an empty
    // callings[] — callings-mismatch is auto-only, so a manual seat never
    // re-surfaces on the calling diff regardless. Keeps the spec.md §13
    // shape.
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'kindoo-only',
        kindoo: kb({
          description: 'Maple Ward (Sunday School Teacher)',
          memberName: 'Matched Manual',
          intendedType: 'manual',
          intendedCallings: ['Sunday School Teacher'],
          intendedFreeText: '',
          ruleIds: [6248],
          buildingNames: ['Maple Building'],
          derivedBuildings: ['Maple Building'],
          directGrantBuildings: [],
          grantTargetType: 'manual',
        }),
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.type).toBe('manual');
    expect(payload.callings).toEqual([]);
    expect(payload.reason).toBe('Sunday School Teacher');
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
          intendedType: 'manual',
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

  it('callings-mismatch sends the detector-supplied FULL Kindoo target set (REPLACE, not delta)', () => {
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'callings-mismatch',
        displayEmail: 'eric@example.com',
        kindoo: kb({
          description: 'Maple Ward (Sunday School Teacher, Janitor, Greeter)',
          memberName: 'Eric Extra',
          intendedFreeText: '',
          kindooCallings: ['Sunday School Teacher', 'Janitor', 'Greeter'],
        }),
      }),
    );
    expect(input.fix.code).toBe('callings-mismatch');
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.memberEmail).toBe('eric@example.com');
    expect(payload.callings).toEqual(['Sunday School Teacher', 'Janitor', 'Greeter']);
  });

  it('callings-mismatch throws on an empty Kindoo target set (callable rejects empty callings)', () => {
    expect(() =>
      buildCallableInput('csnorth', discrepancy({ code: 'callings-mismatch', kindoo: kb({}) })),
    ).toThrow(/empty Kindoo target/);
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

  it('type-mismatch promote sends grantTargetType=auto + the Kindoo-parsed callings', () => {
    // intendedType is template-derived (manual here); the payload must
    // carry the grant-derived target (auto) AND the Kindoo-parsed
    // calling(s) the promoted auto seat should carry. Here the classifier
    // matched nothing, so the calling rides in intendedFreeText.
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
    expect(payload.callings).toEqual(['Sunday School Teacher']);
  });

  it('type-mismatch promote carries the FULL parsed calling list (matched ∪ unmatched)', () => {
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'type-mismatch',
        sba: { scope: 'CO', type: 'manual', callings: [], buildingNames: ['Maple Building'] },
        kindoo: kb({
          description: 'Maple Ward (Sunday School Teacher, Accompanist)',
          intendedType: 'manual',
          intendedCallings: ['Sunday School Teacher'],
          intendedFreeText: 'Accompanist',
          derivedBuildings: ['Maple Building'],
          directGrantBuildings: ['Maple Building'],
          grantTargetType: 'auto',
        }),
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.newType).toBe('auto');
    expect(payload.callings).toEqual(['Sunday School Teacher', 'Accompanist']);
  });

  it('type-mismatch demote sends grantTargetType=manual and OMITS callings', () => {
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'type-mismatch',
        sba: {
          scope: 'CO',
          type: 'auto',
          callings: ['Sunday School Teacher'],
          buildingNames: ['Maple Building'],
        },
        kindoo: kb({
          intendedCallings: ['Sunday School Teacher'],
          derivedBuildings: ['Maple Building'],
          directGrantBuildings: [],
          grantTargetType: 'manual',
        }),
      }),
    );
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload.newType).toBe('manual');
    // Demote derives reason from existing callings server-side; no
    // callings in the payload.
    expect(payload.callings).toBeUndefined();
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

  it('sba-only builds the Remove From SBA payload from the seat email', () => {
    // Kindoo-authoritative remove: the kindoo block is null, so the
    // typed email rides on `displayEmail`. The backend canonicalizes it
    // to locate the orphaned seat.
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'sba-only',
        displayEmail: 'Orphan.Seat@Example.com',
        sba: { scope: 'CO', type: 'auto', callings: [], buildingNames: ['Maple Building'] },
        kindoo: null,
      }),
    );
    expect(input.stakeId).toBe('csnorth');
    expect(input.fix.code).toBe('sba-only');
    const payload = input.fix.payload as Record<string, unknown>;
    expect(payload).toEqual({ memberEmail: 'Orphan.Seat@Example.com' });
  });

  it('kindoo-unparseable sends the raw Kindoo description as the church-wide calling', () => {
    const input = buildCallableInput(
      'csnorth',
      discrepancy({
        code: 'kindoo-unparseable',
        displayEmail: 'Weird.User@Example.com',
        sba: { scope: 'CO', type: 'manual', callings: [], buildingNames: ['Maple Building'] },
        kindoo: kb({ description: '  Stake Technology Specialist  ' }),
      }),
    );
    expect(input.stakeId).toBe('csnorth');
    expect(input.fix.code).toBe('kindoo-unparseable');
    expect(input.fix.payload).toEqual({
      memberEmail: 'Weird.User@Example.com',
      // Trimmed from the raw Kindoo description.
      calling: 'Stake Technology Specialist',
    });
  });

  it('kindoo-unparseable throws when the Kindoo description is whitespace-only', () => {
    expect(() =>
      buildCallableInput(
        'csnorth',
        discrepancy({ code: 'kindoo-unparseable', kindoo: kb({ description: '   ' }) }),
      ),
    ).toThrow(/empty Kindoo description/);
  });

  it('throws for kindoo-no-description (review-only, no SBA-side callable path)', () => {
    expect(() =>
      buildCallableInput('csnorth', discrepancy({ code: 'kindoo-no-description' })),
    ).toThrow();
  });
});

describe('applyFix', () => {
  it('calls the callable wrapper and returns ok on success', async () => {
    const ctx = ctxWith();
    const action = fixActionsFor(discrepancy({ code: 'kindoo-only' }))[0]!;
    const outcome = await applyFix(discrepancy({ code: 'kindoo-only' }), action, ctx);
    expect(outcome).toEqual({ ok: true });
    expect(ctx.callSyncApplyFix).toHaveBeenCalledTimes(1);
  });

  it('surfaces the callable error envelope', async () => {
    const ctx = ctxWith({
      callSyncApplyFix: vi.fn().mockResolvedValue({ success: false, error: 'seat not found' }),
    });
    const action = fixActionsFor(discrepancy({ code: 'kindoo-only' }))[0]!;
    const outcome = await applyFix(discrepancy({ code: 'kindoo-only' }), action, ctx);
    expect(outcome).toEqual({ ok: false, error: 'seat not found' });
  });

  it('sba-only Remove From SBA dispatches the delete callable', async () => {
    const ctx = ctxWith();
    const d = discrepancy({
      code: 'sba-only',
      displayEmail: 'orphan@example.com',
      sba: { scope: 'CO', type: 'auto', callings: [], buildingNames: ['Maple Building'] },
      kindoo: null,
    });
    const action = fixActionsFor(d)[0]!;
    const outcome = await applyFix(d, action, ctx);
    expect(outcome).toEqual({ ok: true });
    expect(ctx.callSyncApplyFix).toHaveBeenCalledTimes(1);
    const sent = (ctx.callSyncApplyFix as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.fix.code).toBe('sba-only');
    expect(sent.fix.payload).toEqual({ memberEmail: 'orphan@example.com' });
  });

  it('wraps a thrown callable error as a flat error', async () => {
    const ctx = ctxWith({
      callSyncApplyFix: vi.fn().mockRejectedValue(new Error('SW 500')),
    });
    const action = fixActionsFor(discrepancy({ code: 'kindoo-only' }))[0]!;
    const outcome = await applyFix(discrepancy({ code: 'kindoo-only' }), action, ctx);
    expect(outcome).toEqual({ ok: false, error: 'SW 500' });
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

  it('type-mismatch exposes only an Update SBA action (no Update Kindoo)', () => {
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
  });
});
