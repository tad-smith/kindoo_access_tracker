// Integration tests for the `syncApplyFix` callable. Each invocation
// applies one per-row Fix from the Sync Phase 2 drift report; tests
// here cover the five SBA-side discrepancy codes plus auth + shape
// guards. Audit-row fan-out is exercised via a direct invocation of
// `auditSeatWrites` against the observed before/after — same pattern
// the `markRequestComplete` test file uses for its audit smoke check.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { Access, AuditLog, Seat } from '@kindoo/shared';
import { syncApplyFix } from '../src/callable/syncApplyFix.js';
import { auditSeatWrites } from '../src/triggers/auditTrigger.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'csnorth';
const MANAGER_EMAIL = 'mgr@gmail.com';
const MEMBER_EMAIL = 'alice@gmail.com';

async function seedManager(opts: { active?: boolean; email?: string } = {}): Promise<void> {
  const { db } = requireEmulators();
  const email = opts.email ?? MANAGER_EMAIL;
  await db.doc(`stakes/${STAKE_ID}/kindooManagers/${email}`).set({
    member_canonical: email,
    member_email: email,
    name: email,
    active: opts.active ?? true,
    added_at: Timestamp.now(),
    added_by: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
    lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  });
}

async function seedSeat(opts: {
  canonical?: string;
  scope?: string;
  type?: Seat['type'];
  callings?: string[];
  building_names?: string[];
  sort_order?: number | null;
}): Promise<void> {
  const { db } = requireEmulators();
  const canonical = opts.canonical ?? MEMBER_EMAIL;
  const body: Record<string, unknown> = {
    member_canonical: canonical,
    member_email: canonical,
    member_name: 'Alice',
    scope: opts.scope ?? 'CO',
    type: opts.type ?? 'manual',
    callings: opts.callings ?? [],
    building_names: opts.building_names ?? ['Maple Building'],
    duplicate_grants: [],
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    last_modified_by: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
    lastActor: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
  };
  if (opts.sort_order !== undefined) body.sort_order = opts.sort_order;
  await db.doc(`stakes/${STAKE_ID}/seats/${canonical}`).set(body);
}

/**
 * Seed a calling-template doc. Default scope='CO' writes to
 * `wardCallingTemplates`; scope='stake' writes to
 * `stakeCallingTemplates`. The collection split mirrors the importer's
 * shape (stake-wide ward templates + per-stake stake templates).
 */
async function seedTemplate(opts: {
  scope?: 'stake' | string;
  calling_name: string;
  give_app_access?: boolean;
  auto_kindoo_access?: boolean;
  sheet_order?: number;
}): Promise<void> {
  const { db } = requireEmulators();
  const scope = opts.scope ?? 'CO';
  const collection = scope === 'stake' ? 'stakeCallingTemplates' : 'wardCallingTemplates';
  // Use the calling name URL-encoded as the doc ID; matches firebase-schema.md §§4.8–4.9.
  const docId = encodeURIComponent(opts.calling_name);
  await db.doc(`stakes/${STAKE_ID}/${collection}/${docId}`).set({
    calling_name: opts.calling_name,
    give_app_access: opts.give_app_access ?? false,
    auto_kindoo_access: opts.auto_kindoo_access ?? true,
    sheet_order: opts.sheet_order ?? 0,
    created_at: Timestamp.now(),
    lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  });
}

async function seedAccess(opts: {
  canonical?: string;
  importer_callings?: Record<string, string[]>;
  manual_grants?: Record<string, Access['manual_grants'][string]>;
  sort_order?: number | null;
}): Promise<void> {
  const { db } = requireEmulators();
  const canonical = opts.canonical ?? MEMBER_EMAIL;
  const body: Record<string, unknown> = {
    member_canonical: canonical,
    member_email: canonical,
    member_name: 'Alice',
    importer_callings: opts.importer_callings ?? {},
    manual_grants: opts.manual_grants ?? {},
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    last_modified_by: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
    lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  };
  if (opts.sort_order !== undefined) body.sort_order = opts.sort_order;
  await db.doc(`stakes/${STAKE_ID}/access/${canonical}`).set(body);
}

function callableReq(opts: { auth?: { email: string } | null; data: unknown }): never {
  return {
    data: opts.data,
    auth: opts.auth ? { uid: opts.auth.email, token: { email: opts.auth.email } } : undefined,
    rawRequest: {} as unknown,
    acceptsStreaming: false,
  } as unknown as never;
}

describe.skipIf(!hasEmulators())('syncApplyFix callable', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  // ----- Auth + shape guards -----

  it('rejects an unauthenticated caller with unauthenticated', async () => {
    await expect(
      syncApplyFix.run(
        callableReq({
          auth: null,
          data: {
            stakeId: STAKE_ID,
            fix: { code: 'scope-mismatch', payload: { memberEmail: MEMBER_EMAIL, newScope: 'CO' } },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a signed-in non-manager with permission-denied', async () => {
    await seedSeat({});
    await expect(
      syncApplyFix.run(
        callableReq({
          auth: { email: 'outsider@gmail.com' },
          data: {
            stakeId: STAKE_ID,
            fix: { code: 'scope-mismatch', payload: { memberEmail: MEMBER_EMAIL, newScope: 'CO' } },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects a manager whose record is inactive with permission-denied', async () => {
    await seedManager({ active: false });
    await seedSeat({});
    await expect(
      syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: { code: 'scope-mismatch', payload: { memberEmail: MEMBER_EMAIL, newScope: 'CO' } },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects a missing stakeId with invalid-argument', async () => {
    await seedManager();
    await expect(
      syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            fix: { code: 'scope-mismatch', payload: { memberEmail: MEMBER_EMAIL, newScope: 'CO' } },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects an unknown fix code with invalid-argument', async () => {
    await seedManager();
    await expect(
      syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, fix: { code: 'made-up', payload: {} } },
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a manager whose stake claim is wrong (no manager doc under that stake)', async () => {
    // Seed the manager under a different stake so the doc lookup under
    // the requested stakeId comes up empty.
    const { db } = requireEmulators();
    await db.doc(`stakes/other-stake/kindooManagers/${MANAGER_EMAIL}`).set({
      member_canonical: MANAGER_EMAIL,
      member_email: MANAGER_EMAIL,
      name: MANAGER_EMAIL,
      active: true,
      added_at: Timestamp.now(),
      added_by: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
      lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
    });
    await expect(
      syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: { code: 'scope-mismatch', payload: { memberEmail: MEMBER_EMAIL, newScope: 'CO' } },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  // ----- kindoo-only -----

  describe("code='kindoo-only'", () => {
    it('creates a new seat with SyncActor stamp on lastActor', async () => {
      await seedManager();
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'kindoo-only',
              payload: {
                memberEmail: MEMBER_EMAIL,
                memberName: 'Alice',
                scope: 'CO',
                type: 'auto',
                callings: ['Ward Clerk'],
                buildingNames: ['Maple Building'],
                isTempUser: false,
              },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).data() as Seat;
      expect(seat.scope).toBe('CO');
      expect(seat.type).toBe('auto');
      expect(seat.callings).toEqual(['Ward Clerk']);
      expect(seat.building_names).toEqual(['Maple Building']);
      expect(seat.duplicate_grants).toEqual([]);
      // T-42 / T-43: server-maintained primitive mirror of
      // `duplicate_grants[].scope` is always set, even when empty.
      expect(seat.duplicate_scopes).toEqual([]);
      expect(seat.lastActor).toEqual({
        email: 'SyncActor:kindoo-only',
        canonical: 'SyncActor:kindoo-only',
      });
      expect(seat.last_modified_by).toEqual(seat.lastActor);
    });

    it('returns soft failure when a seat already exists for the canonical email', async () => {
      await seedManager();
      await seedSeat({});
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'kindoo-only',
              payload: {
                memberEmail: MEMBER_EMAIL,
                memberName: 'Alice',
                scope: 'CO',
                type: 'manual',
                callings: [],
                buildingNames: ['Maple Building'],
                isTempUser: false,
              },
            },
          },
        }),
      );
      expect(result).toEqual({
        success: false,
        error: 'seat already exists for that member',
      });
      // Original seat untouched.
      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).data() as Seat;
      expect(seat.lastActor).toEqual({ email: MANAGER_EMAIL, canonical: MANAGER_EMAIL });
    });

    it('canonicalizes the typed memberEmail (gmail dots + casing)', async () => {
      await seedManager();
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'kindoo-only',
              payload: {
                memberEmail: 'A.L.I.C.E+work@Gmail.com',
                memberName: 'Alice',
                scope: 'stake',
                type: 'manual',
                callings: [],
                buildingNames: ['Maple Building'],
                reason: 'sub teacher',
                isTempUser: false,
              },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: 'alice@gmail.com' });
      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(seat.member_canonical).toBe('alice@gmail.com');
      expect(seat.member_email).toBe('A.L.I.C.E+work@Gmail.com');
      expect(seat.reason).toBe('sub teacher');
    });

    it('writes start_date / end_date only for type=temp', async () => {
      await seedManager();
      await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'kindoo-only',
              payload: {
                memberEmail: MEMBER_EMAIL,
                memberName: 'Alice',
                scope: 'CO',
                type: 'temp',
                callings: [],
                buildingNames: ['Maple Building'],
                startDate: '2026-06-01',
                endDate: '2026-06-30',
                isTempUser: true,
              },
            },
          },
        }),
      );
      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).data() as Seat;
      expect(seat.type).toBe('temp');
      expect(seat.start_date).toBe('2026-06-01');
      expect(seat.end_date).toBe('2026-06-30');
    });

    it('rejects an invalid seat type with invalid-argument', async () => {
      await seedManager();
      await expect(
        syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'kindoo-only',
                payload: {
                  memberEmail: MEMBER_EMAIL,
                  memberName: 'Alice',
                  scope: 'CO',
                  type: 'bogus',
                  callings: [],
                  buildingNames: ['Maple Building'],
                  isTempUser: false,
                },
              },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });
  });

  // ----- extra-kindoo-calling -----

  describe("code='extra-kindoo-calling'", () => {
    it('appends extras to existing seat.callings preserving order + de-duping', async () => {
      await seedManager();
      await seedSeat({ callings: ['Ward Clerk', 'Sunday School Teacher'] });
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'extra-kindoo-calling',
              payload: {
                memberEmail: MEMBER_EMAIL,
                extraCallings: ['Ward Clerk', 'Elders Quorum President'],
              },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });
      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).data() as Seat;
      // Existing entries preserved; duplicate dropped; new entry appended.
      expect(seat.callings).toEqual([
        'Ward Clerk',
        'Sunday School Teacher',
        'Elders Quorum President',
      ]);
      expect(seat.lastActor).toEqual({
        email: 'SyncActor:extra-kindoo-calling',
        canonical: 'SyncActor:extra-kindoo-calling',
      });
    });

    it('returns soft failure when the seat is missing', async () => {
      await seedManager();
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'extra-kindoo-calling',
              payload: {
                memberEmail: MEMBER_EMAIL,
                extraCallings: ['Ward Clerk'],
              },
            },
          },
        }),
      );
      expect(result).toEqual({ success: false, error: 'seat not found' });
    });

    it('is a no-op when every extra is already present (returns success without bumping lastActor)', async () => {
      await seedManager();
      await seedSeat({ callings: ['Ward Clerk', 'Sunday School Teacher'] });
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'extra-kindoo-calling',
              payload: {
                memberEmail: MEMBER_EMAIL,
                extraCallings: ['Ward Clerk'],
              },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });
      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).data() as Seat;
      // No write applied — original lastActor preserved.
      expect(seat.lastActor).toEqual({ email: MANAGER_EMAIL, canonical: MANAGER_EMAIL });
      expect(seat.callings).toEqual(['Ward Clerk', 'Sunday School Teacher']);
    });
  });

  // ----- scope-mismatch -----

  describe("code='scope-mismatch'", () => {
    it('updates only scope; other fields untouched', async () => {
      await seedManager();
      await seedSeat({
        scope: 'CO',
        type: 'manual',
        callings: ['Ward Clerk'],
        building_names: ['Maple Building'],
      });
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'scope-mismatch',
              payload: { memberEmail: MEMBER_EMAIL, newScope: 'stake' },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });
      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).data() as Seat;
      expect(seat.scope).toBe('stake');
      // Untouched axes:
      expect(seat.type).toBe('manual');
      expect(seat.callings).toEqual(['Ward Clerk']);
      expect(seat.building_names).toEqual(['Maple Building']);
      expect(seat.lastActor).toEqual({
        email: 'SyncActor:scope-mismatch',
        canonical: 'SyncActor:scope-mismatch',
      });
    });

    it('returns soft failure when the seat is missing', async () => {
      await seedManager();
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'scope-mismatch',
              payload: { memberEmail: MEMBER_EMAIL, newScope: 'stake' },
            },
          },
        }),
      );
      expect(result).toEqual({ success: false, error: 'seat not found' });
    });
  });

  // ----- type-mismatch -----

  describe("code='type-mismatch'", () => {
    it('promote (manual → auto): scope + buildings untouched, type flips, lastActor stamped', async () => {
      await seedManager();
      // Well-formed manual seat: callings empty, calling in reason (§13).
      await seedSeat({
        scope: 'CO',
        type: 'manual',
        callings: [],
        building_names: ['Maple Building'],
      });
      await requireEmulators().db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).update({
        reason: 'Ward Clerk',
      });
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'type-mismatch',
              payload: { memberEmail: MEMBER_EMAIL, newType: 'auto', callings: ['Ward Clerk'] },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });
      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).data() as Seat;
      expect(seat.type).toBe('auto');
      expect(seat.scope).toBe('CO');
      // Untouched axes:
      expect(seat.building_names).toEqual(['Maple Building']);
      expect(seat.lastActor).toEqual({
        email: 'SyncActor:type-mismatch',
        canonical: 'SyncActor:type-mismatch',
      });
    });

    // ----- Seat reshape on the type flip (§13 convention) -----
    //
    // Auto seats carry the calling in `callings[]` with empty `reason`;
    // manual / temp seats carry `callings: []` with the calling in
    // free-text `reason`. The flip reshapes the seat so it never lands
    // in a spec-violating hybrid state.

    it('promote: shapes a clean auto seat — callings from payload, reason cleared', async () => {
      await seedManager();
      // Well-formed manual seat: callings empty, calling in reason.
      await seedSeat({ scope: 'CO', type: 'manual', callings: [] });
      const { db } = requireEmulators();
      await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).update({ reason: 'Building Sub' });

      await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'type-mismatch',
              payload: {
                memberEmail: MEMBER_EMAIL,
                newType: 'auto',
                // Kindoo-parsed calling(s) the extension sends on promote;
                // duplicate proves server-side dedupe.
                callings: ['Bishop', 'Bishop', 'Ward Clerk'],
              },
            },
          },
        }),
      );

      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & {
        reason?: unknown;
      };
      expect(seat.type).toBe('auto');
      // callings sourced from the payload, deduped, order preserved.
      expect(seat.callings).toEqual(['Bishop', 'Ward Clerk']);
      // stale manual reason cleared so the seat is a well-formed auto seat.
      expect(seat.reason).toBeUndefined();
    });

    it('promote: falls back to [seat.reason] when the payload omits callings', async () => {
      await seedManager();
      await seedSeat({ scope: 'CO', type: 'manual', callings: [] });
      const { db } = requireEmulators();
      await db
        .doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`)
        .update({ reason: 'Stake Technology Specialist' });

      await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            // No `callings` on the payload — fall back to the reason.
            fix: { code: 'type-mismatch', payload: { memberEmail: MEMBER_EMAIL, newType: 'auto' } },
          },
        }),
      );

      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & {
        reason?: unknown;
      };
      expect(seat.type).toBe('auto');
      expect(seat.callings).toEqual(['Stake Technology Specialist']);
      expect(seat.reason).toBeUndefined();
    });

    it('promote: empty callings + empty reason yields callings: [] (orphan auto seat)', async () => {
      await seedManager();
      // No reason at all on the seat.
      await seedSeat({ scope: 'CO', type: 'manual', callings: [] });

      await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'type-mismatch',
              payload: { memberEmail: MEMBER_EMAIL, newType: 'auto', callings: [] },
            },
          },
        }),
      );

      const { db } = requireEmulators();
      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & {
        reason?: unknown;
      };
      expect(seat.type).toBe('auto');
      expect(seat.callings).toEqual([]);
      expect(seat.reason).toBeUndefined();
    });

    it('demote (auto → manual): shapes a clean manual seat — reason from callings, callings cleared', async () => {
      await seedManager();
      await seedSeat({
        scope: 'CO',
        type: 'auto',
        callings: ['Bishop', 'Ward Clerk'],
        sort_order: 5,
      });

      await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'type-mismatch',
              payload: { memberEmail: MEMBER_EMAIL, newType: 'manual' },
            },
          },
        }),
      );

      const { db } = requireEmulators();
      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & {
        reason?: unknown;
        sort_order?: unknown;
      };
      expect(seat.type).toBe('manual');
      // reason folds the joined callings; callings cleared (manual convention).
      expect(seat.reason).toBe('Bishop, Ward Clerk');
      expect(seat.callings).toEqual([]);
      // sort_order removed (manual seats carry none).
      expect(seat.sort_order).toBeUndefined();
    });

    it('demote (auto → temp): folds callings into reason and clears callings', async () => {
      await seedManager();
      await seedSeat({
        scope: 'CO',
        type: 'auto',
        callings: ['Sunday School Teacher'],
        sort_order: 9,
      });

      await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: { code: 'type-mismatch', payload: { memberEmail: MEMBER_EMAIL, newType: 'temp' } },
          },
        }),
      );

      const { db } = requireEmulators();
      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & {
        reason?: unknown;
      };
      expect(seat.type).toBe('temp');
      expect(seat.reason).toBe('Sunday School Teacher');
      expect(seat.callings).toEqual([]);
    });

    it('rejects an invalid newType with invalid-argument', async () => {
      await seedManager();
      await seedSeat({});
      await expect(
        syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'type-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, newType: 'bogus' },
              },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });
  });

  // ----- buildings-mismatch -----

  describe("code='buildings-mismatch'", () => {
    it('replaces building_names wholesale; other fields untouched', async () => {
      await seedManager();
      await seedSeat({
        scope: 'CO',
        type: 'manual',
        callings: ['Ward Clerk'],
        building_names: ['Maple Building', 'Briargate Building'],
      });
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'buildings-mismatch',
              payload: {
                memberEmail: MEMBER_EMAIL,
                newBuildingNames: ['Lexington Building'],
              },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });
      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).data() as Seat;
      // Full replacement — original buildings dropped.
      expect(seat.building_names).toEqual(['Lexington Building']);
      expect(seat.scope).toBe('CO');
      expect(seat.type).toBe('manual');
      expect(seat.callings).toEqual(['Ward Clerk']);
      expect(seat.lastActor).toEqual({
        email: 'SyncActor:buildings-mismatch',
        canonical: 'SyncActor:buildings-mismatch',
      });
    });

    it('returns soft failure when the seat is missing', async () => {
      await seedManager();
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'buildings-mismatch',
              payload: {
                memberEmail: MEMBER_EMAIL,
                newBuildingNames: ['Lexington Building'],
              },
            },
          },
        }),
      );
      expect(result).toEqual({ success: false, error: 'seat not found' });
    });

    it('rejects an empty newBuildingNames and leaves the seat unchanged', async () => {
      await seedManager();
      await seedSeat({
        scope: 'CO',
        type: 'manual',
        callings: ['Ward Clerk'],
        building_names: ['Lexington Building'],
      });
      await expect(
        syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'buildings-mismatch',
                payload: {
                  memberEmail: MEMBER_EMAIL,
                  newBuildingNames: [],
                },
              },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).data() as Seat;
      // Guardrail held — the seat's buildings are untouched.
      expect(seat.building_names).toEqual(['Lexington Building']);
    });

    it('rejects newBuildingNames that clean to empty and leaves the seat unchanged', async () => {
      await seedManager();
      await seedSeat({
        scope: 'CO',
        type: 'manual',
        callings: ['Ward Clerk'],
        building_names: ['Lexington Building'],
      });
      await expect(
        syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'buildings-mismatch',
                payload: {
                  memberEmail: MEMBER_EMAIL,
                  newBuildingNames: ['', '   ', '\t'],
                },
              },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).data() as Seat;
      expect(seat.building_names).toEqual(['Lexington Building']);
    });
  });

  // ----- sba-only (Remove From SBA — Kindoo-authoritative orphan delete) -----
  //
  // Kindoo is authoritative: an SBA seat with no Kindoo presence is an
  // orphan, so the fix DELETES it. The common case is a plain delete;
  // when the seat carries duplicate_grants[] (other-site / other-scope
  // access) we promote the first duplicate instead of nuking it.
  //
  // Both branches re-read + re-validate the seat inside a transaction.
  // The orphan branch's in-tx re-assert ("duplicate appeared between the
  // outer read and the delete → soft-fail 'seat changed concurrently'")
  // can't be reached via the seed seam: a seat that already has
  // duplicates routes to the promote branch on the outer read, never the
  // orphan branch. The re-assert is the guard against true mid-call
  // concurrency, which we don't fake-inject — no test theater.

  describe("code='sba-only'", () => {
    it('deletes the orphaned seat and returns success + seatId', async () => {
      await seedManager();
      await seedSeat({ scope: 'CO', type: 'manual' });
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: { code: 'sba-only', payload: { memberEmail: MEMBER_EMAIL } },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });
      const { db } = requireEmulators();
      const seatSnap = await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get();
      // Seat is gone.
      expect(seatSnap.exists).toBe(false);
    });

    it('returns soft failure when the seat is missing', async () => {
      await seedManager();
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: { code: 'sba-only', payload: { memberEmail: MEMBER_EMAIL } },
          },
        }),
      );
      expect(result).toEqual({ success: false, error: 'seat not found' });
    });

    it('canonicalizes the typed memberEmail to locate the seat', async () => {
      await seedManager();
      await seedSeat({ canonical: 'alice@gmail.com', scope: 'CO', type: 'manual' });
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: { code: 'sba-only', payload: { memberEmail: 'A.L.I.C.E+work@Gmail.com' } },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: 'alice@gmail.com' });
      const { db } = requireEmulators();
      const seatSnap = await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get();
      expect(seatSnap.exists).toBe(false);
    });

    it('promotes the first duplicate to primary instead of deleting when duplicate_grants exist', async () => {
      await seedManager();
      const { db } = requireEmulators();
      // Seat with a parallel-site duplicate grant — the member holds
      // other-site access we must not nuke. Removing the primary should
      // promote the duplicate, not delete the doc.
      await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).set({
        member_canonical: MEMBER_EMAIL,
        member_email: MEMBER_EMAIL,
        member_name: 'Alice',
        scope: 'CO',
        type: 'manual',
        callings: [],
        reason: 'primary reason',
        building_names: ['Maple Building'],
        kindoo_site_id: 'home',
        granted_by_request: 'r-original',
        duplicate_grants: [
          {
            scope: 'DZ',
            type: 'temp',
            callings: ['Sub Teacher'],
            reason: 'dupe reason',
            start_date: '2026-06-01',
            end_date: '2026-06-30',
            building_names: ['Briargate Building'],
            kindoo_site_id: 'site-dz',
            detected_at: Timestamp.now(),
          },
        ],
        duplicate_scopes: ['DZ'],
        created_at: Timestamp.now(),
        last_modified_at: Timestamp.now(),
        last_modified_by: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
        lastActor: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
      });

      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: { code: 'sba-only', payload: { memberEmail: MEMBER_EMAIL } },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & {
        granted_by_request?: unknown;
      };
      // Doc survives — the duplicate was promoted to primary.
      expect(seat.scope).toBe('DZ');
      expect(seat.type).toBe('temp');
      expect(seat.callings).toEqual(['Sub Teacher']);
      expect(seat.reason).toBe('dupe reason');
      expect(seat.start_date).toBe('2026-06-01');
      expect(seat.end_date).toBe('2026-06-30');
      expect(seat.building_names).toEqual(['Briargate Building']);
      expect(seat.kindoo_site_id).toBe('site-dz');
      // Duplicate consumed; primitive mirror in sync.
      expect(seat.duplicate_grants).toEqual([]);
      expect(seat.duplicate_scopes).toEqual([]);
      // granted_by_request cleared (justified the removed primary).
      expect(seat.granted_by_request).toBeUndefined();
      expect(seat.lastActor).toEqual({
        email: 'SyncActor:sba-only',
        canonical: 'SyncActor:sba-only',
      });
    });

    // ----- Access reap (Kindoo-authoritative: drop calling-derived
    // app access when the orphan seat is removed) -----
    //
    // `syncAccessClaims` grants SBA app access off `importer_callings`.
    // Removing an auto orphan must reap the removed scope's
    // `importer_callings` so the member loses access — unless they still
    // hold a justification (a manual grant, or another scope's calling).

    it('auto orphan: reaps the only access grant — access doc deleted', async () => {
      await seedManager();
      // Auto orphan whose access is justified solely by importer_callings[CO].
      await seedSeat({ scope: 'CO', type: 'auto', callings: ['Bishop'], sort_order: 5 });
      await seedAccess({ importer_callings: { CO: ['Bishop'] }, sort_order: 5 });

      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: { code: 'sba-only', payload: { memberEmail: MEMBER_EMAIL } },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

      const { db } = requireEmulators();
      // Seat gone.
      expect((await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).exists).toBe(false);
      // Access doc deleted — no surviving justification, so the member
      // loses SBA app access on the next claims sync.
      expect((await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()).exists).toBe(false);
    });

    it('auto orphan with a manual grant: access doc survives, manual_grants intact, only importer_callings[scope] cleared', async () => {
      await seedManager();
      await seedSeat({ scope: 'CO', type: 'auto', callings: ['Bishop'], sort_order: 5 });
      await seedAccess({
        importer_callings: { CO: ['Bishop'] },
        manual_grants: {
          CO: [
            {
              grant_id: 'grant-1',
              reason: 'deliberate manager grant',
              granted_by: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
              granted_at: Timestamp.now(),
            },
          ],
        },
        sort_order: 5,
      });

      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: { code: 'sba-only', payload: { memberEmail: MEMBER_EMAIL } },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

      const { db } = requireEmulators();
      expect((await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).exists).toBe(false);
      const access = (
        await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
      ).data() as Access;
      // Calling-derived grant cleared; deliberate manual grant preserved.
      expect(access.importer_callings).toEqual({});
      expect(access.manual_grants.CO?.length).toBe(1);
      // Reap stamped by the Sync actor (matches the demote path's helper).
      expect(access.lastActor).toEqual({
        email: 'SyncActor:sba-only',
        canonical: 'SyncActor:sba-only',
      });
    });

    it("auto orphan with another scope's calling: access doc survives, only the removed scope's importer_callings cleared", async () => {
      await seedManager();
      await seedSeat({ scope: 'CO', type: 'auto', callings: ['Bishop'], sort_order: 5 });
      // The member also has calling-derived access under 'stake' — a
      // justification that must survive removing the CO seat.
      await seedAccess({
        importer_callings: { CO: ['Bishop'], stake: ['Stake Clerk'] },
        sort_order: 5,
      });

      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: { code: 'sba-only', payload: { memberEmail: MEMBER_EMAIL } },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

      const { db } = requireEmulators();
      const access = (
        await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
      ).data() as Access;
      // Only CO cleared; the stake-scope justification survives.
      expect(access.importer_callings).toEqual({ stake: ['Stake Clerk'] });
    });

    it('manual orphan: reap is a no-op on a manual-grant-only access doc', async () => {
      await seedManager();
      // Manual orphan: a manual seat carries no importer_callings, so the
      // reap clears nothing. A member with a manual grant keeps access.
      await seedSeat({ scope: 'CO', type: 'manual' });
      await seedAccess({
        importer_callings: {},
        manual_grants: {
          CO: [
            {
              grant_id: 'grant-1',
              reason: 'deliberate manager grant',
              granted_by: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
              granted_at: Timestamp.now(),
            },
          ],
        },
      });

      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: { code: 'sba-only', payload: { memberEmail: MEMBER_EMAIL } },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

      const { db } = requireEmulators();
      expect((await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).exists).toBe(false);
      const access = (
        await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
      ).data() as Access;
      // Access doc survives untouched — the manual grant keeps SBA access.
      expect(access.manual_grants.CO?.length).toBe(1);
      expect(access.importer_callings).toEqual({});
    });

    it('promote: reaps the REMOVED primary scope from access while the promoted scope survives', async () => {
      await seedManager();
      const { db } = requireEmulators();
      // Auto seat at CO with a parallel-site auto duplicate at DZ; the
      // member's access doc carries calling-derived grants for BOTH
      // scopes. Removing the CO primary promotes DZ and must reap only CO.
      await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).set({
        member_canonical: MEMBER_EMAIL,
        member_email: MEMBER_EMAIL,
        member_name: 'Alice',
        scope: 'CO',
        type: 'auto',
        callings: ['Bishop'],
        building_names: ['Maple Building'],
        kindoo_site_id: 'home',
        sort_order: 5,
        duplicate_grants: [
          {
            scope: 'DZ',
            type: 'auto',
            callings: ['Elders Quorum President'],
            building_names: ['Briargate Building'],
            kindoo_site_id: 'site-dz',
            detected_at: Timestamp.now(),
          },
        ],
        duplicate_scopes: ['DZ'],
        created_at: Timestamp.now(),
        last_modified_at: Timestamp.now(),
        last_modified_by: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
        lastActor: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
      });
      await seedAccess({
        importer_callings: { CO: ['Bishop'], DZ: ['Elders Quorum President'] },
        sort_order: 5,
      });

      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: { code: 'sba-only', payload: { memberEmail: MEMBER_EMAIL } },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

      // Seat promoted to DZ.
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).data() as Seat;
      expect(seat.scope).toBe('DZ');
      const access = (
        await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
      ).data() as Access;
      // Removed primary (CO) reaped; promoted scope (DZ) survives.
      expect(access.importer_callings).toEqual({ DZ: ['Elders Quorum President'] });
    });
  });

  // ----- Importer parity: sort_order + access-doc bookkeeping -----
  //
  // The seat-create / seat-mutate paths in `syncApplyFix` must leave
  // Firestore in the same shape the LCR Sheet importer would produce
  // on its next run. See the PARITY note at the top of
  // `functions/src/callable/syncApplyFix.ts` and the mirror notes in
  // `functions/src/services/Importer.ts` + `functions/src/lib/diff.ts`.
  // These tests cover sort_order stamping and `access`-doc fan-out for
  // `give_app_access` templates across the three apply paths that can
  // turn a seat auto.

  describe('importer parity (auto-seat sort_order + access bookkeeping)', () => {
    describe("code='kindoo-only' on auto seats", () => {
      it('stamps sort_order = MIN(sheet_order) and writes access docs for give_app_access templates', async () => {
        await seedManager();
        await seedTemplate({
          scope: 'CO',
          calling_name: 'Bishop',
          give_app_access: true,
          sheet_order: 10,
        });
        await seedTemplate({
          scope: 'CO',
          calling_name: 'Ward Clerk',
          give_app_access: true,
          sheet_order: 3,
        });
        await seedTemplate({
          scope: 'CO',
          calling_name: 'Sunday School Teacher',
          give_app_access: false,
          sheet_order: 50,
        });

        const result = await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'kindoo-only',
                payload: {
                  memberEmail: MEMBER_EMAIL,
                  memberName: 'Alice',
                  scope: 'CO',
                  type: 'auto',
                  callings: ['Bishop', 'Ward Clerk', 'Sunday School Teacher'],
                  buildingNames: ['Maple Building'],
                  isTempUser: false,
                },
              },
            },
          }),
        );
        expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat;
        // MIN(10, 3, 50) = 3.
        expect(seat.sort_order).toBe(3);

        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        // Only the two give_app_access=true callings should appear under
        // importer_callings[CO]; the give_app_access=false one is dropped.
        // Sorted alphabetically per the importer's contract.
        expect(access.importer_callings).toEqual({ CO: ['Bishop', 'Ward Clerk'] });
        expect(access.manual_grants).toEqual({});
        expect(access.sort_order).toBe(3);
        expect(access.lastActor).toEqual({
          email: 'SyncActor:kindoo-only',
          canonical: 'SyncActor:kindoo-only',
        });
      });

      it('writes no access doc when no calling matches a give_app_access template; sort_order may be null', async () => {
        await seedManager();
        // No templates seeded — every calling is an orphan.
        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'kindoo-only',
                payload: {
                  memberEmail: MEMBER_EMAIL,
                  memberName: 'Alice',
                  scope: 'CO',
                  type: 'auto',
                  callings: ['Unknown Calling'],
                  buildingNames: ['Maple Building'],
                  isTempUser: false,
                },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat;
        // Orphan auto seat: sort_order is null (no template matches).
        expect(seat.sort_order).toBe(null);
        const accessSnap = await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get();
        expect(accessSnap.exists).toBe(false);
      });
    });

    describe("code='kindoo-only' on non-auto seats", () => {
      it('manual: writes no sort_order and no access doc even when templates exist', async () => {
        await seedManager();
        await seedTemplate({
          scope: 'CO',
          calling_name: 'Bishop',
          give_app_access: true,
          sheet_order: 1,
        });
        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'kindoo-only',
                payload: {
                  memberEmail: MEMBER_EMAIL,
                  memberName: 'Alice',
                  scope: 'CO',
                  type: 'manual',
                  callings: [],
                  buildingNames: ['Maple Building'],
                  isTempUser: false,
                },
              },
            },
          }),
        );
        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat & { sort_order?: unknown };
        expect(seat.type).toBe('manual');
        // No sort_order field stamped at all for non-auto.
        expect(seat.sort_order).toBeUndefined();
        const accessSnap = await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get();
        expect(accessSnap.exists).toBe(false);
      });

      it('temp: writes no sort_order and no access doc even when templates exist', async () => {
        await seedManager();
        await seedTemplate({
          scope: 'CO',
          calling_name: 'Bishop',
          give_app_access: true,
          sheet_order: 1,
        });
        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'kindoo-only',
                payload: {
                  memberEmail: MEMBER_EMAIL,
                  memberName: 'Alice',
                  scope: 'CO',
                  type: 'temp',
                  callings: [],
                  buildingNames: ['Maple Building'],
                  startDate: '2026-06-01',
                  endDate: '2026-06-30',
                  isTempUser: true,
                },
              },
            },
          }),
        );
        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat & { sort_order?: unknown };
        expect(seat.type).toBe('temp');
        expect(seat.sort_order).toBeUndefined();
        const accessSnap = await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get();
        expect(accessSnap.exists).toBe(false);
      });
    });

    describe("code='extra-kindoo-calling'", () => {
      it('on auto: writes access doc for newly-appended give_app_access calling and recomputes sort_order if smaller', async () => {
        await seedManager();
        await seedTemplate({
          scope: 'CO',
          calling_name: 'Ward Clerk',
          give_app_access: false,
          sheet_order: 10,
        });
        await seedTemplate({
          scope: 'CO',
          calling_name: 'Bishop',
          give_app_access: true,
          sheet_order: 2,
        });
        await seedSeat({
          scope: 'CO',
          type: 'auto',
          callings: ['Ward Clerk'],
          sort_order: 10,
        });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'extra-kindoo-calling',
                payload: { memberEmail: MEMBER_EMAIL, extraCallings: ['Bishop'] },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat;
        expect(seat.callings).toEqual(['Ward Clerk', 'Bishop']);
        // MIN(Ward Clerk=10, Bishop=2) = 2; sort_order recomputed.
        expect(seat.sort_order).toBe(2);

        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        expect(access.importer_callings).toEqual({ CO: ['Bishop'] });
        expect(access.sort_order).toBe(2);
      });

      it('on manual: leaves sort_order absent and writes no access doc even when give_app_access templates match', async () => {
        await seedManager();
        await seedTemplate({
          scope: 'CO',
          calling_name: 'Bishop',
          give_app_access: true,
          sheet_order: 1,
        });
        await seedSeat({ scope: 'CO', type: 'manual', callings: [] });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'extra-kindoo-calling',
                payload: { memberEmail: MEMBER_EMAIL, extraCallings: ['Bishop'] },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat & { sort_order?: unknown };
        expect(seat.callings).toEqual(['Bishop']);
        expect(seat.sort_order).toBeUndefined();
        const accessSnap = await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get();
        expect(accessSnap.exists).toBe(false);
      });
    });

    describe("code='type-mismatch' flipping to auto", () => {
      it('manual → auto: stamps sort_order from the payload callings, writes access doc for give_app_access matches', async () => {
        await seedManager();
        await seedTemplate({
          scope: 'CO',
          calling_name: 'Bishop',
          give_app_access: true,
          sheet_order: 5,
        });
        // Well-formed manual seat: callings empty, calling in reason.
        await seedSeat({ scope: 'CO', type: 'manual', callings: [] });
        const { db } = requireEmulators();
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).update({ reason: 'Bishop' });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'type-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, newType: 'auto', callings: ['Bishop'] },
              },
            },
          }),
        );

        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat & { reason?: unknown };
        expect(seat.type).toBe('auto');
        // Reshaped to a well-formed auto seat: callings populated, reason gone.
        expect(seat.callings).toEqual(['Bishop']);
        expect(seat.reason).toBeUndefined();
        // sort_order derived from the (reshaped) callings.
        expect(seat.sort_order).toBe(5);

        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        expect(access.importer_callings).toEqual({ CO: ['Bishop'] });
        expect(access.sort_order).toBe(5);
      });

      it('manual → auto with no payload callings: sort_order + access doc derive from the reason fallback', async () => {
        await seedManager();
        await seedTemplate({
          scope: 'CO',
          calling_name: 'Bishop',
          give_app_access: true,
          sheet_order: 7,
        });
        await seedSeat({ scope: 'CO', type: 'manual', callings: [] });
        const { db } = requireEmulators();
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).update({ reason: 'Bishop' });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              // No payload callings — fall back to [reason] = ['Bishop'].
              fix: {
                code: 'type-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, newType: 'auto' },
              },
            },
          }),
        );

        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat;
        expect(seat.callings).toEqual(['Bishop']);
        expect(seat.sort_order).toBe(7);
        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        expect(access.importer_callings).toEqual({ CO: ['Bishop'] });
      });

      it('idempotent: re-applying the same promote yields the same seat + access shape', async () => {
        await seedManager();
        await seedTemplate({
          scope: 'CO',
          calling_name: 'Bishop',
          give_app_access: true,
          sheet_order: 5,
        });
        await seedSeat({ scope: 'CO', type: 'manual', callings: [] });
        const { db } = requireEmulators();
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).update({ reason: 'Bishop' });

        const payload = { memberEmail: MEMBER_EMAIL, newType: 'auto', callings: ['Bishop'] };
        const first = await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: { stakeId: STAKE_ID, fix: { code: 'type-mismatch', payload } },
          }),
        );
        // Second apply — seat is already auto; reshape is a no-op-equivalent.
        const second = await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: { stakeId: STAKE_ID, fix: { code: 'type-mismatch', payload } },
          }),
        );
        expect(first).toEqual({ success: true, seatId: MEMBER_EMAIL });
        expect(second).toEqual({ success: true, seatId: MEMBER_EMAIL });

        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat & { reason?: unknown };
        expect(seat.type).toBe('auto');
        expect(seat.callings).toEqual(['Bishop']);
        expect(seat.reason).toBeUndefined();
        expect(seat.sort_order).toBe(5);

        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        expect(access.importer_callings).toEqual({ CO: ['Bishop'] });
      });
    });

    describe("code='type-mismatch' flipping away from auto", () => {
      it('auto → manual with no manual_grants: clears sort_order and deletes the access doc', async () => {
        await seedManager();
        await seedTemplate({
          scope: 'CO',
          calling_name: 'Bishop',
          give_app_access: true,
          sheet_order: 5,
        });
        await seedSeat({
          scope: 'CO',
          type: 'auto',
          callings: ['Bishop'],
          sort_order: 5,
        });
        await seedAccess({
          importer_callings: { CO: ['Bishop'] },
          sort_order: 5,
        });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'type-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, newType: 'manual' },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat & { sort_order?: unknown; reason?: unknown };
        expect(seat.type).toBe('manual');
        // FieldValue.delete() removed sort_order entirely.
        expect(seat.sort_order).toBeUndefined();
        // Reshaped to a well-formed manual seat: reason folded, callings cleared.
        expect(seat.reason).toBe('Bishop');
        expect(seat.callings).toEqual([]);

        const accessSnap = await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get();
        expect(accessSnap.exists).toBe(false);
      });

      it('auto → manual with manual_grants present: clears sort_order and clears importer_callings[scope] but keeps the doc', async () => {
        await seedManager();
        await seedTemplate({
          scope: 'CO',
          calling_name: 'Bishop',
          give_app_access: true,
          sheet_order: 5,
        });
        await seedSeat({
          scope: 'CO',
          type: 'auto',
          callings: ['Bishop'],
          sort_order: 5,
        });
        await seedAccess({
          importer_callings: { CO: ['Bishop'] },
          manual_grants: {
            CO: [
              {
                grant_id: 'grant-1',
                reason: 'Bishop training',
                granted_by: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
                granted_at: Timestamp.now(),
              },
            ],
          },
          sort_order: 5,
        });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'type-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, newType: 'manual' },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        // importer_callings[CO] dropped; manual_grants preserved; doc remains.
        expect(access.importer_callings).toEqual({});
        expect(access.manual_grants.CO?.length).toBe(1);
        expect(access.sort_order).toBe(null);
        expect(access.lastActor).toEqual({
          email: 'SyncActor:type-mismatch',
          canonical: 'SyncActor:type-mismatch',
        });
      });
    });
  });

  // ----- Audit fan-out smoke check -----
  //
  // The audit trigger is wired to onDocumentWritten so it does not
  // fire under callable .run(). Mirror the markRequestComplete pattern:
  // invoke `auditSeatWrites` directly against the observed before/after
  // and assert the audit row carries the SyncActor stamp.

  describe('audit fan-out', () => {
    it('kindoo-only seat creation produces an audit row with actor_email=SyncActor:kindoo-only', async () => {
      await seedManager();
      const { db } = requireEmulators();
      const beforeSnap = await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get();
      expect(beforeSnap.exists).toBe(false);

      await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'kindoo-only',
              payload: {
                memberEmail: MEMBER_EMAIL,
                memberName: 'Alice',
                scope: 'CO',
                type: 'manual',
                callings: [],
                buildingNames: ['Maple Building'],
                isTempUser: false,
              },
            },
          },
        }),
      );

      const afterSnap = await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get();
      const after = afterSnap.data() as Seat;

      const time = '2026-05-13T18:00:00.000Z';
      const event = {
        params: { stakeId: STAKE_ID, memberCanonical: MEMBER_EMAIL },
        time,
        data: {
          before: { exists: false, data: () => undefined },
          after: { exists: true, data: () => after },
        },
      } as unknown as never;
      await auditSeatWrites.run(event);

      const audit = await db.collection(`stakes/${STAKE_ID}/auditLog`).get();
      expect(audit.empty).toBe(false);
      const row = audit.docs[0]!.data() as AuditLog;
      expect(row.entity_type).toBe('seat');
      expect(row.entity_id).toBe(MEMBER_EMAIL);
      expect(row.action).toBe('create_seat');
      expect(row.actor_email).toBe('SyncActor:kindoo-only');
      expect(row.actor_canonical).toBe('SyncActor:kindoo-only');
    });

    it('sba-only delete produces a delete_seat audit row attributed to SyncActor:sba-only', async () => {
      await seedManager();
      await seedSeat({ scope: 'CO', type: 'manual' });
      const { db } = requireEmulators();

      await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: { code: 'sba-only', payload: { memberEmail: MEMBER_EMAIL } },
          },
        }),
      );

      // Seat is gone after the delete.
      expect((await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).exists).toBe(false);

      // The delete path stamps `lastActor: SyncActor:sba-only` on the seat
      // immediately before deleting, so the audit trigger (which reads
      // BEFORE on a delete) attributes the row to the Sync actor. Mirror
      // that BEFORE snapshot here; AFTER is null (deleted).
      const before = {
        member_canonical: MEMBER_EMAIL,
        member_email: MEMBER_EMAIL,
        member_name: 'Alice',
        scope: 'CO',
        type: 'manual',
        callings: [],
        building_names: ['Maple Building'],
        duplicate_grants: [],
        lastActor: { email: 'SyncActor:sba-only', canonical: 'SyncActor:sba-only' },
        last_modified_by: { email: 'SyncActor:sba-only', canonical: 'SyncActor:sba-only' },
      };
      const time = '2026-05-13T18:00:00.000Z';
      const event = {
        params: { stakeId: STAKE_ID, memberCanonical: MEMBER_EMAIL },
        time,
        data: {
          before: { exists: true, data: () => before },
          after: { exists: false, data: () => undefined },
        },
      } as unknown as never;
      await auditSeatWrites.run(event);

      const audit = await db.collection(`stakes/${STAKE_ID}/auditLog`).get();
      expect(audit.empty).toBe(false);
      const row = audit.docs[0]!.data() as AuditLog;
      expect(row.entity_type).toBe('seat');
      expect(row.entity_id).toBe(MEMBER_EMAIL);
      expect(row.action).toBe('delete_seat');
      expect(row.actor_email).toBe('SyncActor:sba-only');
      expect(row.actor_canonical).toBe('SyncActor:sba-only');
    });

    it('sba-only promote produces an update_seat audit row attributed to SyncActor:sba-only', async () => {
      await seedManager();
      const { db } = requireEmulators();
      // Seat with a duplicate grant so removal promotes (a real tx.update)
      // rather than deleting.
      await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).set({
        member_canonical: MEMBER_EMAIL,
        member_email: MEMBER_EMAIL,
        member_name: 'Alice',
        scope: 'CO',
        type: 'manual',
        callings: [],
        reason: 'primary reason',
        building_names: ['Maple Building'],
        duplicate_grants: [
          {
            scope: 'DZ',
            type: 'temp',
            callings: ['Sub Teacher'],
            building_names: ['Briargate Building'],
            detected_at: Timestamp.now(),
          },
        ],
        duplicate_scopes: ['DZ'],
        created_at: Timestamp.now(),
        last_modified_at: Timestamp.now(),
        last_modified_by: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
        lastActor: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
      });
      const before = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat;

      await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: { code: 'sba-only', payload: { memberEmail: MEMBER_EMAIL } },
          },
        }),
      );

      const after = (await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).data() as Seat;
      // Promoted, not deleted.
      expect(after.scope).toBe('DZ');

      const time = '2026-05-13T18:00:00.000Z';
      const event = {
        params: { stakeId: STAKE_ID, memberCanonical: MEMBER_EMAIL },
        time,
        data: {
          before: { exists: true, data: () => before },
          after: { exists: true, data: () => after },
        },
      } as unknown as never;
      await auditSeatWrites.run(event);

      const audit = await db.collection(`stakes/${STAKE_ID}/auditLog`).get();
      expect(audit.empty).toBe(false);
      const row = audit.docs[0]!.data() as AuditLog;
      expect(row.entity_type).toBe('seat');
      expect(row.entity_id).toBe(MEMBER_EMAIL);
      expect(row.action).toBe('update_seat');
      expect(row.actor_email).toBe('SyncActor:sba-only');
      expect(row.actor_canonical).toBe('SyncActor:sba-only');
    });

    it('scope-mismatch update produces an audit row with actor_email=SyncActor:scope-mismatch', async () => {
      await seedManager();
      await seedSeat({ scope: 'CO' });
      const { db } = requireEmulators();
      const beforeSnap = await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get();
      const before = beforeSnap.data() as Seat;

      await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'scope-mismatch',
              payload: { memberEmail: MEMBER_EMAIL, newScope: 'stake' },
            },
          },
        }),
      );

      const afterSnap = await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get();
      const after = afterSnap.data() as Seat;

      const time = '2026-05-13T18:00:00.000Z';
      const event = {
        params: { stakeId: STAKE_ID, memberCanonical: MEMBER_EMAIL },
        time,
        data: {
          before: { exists: true, data: () => before },
          after: { exists: true, data: () => after },
        },
      } as unknown as never;
      await auditSeatWrites.run(event);

      const audit = await db.collection(`stakes/${STAKE_ID}/auditLog`).get();
      expect(audit.empty).toBe(false);
      const row = audit.docs[0]!.data() as AuditLog;
      expect(row.entity_type).toBe('seat');
      expect(row.action).toBe('update_seat');
      expect(row.actor_email).toBe('SyncActor:scope-mismatch');
      expect(row.actor_canonical).toBe('SyncActor:scope-mismatch');
    });
  });
});
