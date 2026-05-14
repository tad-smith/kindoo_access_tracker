// Integration tests for the `syncApplyFix` callable. Each invocation
// applies one per-row Fix from the Sync Phase 2 drift report; tests
// here cover the five SBA-side discrepancy codes plus auth + shape
// guards. Audit-row fan-out is exercised via a direct invocation of
// `auditSeatWrites` against the observed before/after — same pattern
// the `markRequestComplete` test file uses for its audit smoke check.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { AuditLog, Seat } from '@kindoo/shared';
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
}): Promise<void> {
  const { db } = requireEmulators();
  const canonical = opts.canonical ?? MEMBER_EMAIL;
  await db.doc(`stakes/${STAKE_ID}/seats/${canonical}`).set({
    member_canonical: canonical,
    member_email: canonical,
    member_name: 'Alice',
    scope: opts.scope ?? 'CO',
    type: opts.type ?? 'manual',
    callings: opts.callings ?? [],
    building_names: opts.building_names ?? ['Cordera Building'],
    duplicate_grants: [],
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    last_modified_by: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
    lastActor: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
  });
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
                buildingNames: ['Cordera Building'],
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
      expect(seat.building_names).toEqual(['Cordera Building']);
      expect(seat.duplicate_grants).toEqual([]);
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
                buildingNames: ['Cordera Building'],
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
                buildingNames: ['Cordera Building'],
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
                buildingNames: ['Cordera Building'],
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
                  buildingNames: ['Cordera Building'],
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
        building_names: ['Cordera Building'],
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
      expect(seat.building_names).toEqual(['Cordera Building']);
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
    it('updates only type; other fields untouched', async () => {
      await seedManager();
      await seedSeat({
        scope: 'CO',
        type: 'manual',
        callings: ['Ward Clerk'],
        building_names: ['Cordera Building'],
      });
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'type-mismatch',
              payload: { memberEmail: MEMBER_EMAIL, newType: 'auto' },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });
      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).data() as Seat;
      expect(seat.type).toBe('auto');
      expect(seat.scope).toBe('CO');
      expect(seat.callings).toEqual(['Ward Clerk']);
      expect(seat.building_names).toEqual(['Cordera Building']);
      expect(seat.lastActor).toEqual({
        email: 'SyncActor:type-mismatch',
        canonical: 'SyncActor:type-mismatch',
      });
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
        building_names: ['Cordera Building', 'Briargate Building'],
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
                buildingNames: ['Cordera Building'],
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
