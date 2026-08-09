// Integration tests for the `syncApplyFix` callable. Each invocation
// applies one per-row Fix from the Sync Phase 2 drift report; tests
// here cover the five SBA-side discrepancy codes plus auth + shape
// guards. Audit-row fan-out is exercised via a direct invocation of
// `auditSeatWrites` against the observed before/after — same pattern
// the `markRequestComplete` test file uses for its audit smoke check.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { EQ_PRESIDENT_CALLING, auditId, callingSortOrder, seatCallingOrder } from '@kindoo/shared';
import type { Access, AuditLog, Seat } from '@kindoo/shared';
import { syncApplyFix } from '../src/callable/syncApplyFix.js';
import { auditSeatWrites } from '../src/triggers/auditTrigger.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'csnorth';
const MANAGER_EMAIL = 'mgr@gmail.com';
const MEMBER_EMAIL = 'alice@gmail.com';

// Canonical calling-order indices, DERIVED from the shared table rather
// than pinned. Each is a position in a list that grows: the branch
// callings interleaving into the unit band (T-96) shifted the unit
// entries below once already, and a literal turns the next such edit into
// a wall of off-by-N assertions that says nothing about what changed.
const BISHOP_ORDER = callingSortOrder('Bishop');
const BISHOPRIC_1C_ORDER = callingSortOrder('Bishopric First Counselor');
const WARD_CLERK_ORDER = callingSortOrder('Ward Clerk');
const STAKE_CLERK_ORDER = callingSortOrder('Stake Clerk');
const EQP_ORDER = seatCallingOrder([EQ_PRESIDENT_CALLING]);

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

/**
 * Seed the stake parent doc. Most of this suite deliberately does NOT
 * call this — the callable's stake read must default the Elders Quorum
 * President gate to OFF on a missing doc, and the unseeded tests pin
 * that. Pass `eqPresidentAccess` to exercise the gate explicitly.
 */
async function seedStake(opts: { eqPresidentAccess?: boolean } = {}): Promise<void> {
  const { db } = requireEmulators();
  const body: Record<string, unknown> = {
    stake_name: 'Cottonwood South Stake',
    bootstrap_admin_email: 'admin@gmail.com',
    setup_complete: true,
    stake_seat_cap: 0,
    timezone: 'America/Denver',
    notifications_enabled: true,
    last_over_caps_json: [],
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    last_modified_by: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
    lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  };
  if (opts.eqPresidentAccess !== undefined) {
    body.eq_president_app_access = opts.eqPresidentAccess;
  }
  await db.doc(`stakes/${STAKE_ID}`).set(body);
}

async function seedSeat(opts: {
  canonical?: string;
  scope?: string;
  type?: Seat['type'];
  callings?: string[];
  building_names?: string[];
  sort_order?: number | null;
  organization_id?: string | null;
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
  if (opts.organization_id !== undefined) body.organization_id = opts.organization_id;
  await db.doc(`stakes/${STAKE_ID}/seats/${canonical}`).set(body);
}

async function seedAccess(opts: {
  canonical?: string;
  importer_callings?: Record<string, string[]>;
  /** Omit to seed the pre-D26 shape — no tier stamp at all. */
  importer_limited_callings?: Record<string, string[]>;
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
  if (opts.importer_limited_callings !== undefined) {
    body.importer_limited_callings = opts.importer_limited_callings;
  }
  await db.doc(`stakes/${STAKE_ID}/access/${canonical}`).set(body);
}

/**
 * Seed a unit doc. A unit's Kindoo site derives from its building, and
 * its KIND derives from `ward_name` alone (D31) — pass a name ending in
 * `" Branch"` to seed a branch.
 */
async function seedWard(opts: {
  ward_code: string;
  ward_name?: string;
  building_name?: string;
}): Promise<void> {
  const { db } = requireEmulators();
  await db.doc(`stakes/${STAKE_ID}/wards/${opts.ward_code}`).set({
    ward_code: opts.ward_code,
    ward_name: opts.ward_name ?? `${opts.ward_code} Ward`,
    building_name: opts.building_name ?? `${opts.ward_code} Building`,
    seat_cap: 0,
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  });
}

/** Seed a building doc. `kindoo_site_id` null/absent = home site. */
async function seedBuilding(opts: {
  building_name: string;
  kindoo_site_id?: string | null;
}): Promise<void> {
  const { db } = requireEmulators();
  const body: Record<string, unknown> = {
    building_id: opts.building_name.toLowerCase().replace(/\s+/g, '-'),
    building_name: opts.building_name,
    address: '123 Test St',
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  };
  if (opts.kindoo_site_id !== undefined) body.kindoo_site_id = opts.kindoo_site_id;
  await db.doc(`stakes/${STAKE_ID}/buildings/${body.building_id as string}`).set(body);
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

    // B-23 — an existing seat DOC is not a collision. `kindoo-only` means
    // "no grant on the ACTIVE Kindoo site", and seats are keyed by
    // canonical email (one per member per stake), so a member whose only
    // grant lives on another site still has a doc. The grant merges onto
    // it as a parallel-site `duplicate_grants[]` entry.
    describe('merge onto an existing seat (B-23)', () => {
      it('appends a parallel-site grant, leaving the home-site primary untouched', async () => {
        await seedManager();
        // The production repro: Kettle Creek meets in Black Forest, which
        // a foreign Kindoo site governs. The member's seat is stake-scope
        // — home-only by policy (§15) — so it can never satisfy a
        // foreign-site row, and the foreign run reports `kindoo-only`.
        await seedWard({
          ward_code: 'KC',
          ward_name: 'Kettle Creek Ward',
          building_name: 'Black Forest',
        });
        await seedBuilding({ building_name: 'Black Forest', kindoo_site_id: 'high-plains' });
        await seedSeat({
          scope: 'stake',
          type: 'auto',
          callings: ['Stake Clerk'],
          building_names: ['Lexington Building'],
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
                  scope: 'KC',
                  type: 'auto',
                  callings: ['Elders Quorum Second Counselor'],
                  buildingNames: ['Black Forest'],
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
        // Primary identity is never modified by a merge.
        expect(seat.scope).toBe('stake');
        expect(seat.type).toBe('auto');
        expect(seat.callings).toEqual(['Stake Clerk']);
        expect(seat.building_names).toEqual(['Lexington Building']);
        expect(seat.kindoo_site_id).toBeUndefined();
        // The Kindoo grant lands as a duplicate carrying its OWN site.
        expect(seat.duplicate_grants).toHaveLength(1);
        const dup = seat.duplicate_grants[0]!;
        expect(dup.scope).toBe('KC');
        expect(dup.type).toBe('auto');
        expect(dup.callings).toEqual(['Elders Quorum Second Counselor']);
        expect(dup.building_names).toEqual(['Black Forest']);
        expect(dup.kindoo_site_id).toBe('high-plains');
        expect(dup.detected_at).toBeDefined();
        expect(seat.duplicate_scopes).toEqual(['KC']);
        expect(seat.lastActor).toEqual({
          email: 'SyncActor:kindoo-only',
          canonical: 'SyncActor:kindoo-only',
        });
      });

      it('carries reason + dates onto a merged temp grant', async () => {
        await seedManager();
        await seedWard({ ward_code: 'MR', building_name: 'Black Forest' });
        await seedBuilding({ building_name: 'Black Forest', kindoo_site_id: 'east-stake' });
        await seedSeat({ scope: 'stake', type: 'manual', building_names: ['Lexington Building'] });

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
                  scope: 'MR',
                  type: 'temp',
                  callings: [],
                  buildingNames: ['Black Forest'],
                  reason: 'Scout camp setup',
                  startDate: '2026-08-01',
                  endDate: '2026-08-31',
                  isTempUser: true,
                },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat;
        const dup = seat.duplicate_grants[0]!;
        expect(dup.type).toBe('temp');
        expect(dup.reason).toBe('Scout camp setup');
        expect(dup.start_date).toBe('2026-08-01');
        expect(dup.end_date).toBe('2026-08-31');
        // §6.1: temp grants carry the calling in `reason`, not `callings`.
        expect(dup.callings).toBeUndefined();
      });

      it('reconciles the merged scope in the access doc, preserving other scopes', async () => {
        await seedManager();
        await seedWard({ ward_code: 'MR', building_name: 'Black Forest' });
        await seedBuilding({ building_name: 'Black Forest', kindoo_site_id: 'east-stake' });
        await seedSeat({ scope: 'stake', type: 'auto', callings: ['Stake Clerk'] });
        await seedAccess({
          importer_callings: { stake: ['Stake Clerk'] },
          sort_order: STAKE_CLERK_ORDER,
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
                  scope: 'MR',
                  type: 'auto',
                  callings: ['Ward Clerk'],
                  buildingNames: ['Black Forest'],
                  isTempUser: false,
                },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        expect(access.importer_callings).toEqual({
          stake: ['Stake Clerk'],
          MR: ['Ward Clerk'],
        });
        // Both callings rank, so the doc keeps the smaller of the two.
        expect(access.sort_order).toBe(Math.min(STAKE_CLERK_ORDER!, WARD_CLERK_ORDER!));
      });

      it('merges into the matching grant and corrects its stale site stamp', async () => {
        await seedManager();
        // A primary that already names this scope but carries a stale HOME
        // stamp: the detector could not project it onto the foreign site,
        // so the row came back as `kindoo-only`. Merging has to correct the
        // stamp — otherwise the identical row re-emits on every run.
        await seedWard({ ward_code: 'MR', building_name: 'Black Forest' });
        await seedBuilding({ building_name: 'Black Forest', kindoo_site_id: 'east-stake' });
        await seedSeat({ scope: 'MR', type: 'manual', building_names: ['Maple Building'] });
        const { db } = requireEmulators();
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).update({ kindoo_site_id: null });

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
                  scope: 'MR',
                  type: 'manual',
                  callings: [],
                  buildingNames: ['Black Forest'],
                  isTempUser: false,
                },
              },
            },
          }),
        );

        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat;
        expect(seat.building_names).toEqual(['Maple Building', 'Black Forest']);
        expect(seat.kindoo_site_id).toBe('east-stake');
        // Matched in place — no second grant for the same (scope, type).
        expect(seat.duplicate_grants).toEqual([]);
      });

      it('merges into a matching duplicate grant and rebuilds the scope mirror', async () => {
        await seedManager();
        await seedWard({ ward_code: 'MR', building_name: 'Black Forest' });
        await seedBuilding({ building_name: 'Black Forest', kindoo_site_id: 'east-stake' });
        await seedSeat({ scope: 'stake', type: 'auto', callings: ['Stake Clerk'] });
        const { db } = requireEmulators();
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).update({
          duplicate_grants: [
            {
              scope: 'MR',
              type: 'manual',
              building_names: ['Maple Building'],
              kindoo_site_id: null,
              detected_at: Timestamp.now(),
            },
          ],
          duplicate_scopes: ['MR'],
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
                  scope: 'MR',
                  type: 'manual',
                  callings: [],
                  buildingNames: ['Black Forest'],
                  isTempUser: false,
                },
              },
            },
          }),
        );

        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat;
        expect(seat.duplicate_grants).toHaveLength(1);
        expect(seat.duplicate_grants[0]!.building_names).toEqual([
          'Maple Building',
          'Black Forest',
        ]);
        expect(seat.duplicate_grants[0]!.kindoo_site_id).toBe('east-stake');
        expect(seat.duplicate_scopes).toEqual(['MR']);
      });
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

    it('stamps kindoo_site_id when the ward resolves to a foreign Kindoo site', async () => {
      await seedManager();
      // Ward MR's building is on a foreign site. The auto seat created by
      // the kindoo-only fix must carry that site, not be silently home.
      await seedWard({ ward_code: 'MR', building_name: 'Black Forest' });
      await seedBuilding({ building_name: 'Black Forest', kindoo_site_id: 'east-stake' });

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
                scope: 'MR',
                type: 'auto',
                callings: ['Ward Clerk'],
                buildingNames: ['Black Forest'],
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
      ).data() as Seat & { kindoo_site_id?: unknown };
      expect(seat.scope).toBe('MR');
      expect(seat.kindoo_site_id).toBe('east-stake');
    });

    it('leaves kindoo_site_id absent when the ward resolves to the home site', async () => {
      await seedManager();
      // Ward CO's building is on the home site (null) → field absent.
      await seedWard({ ward_code: 'CO', building_name: 'Maple Building' });
      await seedBuilding({ building_name: 'Maple Building', kindoo_site_id: null });

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
      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & { kindoo_site_id?: unknown };
      expect(seat.scope).toBe('CO');
      // Field-absent is the home representation.
      expect(seat.kindoo_site_id).toBeUndefined();
    });

    it('leaves kindoo_site_id absent for a stake-scope seat', async () => {
      await seedManager();
      // Stake-scope always resolves to home — no ward/buildings read,
      // field absent.
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
                scope: 'stake',
                type: 'auto',
                callings: ['Stake Clerk'],
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
      ).data() as Seat & { kindoo_site_id?: unknown };
      expect(seat.scope).toBe('stake');
      expect(seat.kindoo_site_id).toBeUndefined();
    });

    it('leaves kindoo_site_id absent when the ward is unknown (read-time fallback classifies)', async () => {
      await seedManager();
      // No unit doc for ZZ → site unresolvable. The field is left unset
      // (warn + leave absent); the site guard does NOT turn a missing unit
      // into a hard failure. The unit's KIND is equally unresolvable and
      // equally tolerated — it falls back to ward.
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
                scope: 'ZZ',
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
      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & { kindoo_site_id?: unknown };
      expect(seat.scope).toBe('ZZ');
      expect(seat.kindoo_site_id).toBeUndefined();
    });

    it('stamps kindoo_site_id on a MANUAL seat for a foreign-site ward', async () => {
      await seedManager();
      // The extension defaults the kindoo-only `type` to `manual`, so a
      // manual foreign-ward seat is the common case — it MUST carry the
      // site, not be silently persisted as home. Site resolution runs for
      // every ward-scope seat type, not just auto.
      await seedWard({ ward_code: 'MR', building_name: 'Black Forest' });
      await seedBuilding({ building_name: 'Black Forest', kindoo_site_id: 'east-stake' });

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
                scope: 'MR',
                type: 'manual',
                callings: [],
                buildingNames: ['Black Forest'],
                reason: 'sub clerk',
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
      ).data() as Seat & { kindoo_site_id?: unknown };
      expect(seat.type).toBe('manual');
      expect(seat.kindoo_site_id).toBe('east-stake');
    });

    it('stamps kindoo_site_id on a TEMP seat for a foreign-site ward', async () => {
      await seedManager();
      // Time-boxed kindoo-only grants come through as `temp`; they too must
      // carry the foreign site (and keep their dates).
      await seedWard({ ward_code: 'MR', building_name: 'Black Forest' });
      await seedBuilding({ building_name: 'Black Forest', kindoo_site_id: 'east-stake' });

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
                scope: 'MR',
                type: 'temp',
                callings: [],
                buildingNames: ['Black Forest'],
                startDate: '2026-06-01',
                endDate: '2026-06-30',
                isTempUser: true,
              },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

      const { db } = requireEmulators();
      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & { kindoo_site_id?: unknown };
      expect(seat.type).toBe('temp');
      expect(seat.kindoo_site_id).toBe('east-stake');
      expect(seat.start_date).toBe('2026-06-01');
      expect(seat.end_date).toBe('2026-06-30');
    });
  });

  // ----- callings-mismatch -----

  describe("code='callings-mismatch'", () => {
    it('REPLACES seat.callings with the Kindoo target (rename, not append) and recomputes sort_order', async () => {
      await seedManager();
      // Rename `Bishopric First Counselor` → `Bishop`, which outranks it.
      // sort_order recomputes from the new calling.
      await seedSeat({
        scope: 'CO',
        type: 'auto',
        callings: ['Bishopric First Counselor'],
        sort_order: BISHOPRIC_1C_ORDER,
      });
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'callings-mismatch',
              payload: { memberEmail: MEMBER_EMAIL, callings: ['Bishop'] },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });
      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()).data() as Seat;
      // REPLACED — the old name is gone, not sitting beside the new one.
      expect(seat.callings).toEqual(['Bishop']);
      // sort_order recomputed from the new calling, not the old one.
      expect(seat.sort_order).toBe(BISHOP_ORDER);
      expect(seat.lastActor).toEqual({
        email: 'SyncActor:callings-mismatch',
        canonical: 'SyncActor:callings-mismatch',
      });
    });

    it('preserves a client-set organization_id on an auto seat (callings-mismatch never touches it)', async () => {
      await seedManager();
      // A stake-scope auto seat whose org was set inline by a stake
      // member. The callings-mismatch path uses `tx.update` with named
      // fields only, so `organization_id` (unmentioned) must survive.
      await seedSeat({
        scope: 'stake',
        type: 'auto',
        callings: ['Bishopric First Counselor'],
        sort_order: BISHOPRIC_1C_ORDER,
        organization_id: 'primary-childrens-hospital',
      });

      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'callings-mismatch',
              payload: { memberEmail: MEMBER_EMAIL, callings: ['Bishop'] },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

      const { db } = requireEmulators();
      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & { organization_id?: unknown };
      expect(seat.callings).toEqual(['Bishop']);
      // Org survived the fix.
      expect(seat.organization_id).toBe('primary-childrens-hospital');
    });

    it('rejects an empty callings target with invalid-argument', async () => {
      await seedManager();
      await seedSeat({ scope: 'CO', type: 'auto', callings: ['Bishop'] });
      await expect(
        syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'callings-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, callings: [] },
              },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('returns soft failure when the seat is missing', async () => {
      await seedManager();
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'callings-mismatch',
              payload: { memberEmail: MEMBER_EMAIL, callings: ['Bishopric Clerk'] },
            },
          },
        }),
      );
      expect(result).toEqual({ success: false, error: 'seat not found' });
    });

    it('rejects a signed-in non-manager with permission-denied', async () => {
      await seedSeat({ scope: 'CO', type: 'auto', callings: ['Bishop'] });
      await expect(
        syncApplyFix.run(
          callableReq({
            auth: { email: 'outsider@gmail.com' },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'callings-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, callings: ['Bishopric Clerk'] },
              },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'permission-denied' });
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

    it('clears a foreign kindoo_site_id when resolving to stake scope (B-15)', async () => {
      await seedManager();
      // A foreign-site ward seat that scope-mismatches to stake: stake-scope
      // primaries must resolve to the home site (kindoo_site_id absent), or
      // projectSeatForSite resolves it off-home and it goes invisible on the
      // home Sync run.
      await seedSeat({ scope: 'CO', type: 'manual', callings: ['Ward Clerk'] });
      const { db } = requireEmulators();
      await db
        .doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`)
        .update({ kindoo_site_id: 'foreign-site-123' });

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

      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & { kindoo_site_id?: unknown };
      expect(seat.scope).toBe('stake');
      // Foreign site id gone → resolves to home.
      expect(seat.kindoo_site_id).toBeUndefined();
    });

    it('stamps the new ward building site when resolving to a foreign-site ward scope', async () => {
      await seedManager();
      // A home seat scope-mismatches to ward DZ whose building is on a
      // foreign Kindoo site. The seat picks up the new ward's site.
      await seedWard({ ward_code: 'DZ', building_name: 'Pine Building' });
      await seedBuilding({ building_name: 'Pine Building', kindoo_site_id: 'east-stake' });
      await seedSeat({ scope: 'CO', type: 'manual', callings: ['Ward Clerk'] });
      const { db } = requireEmulators();

      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'scope-mismatch',
              payload: { memberEmail: MEMBER_EMAIL, newScope: 'DZ' },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & { kindoo_site_id?: unknown };
      expect(seat.scope).toBe('DZ');
      // New ward's building site is foreign → stamped onto the seat.
      expect(seat.kindoo_site_id).toBe('east-stake');
    });

    it('stamps null (home) when resolving to a ward whose building is home', async () => {
      await seedManager();
      // Seat carries a stale foreign site; the new ward's building is on
      // the home site, so the seat resolves to home (explicit null).
      await seedWard({ ward_code: 'DZ', building_name: 'Maple Building' });
      await seedBuilding({ building_name: 'Maple Building', kindoo_site_id: null });
      await seedSeat({ scope: 'CO', type: 'manual', callings: ['Ward Clerk'] });
      const { db } = requireEmulators();
      await db
        .doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`)
        .update({ kindoo_site_id: 'foreign-site-123' });

      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'scope-mismatch',
              payload: { memberEmail: MEMBER_EMAIL, newScope: 'DZ' },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & { kindoo_site_id?: unknown };
      expect(seat.scope).toBe('DZ');
      // Home ward building → explicit null.
      expect(seat.kindoo_site_id).toBe(null);
    });

    it('leaves kindoo_site_id untouched when the new ward scope is unresolvable', async () => {
      await seedManager();
      // No ward doc for DZ → the site can't be resolved, so the field is
      // left as-is and the ward-fallback handles classification at read
      // time.
      await seedSeat({ scope: 'CO', type: 'manual', callings: ['Ward Clerk'] });
      const { db } = requireEmulators();
      await db
        .doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`)
        .update({ kindoo_site_id: 'foreign-site-123' });

      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'scope-mismatch',
              payload: { memberEmail: MEMBER_EMAIL, newScope: 'DZ' },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & { kindoo_site_id?: unknown };
      expect(seat.scope).toBe('DZ');
      // Unresolvable ward → field untouched.
      expect(seat.kindoo_site_id).toBe('foreign-site-123');
    });

    it('clears organization_id when moving from stake scope to a ward scope', async () => {
      await seedManager();
      // A stake-scope seat carrying an org moves to a ward scope.
      // Organization is a stake-scope-only concept, so the move must
      // shed the org.
      await seedWard({ ward_code: 'DZ', building_name: 'Maple Building' });
      await seedBuilding({ building_name: 'Maple Building', kindoo_site_id: null });
      await seedSeat({
        scope: 'stake',
        type: 'manual',
        callings: ['Ward Clerk'],
        organization_id: 'primary-childrens-hospital',
      });

      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'scope-mismatch',
              payload: { memberEmail: MEMBER_EMAIL, newScope: 'DZ' },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

      const { db } = requireEmulators();
      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & { organization_id?: unknown };
      expect(seat.scope).toBe('DZ');
      // Org gone (FieldValue.delete) → No Organization.
      expect(seat.organization_id).toBeUndefined();
    });

    it('does not introduce organization_id when moving to stake scope', async () => {
      await seedManager();
      // A ward seat (no org) moves to stake. The path doesn't add an
      // org — there's no source value, and org defaults to absent.
      await seedSeat({ scope: 'CO', type: 'manual', callings: ['Ward Clerk'] });

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
      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & { organization_id?: unknown };
      expect(seat.scope).toBe('stake');
      expect(seat.organization_id).toBeUndefined();
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
      // Well-formed manual seat: callings empty, calling in reason (§6.1).
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

    // ----- Seat reshape on the type flip (§6.1 convention) -----
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

  // ----- kindoo-unparseable -----
  //
  // A present-but-unparseable Kindoo Description is treated as a
  // church-wide calling: the seat moves to stake scope (foreign
  // kindoo_site_id cleared) and the calling is set from the raw
  // description per §6.1 (auto → callings[]; manual/temp → free-text
  // reason). Auto seats reap the old scope's calling-derived access
  // (Kindoo-authoritative, #183), then KEEP stake-scope access iff the
  // calling is in the STAKE app-access set (a bare app-access calling
  // name is "unparseable" yet real); a non-app-access calling earns no
  // new grant.

  describe("code='kindoo-unparseable'", () => {
    it('manual seat: moves to stake scope, sets reason from calling, clears callings, keeps type', async () => {
      await seedManager();
      await seedSeat({
        scope: 'CO',
        type: 'manual',
        callings: ['Some Calling'],
        building_names: ['Maple Building'],
      });

      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'kindoo-unparseable',
              payload: { memberEmail: MEMBER_EMAIL, calling: 'Church History Adviser' },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

      const { db } = requireEmulators();
      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & { reason?: unknown };
      expect(seat.scope).toBe('stake');
      // §6.1 manual convention: calling in reason, callings cleared.
      expect(seat.reason).toBe('Church History Adviser');
      expect(seat.callings).toEqual([]);
      // type unchanged; buildings untouched.
      expect(seat.type).toBe('manual');
      expect(seat.building_names).toEqual(['Maple Building']);
      expect(seat.lastActor).toEqual({
        email: 'SyncActor:kindoo-unparseable',
        canonical: 'SyncActor:kindoo-unparseable',
      });
    });

    it('temp seat: sets reason from calling and preserves existing dates', async () => {
      await seedManager();
      await seedSeat({ scope: 'CO', type: 'temp', callings: [] });
      const { db } = requireEmulators();
      await db
        .doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`)
        .update({ start_date: '2026-01-01', end_date: '2026-12-31' });

      await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'kindoo-unparseable',
              payload: { memberEmail: MEMBER_EMAIL, calling: 'Visiting Authority' },
            },
          },
        }),
      );

      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & {
        reason?: unknown;
        start_date?: unknown;
        end_date?: unknown;
      };
      expect(seat.scope).toBe('stake');
      expect(seat.type).toBe('temp');
      expect(seat.reason).toBe('Visiting Authority');
      expect(seat.callings).toEqual([]);
      // temp dates preserved across the reshape.
      expect(seat.start_date).toBe('2026-01-01');
      expect(seat.end_date).toBe('2026-12-31');
    });

    it('auto seat (non-template calling): moves to stake scope, sets callings, clears reason, sort_order null, keeps type', async () => {
      await seedManager();
      await seedSeat({
        scope: 'CO',
        type: 'auto',
        callings: ['Ward Clerk'],
        sort_order: 5,
      });
      const { db } = requireEmulators();
      // Seed a stale reason to prove the auto reshape clears it.
      await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).update({ reason: 'stale' });

      await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'kindoo-unparseable',
              payload: { memberEmail: MEMBER_EMAIL, calling: 'Church History Adviser' },
            },
          },
        }),
      );

      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & { reason?: unknown; sort_order?: unknown };
      expect(seat.scope).toBe('stake');
      expect(seat.type).toBe('auto');
      // §6.1 auto convention: calling in callings[], reason cleared.
      expect(seat.callings).toEqual(['Church History Adviser']);
      expect(seat.reason).toBeUndefined();
      // non-template church-wide calling earns no template sort key → null.
      expect(seat.sort_order).toBe(null);
    });

    it('auto seat (stake app-access calling): keeps stake access, sort_order from canonical order', async () => {
      await seedManager();
      // `Stake Clerk` is in the STAKE app-access set (canonical order 3)
      // — a bare app-access calling name (no parens) is "unparseable"
      // yet must NOT cost the member access.
      await seedSeat({ scope: 'CO', type: 'auto', callings: ['Bishop'], sort_order: BISHOP_ORDER });
      await seedAccess({ importer_callings: { CO: ['Bishop'] }, sort_order: BISHOP_ORDER });

      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'kindoo-unparseable',
              payload: { memberEmail: MEMBER_EMAIL, calling: 'Stake Clerk' },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

      const { db } = requireEmulators();
      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & { sort_order?: unknown };
      expect(seat.scope).toBe('stake');
      expect(seat.callings).toEqual(['Stake Clerk']);
      // seat sort_order from the canonical churchwide order.
      expect(seat.sort_order).toBe(STAKE_CLERK_ORDER);

      const access = (
        await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
      ).data() as Access;
      // Old scope reaped; fresh stake entry written so access is preserved.
      expect(access.importer_callings).toEqual({ stake: ['Stake Clerk'] });
      expect(access.sort_order).toBe(STAKE_CLERK_ORDER);
      expect(access.lastActor).toEqual({
        email: 'SyncActor:kindoo-unparseable',
        canonical: 'SyncActor:kindoo-unparseable',
      });
    });

    it("auto seat (non-template calling): reaps the old scope's importer_callings and creates no new stake-scope grant", async () => {
      await seedManager();
      await seedSeat({
        scope: 'CO',
        type: 'auto',
        callings: ['Bishop'],
        sort_order: 5,
      });
      // Auto seat justified by importer_callings[CO]; the church-wide
      // calling is non-template, so after the fix the doc should have no
      // importer_callings at all (CO reaped, no new stake entry).
      await seedAccess({ importer_callings: { CO: ['Bishop'] }, sort_order: 5 });

      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'kindoo-unparseable',
              payload: { memberEmail: MEMBER_EMAIL, calling: 'Church History Adviser' },
            },
          },
        }),
      );
      expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

      const { db } = requireEmulators();
      // Both maps empty → the reap helper deletes the access doc, so the
      // member holds no calling-derived stake access for the new calling.
      const accessSnap = await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get();
      expect(accessSnap.exists).toBe(false);
    });

    it("auto seat with a manual grant: reaps only the old scope's importer_callings, keeps the manual grant", async () => {
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

      await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'kindoo-unparseable',
              payload: { memberEmail: MEMBER_EMAIL, calling: 'Church History Adviser' },
            },
          },
        }),
      );

      const { db } = requireEmulators();
      const access = (
        await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
      ).data() as Access;
      // CO calling-derived grant reaped; deliberate manual grant preserved.
      expect(access.importer_callings).toEqual({});
      expect(access.manual_grants.CO?.length).toBe(1);
    });

    it('clears a foreign kindoo_site_id when forcing stake scope', async () => {
      await seedManager();
      // Seat synced against a foreign site carries that site id; stake-scope
      // primaries must resolve to the home site (kindoo_site_id absent).
      await seedSeat({ scope: 'CO', type: 'manual', callings: [] });
      const { db } = requireEmulators();
      await db
        .doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`)
        .update({ kindoo_site_id: 'foreign-site-123' });

      await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'kindoo-unparseable',
              payload: { memberEmail: MEMBER_EMAIL, calling: 'Visiting Authority' },
            },
          },
        }),
      );

      const seat = (
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
      ).data() as Seat & { kindoo_site_id?: unknown };
      expect(seat.scope).toBe('stake');
      // Foreign site id gone → resolves to home.
      expect(seat.kindoo_site_id).toBeUndefined();
    });

    it('returns soft failure when the seat is missing', async () => {
      await seedManager();
      const result = await syncApplyFix.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'kindoo-unparseable',
              payload: { memberEmail: MEMBER_EMAIL, calling: 'Church History Adviser' },
            },
          },
        }),
      );
      expect(result).toEqual({ success: false, error: 'seat not found' });
    });

    it('rejects an empty calling with invalid-argument', async () => {
      await seedManager();
      await seedSeat({});
      await expect(
        syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'kindoo-unparseable',
                payload: { memberEmail: MEMBER_EMAIL, calling: '   ' },
              },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('rejects a non-manager with permission-denied (auth gate reuse)', async () => {
      await seedSeat({});
      await expect(
        syncApplyFix.run(
          callableReq({
            auth: { email: 'outsider@gmail.com' },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'kindoo-unparseable',
                payload: { memberEmail: MEMBER_EMAIL, calling: 'Church History Adviser' },
              },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'permission-denied' });
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

  // ----- Auto-seat bookkeeping: sort_order + access-doc fan-out -----
  //
  // App access is a hard-coded churchwide list (no per-stake calling
  // templates): a calling grants app access iff it's in the scope's set
  // (`filterAppAccessCallings` — ward callings for ward scopes, stake
  // callings for 'stake'). `sort_order` comes from the canonical
  // churchwide calling order (`seatCallingOrder`). These tests cover
  // both across the three apply paths that can turn a seat auto.

  describe('auto-seat bookkeeping (sort_order + access fan-out)', () => {
    describe("code='kindoo-only' on auto seats", () => {
      it('stamps sort_order = canonical MIN and writes access docs for ward app-access callings', async () => {
        await seedManager();
        // `Bishop` (canonical 42) + `Ward Clerk` (canonical 47) are both
        // in the base WARD app-access set; `Elders Quorum President`
        // (canonical 51) is stake-gated and this suite seeds no stake doc,
        // so the gate reads OFF — it ranks for sort but earns no access.
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
                  callings: ['Bishop', 'Ward Clerk', 'Elders Quorum President'],
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
        // canonical MIN(42, 47, 51) = 42.
        expect(seat.sort_order).toBe(BISHOP_ORDER);

        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        // Only the two WARD app-access callings appear under
        // importer_callings[CO]; the non-app-access one is dropped.
        // Sorted alphabetically per the access-doc contract.
        expect(access.importer_callings).toEqual({ CO: ['Bishop', 'Ward Clerk'] });
        expect(access.manual_grants).toEqual({});
        // Access sort_order mirrors the seat's canonical MIN.
        expect(access.sort_order).toBe(BISHOP_ORDER);
        expect(access.lastActor).toEqual({
          email: 'SyncActor:kindoo-only',
          canonical: 'SyncActor:kindoo-only',
        });
      });

      it('writes no access doc when no calling is in the app-access set; sort_order may be null', async () => {
        await seedManager();
        // `Unknown Calling` isn't in the canonical order nor any app-access
        // set — orphan auto seat, no grant.
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
        // Orphan auto seat: sort_order is null (calling doesn't rank).
        expect(seat.sort_order).toBe(null);
        const accessSnap = await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get();
        expect(accessSnap.exists).toBe(false);
      });
    });

    describe("code='kindoo-only' on non-auto seats", () => {
      it('manual: writes no sort_order and no access doc even for an app-access calling', async () => {
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

      it('temp: writes no sort_order and no access doc even for an app-access calling', async () => {
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
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat & { sort_order?: unknown };
        expect(seat.type).toBe('temp');
        expect(seat.sort_order).toBeUndefined();
        const accessSnap = await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get();
        expect(accessSnap.exists).toBe(false);
      });
    });

    describe("code='callings-mismatch'", () => {
      it('on auto: REPLACES importer_callings[scope] with the new app-access target and recomputes sort_order', async () => {
        await seedManager();
        // Old calling `Ward Clerk` is in the WARD app-access set; new
        // calling `Bishop` is too, and outranks it. The replace rewrites
        // the grant set to the NEW calling and recomputes sort_order.
        await seedSeat({
          scope: 'CO',
          type: 'auto',
          callings: ['Ward Clerk'],
          sort_order: WARD_CLERK_ORDER,
        });
        await seedAccess({
          importer_callings: { CO: ['Ward Clerk'] },
          sort_order: WARD_CLERK_ORDER,
        });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'callings-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, callings: ['Bishop'] },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat;
        expect(seat.callings).toEqual(['Bishop']);
        expect(seat.sort_order).toBe(BISHOP_ORDER);

        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        // importer_callings[CO] REPLACED with the new calling (old name gone).
        expect(access.importer_callings).toEqual({ CO: ['Bishop'] });
        expect(access.sort_order).toBe(BISHOP_ORDER);
      });

      it('on auto: a replace that DROPS the app-access calling clears importer_callings[scope] and deletes the access doc (both maps empty)', async () => {
        await seedManager();
        // Old calling `Bishop` (42) is in the WARD app-access set; new
        // calling `Elders Quorum President` (51) ranks for sort but earns
        // no access with the stake gate OFF (no stake doc seeded). The
        // replace must remove the now-unjustified grant.
        await seedSeat({
          scope: 'CO',
          type: 'auto',
          callings: ['Bishop'],
          sort_order: BISHOP_ORDER,
        });
        await seedAccess({ importer_callings: { CO: ['Bishop'] }, sort_order: BISHOP_ORDER });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'callings-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, callings: ['Elders Quorum President'] },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat;
        expect(seat.callings).toEqual(['Elders Quorum President']);
        expect(seat.sort_order).toBe(EQP_ORDER);
        // No app-access calling remains; both maps empty → doc deleted.
        const accessSnap = await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get();
        expect(accessSnap.exists).toBe(false);
      });

      it('on auto: a replace that drops the grant but leaves manual_grants clears importer_callings[scope] yet keeps the doc', async () => {
        await seedManager();
        // `Bishop` (in WARD set) → `Elders Quorum President` (stake gate
        // OFF, so not in the set).
        await seedSeat({
          scope: 'CO',
          type: 'auto',
          callings: ['Bishop'],
          sort_order: BISHOP_ORDER,
        });
        await seedAccess({
          importer_callings: { CO: ['Bishop'] },
          manual_grants: {
            CO: [
              {
                grant_id: 'grant-1',
                reason: 'manager grant',
                granted_by: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
                granted_at: Timestamp.now(),
              },
            ],
          },
          sort_order: BISHOP_ORDER,
        });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'callings-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, callings: ['Elders Quorum President'] },
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
        expect(access.lastActor).toEqual({
          email: 'SyncActor:callings-mismatch',
          canonical: 'SyncActor:callings-mismatch',
        });
      });

      it('on manual: rejects with failed-precondition and leaves the seat untouched (auto-only; no §6.1 hybrid)', async () => {
        await seedManager();
        // Well-formed manual seat: empty callings, calling in free-text reason.
        await seedSeat({ scope: 'CO', type: 'manual', callings: [] });
        const { db } = requireEmulators();
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).update({ reason: 'Old Calling' });

        await expect(
          syncApplyFix.run(
            callableReq({
              auth: { email: MANAGER_EMAIL },
              data: {
                stakeId: STAKE_ID,
                fix: {
                  code: 'callings-mismatch',
                  payload: { memberEmail: MEMBER_EMAIL, callings: ['Bishop'] },
                },
              },
            }),
          ),
        ).rejects.toMatchObject({ code: 'failed-precondition' });

        // Seat left untouched — no hybrid (callings stay empty, reason kept).
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat & { reason?: unknown };
        expect(seat.callings).toEqual([]);
        expect(seat.reason).toBe('Old Calling');
        const accessSnap = await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get();
        expect(accessSnap.exists).toBe(false);
      });
    });

    describe("code='type-mismatch' flipping to auto", () => {
      it('manual → auto: stamps sort_order from the payload callings, writes access doc for app-access matches', async () => {
        await seedManager();
        // Well-formed manual seat: callings empty, calling in reason.
        // `Bishop` is in the WARD app-access set.
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
        expect(seat.sort_order).toBe(BISHOP_ORDER);

        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        expect(access.importer_callings).toEqual({ CO: ['Bishop'] });
        expect(access.sort_order).toBe(BISHOP_ORDER);
      });

      it('manual → auto with no payload callings: sort_order + access doc derive from the reason fallback', async () => {
        await seedManager();
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
        expect(seat.sort_order).toBe(BISHOP_ORDER);
        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        expect(access.importer_callings).toEqual({ CO: ['Bishop'] });
      });

      it('idempotent: re-applying the same promote yields the same seat + access shape', async () => {
        await seedManager();
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
        expect(seat.sort_order).toBe(BISHOP_ORDER);

        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        expect(access.importer_callings).toEqual({ CO: ['Bishop'] });
      });
    });

    describe("code='type-mismatch' flipping away from auto", () => {
      it('auto → manual with no manual_grants: clears sort_order and deletes the access doc', async () => {
        await seedManager();
        await seedSeat({
          scope: 'CO',
          type: 'auto',
          callings: ['Bishop'],
          sort_order: BISHOP_ORDER,
        });
        await seedAccess({
          importer_callings: { CO: ['Bishop'] },
          sort_order: BISHOP_ORDER,
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
        await seedSeat({
          scope: 'CO',
          type: 'auto',
          callings: ['Bishop'],
          sort_order: BISHOP_ORDER,
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
          sort_order: BISHOP_ORDER,
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

    // The one stake-gated ward calling: Elders Quorum President grants
    // app access only when `stake.eq_president_app_access === true`. The
    // callable reads the stake doc once per invocation; a missing doc
    // reads as OFF (every other test in this file relies on that).
    describe('Elders Quorum President stake gate', () => {
      const EQP = 'Elders Quorum President';

      it('kindoo-only auto ward seat: gate ON writes an access doc carrying the calling', async () => {
        await seedManager();
        await seedStake({ eqPresidentAccess: true });

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
                  callings: [EQP],
                  buildingNames: ['Maple Building'],
                  isTempUser: false,
                },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        expect(access.importer_callings).toEqual({ CO: [EQP] });
        expect(access.manual_grants).toEqual({});
        expect(access.sort_order).toBe(EQP_ORDER);
      });

      it('kindoo-only auto ward seat: gate explicitly OFF writes no access doc', async () => {
        await seedManager();
        await seedStake({ eqPresidentAccess: false });

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
                  callings: [EQP],
                  buildingNames: ['Maple Building'],
                  isTempUser: false,
                },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const accessSnap = await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get();
        expect(accessSnap.exists).toBe(false);
        // The seat itself is unaffected by the gate.
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat;
        expect(seat.callings).toEqual([EQP]);
        expect(seat.sort_order).toBe(EQP_ORDER);
      });

      it('kindoo-only: gate ON does NOT extend to the quorum counselors (exact title only)', async () => {
        await seedManager();
        await seedStake({ eqPresidentAccess: true });

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
                  callings: ['Elders Quorum First Counselor'],
                  buildingNames: ['Maple Building'],
                  isTempUser: false,
                },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const accessSnap = await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get();
        expect(accessSnap.exists).toBe(false);
      });

      it('callings-mismatch: gate ON keeps access when the replace target is the calling', async () => {
        await seedManager();
        await seedStake({ eqPresidentAccess: true });
        await seedSeat({
          scope: 'CO',
          type: 'auto',
          callings: ['Bishop'],
          sort_order: BISHOP_ORDER,
        });
        await seedAccess({ importer_callings: { CO: ['Bishop'] }, sort_order: BISHOP_ORDER });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'callings-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, callings: [EQP] },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const accessSnap = await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get();
        // With the gate OFF this same replace deletes the doc (see the
        // sibling test above); with it ON the grant is rewritten, not cleared.
        expect(accessSnap.exists).toBe(true);
        const access = accessSnap.data() as Access;
        expect(access.importer_callings).toEqual({ CO: [EQP] });
        // The seat's own sort_order is recomputed to the quorum
        // president's index, but the access
        // doc's keeps the smaller PRIOR value — `writeAccessForAutoScope`
        // stamps `pickMin(prior, new)`. Pre-existing behaviour of the
        // replace path, unrelated to the gate; pinned here so a future
        // change to it is deliberate.
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat;
        expect(seat.sort_order).toBe(EQP_ORDER);
        expect(access.sort_order).toBe(BISHOP_ORDER);
      });

      it('type-mismatch promote: gate ON writes the access doc for the promoted seat', async () => {
        await seedManager();
        await seedStake({ eqPresidentAccess: true });
        await seedSeat({ scope: 'CO', type: 'manual', callings: [] });
        const { db } = requireEmulators();
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).update({ reason: EQP });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'type-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, newType: 'auto', callings: [EQP] },
              },
            },
          }),
        );

        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        expect(access.importer_callings).toEqual({ CO: [EQP] });
        expect(access.sort_order).toBe(EQP_ORDER);
      });

      it('kindoo-unparseable: gate ON still grants NO stake-scope access (ward-only opt-in)', async () => {
        await seedManager();
        await seedStake({ eqPresidentAccess: true });
        await seedSeat({
          scope: 'CO',
          type: 'auto',
          callings: ['Bishop'],
          sort_order: BISHOP_ORDER,
        });
        await seedAccess({ importer_callings: { CO: ['Bishop'] }, sort_order: BISHOP_ORDER });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'kindoo-unparseable',
                payload: { memberEmail: MEMBER_EMAIL, calling: EQP },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get()
        ).data() as Seat;
        expect(seat.scope).toBe('stake');
        // The opt-in extends the WARD set only. At stake scope the calling
        // earns nothing, so the old ward grant is reaped and no stake grant
        // replaces it — both maps empty → doc deleted.
        const accessSnap = await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get();
        expect(accessSnap.exists).toBe(false);
      });
    });

    // T-96 / D31. A branch's app-access callings are their OWN set —
    // `Branch President`, its two counselors, `Branch Clerk` — not the
    // ward set with names swapped and not a superset of it (a branch has
    // no counterpart to Ward Executive Secretary, and `Ward Clerk` is not
    // a branch calling). The kind that picks between the sets comes from
    // the unit's NAME, which lives only in the unit doc: `ward_code` is a
    // slug (`peterson-branch`, or a legacy `LB`) and D31(e) keeps it
    // deliberately un-normalised, so the scope string can never answer it.
    //
    // Every path that derives a grant therefore has to have read that doc
    // BEFORE it picks a set. None of the three did before this change, and
    // the failure was silent in both directions: `AppAccessOptions.unitType`
    // reads as ward when absent, so a Branch President matched nothing and
    // came out with no access at all — no error, no log, no audit row.
    describe('branch units', () => {
      // The realistic pair: `buildingSlug('Peterson Branch')`.
      const BRANCH_CODE = 'peterson-branch';
      const BRANCH_NAME = 'Peterson Branch';
      const BRANCH_PRESIDENT = 'Branch President';

      async function seedBranch(): Promise<void> {
        await seedWard({ ward_code: BRANCH_CODE, ward_name: BRANCH_NAME });
      }

      async function readAccess(): Promise<Access | undefined> {
        const { db } = requireEmulators();
        const snap = await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get();
        return snap.exists ? (snap.data() as Access) : undefined;
      }

      async function readSeat(): Promise<Seat | undefined> {
        const { db } = requireEmulators();
        const snap = await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).get();
        return snap.exists ? (snap.data() as Seat) : undefined;
      }

      function kindooOnly(scope: string, callings: string[]): never {
        return callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            fix: {
              code: 'kindoo-only',
              payload: {
                memberEmail: MEMBER_EMAIL,
                memberName: 'Alice',
                scope,
                type: 'auto',
                callings,
                buildingNames: ['Maple Building'],
                isTempUser: false,
              },
            },
          },
        });
      }

      // ----- kindoo-only: the seat-creation path -----

      it('kindoo-only: a Branch President on a branch scope derives app access', async () => {
        await seedManager();
        await seedBranch();

        const result = await syncApplyFix.run(kindooOnly(BRANCH_CODE, [BRANCH_PRESIDENT]));
        expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

        // The regression this whole task exists for: before the hoist this
        // access doc was never written.
        expect((await readAccess())?.importer_callings).toEqual({
          [BRANCH_CODE]: [BRANCH_PRESIDENT],
        });
        expect((await readSeat())?.sort_order).toBe(callingSortOrder(BRANCH_PRESIDENT));
      });

      it('kindoo-only: the same Branch President at a WARD scope derives nothing', async () => {
        await seedManager();
        // A RESOLVABLE ward, so this pins the resolved-ward path rather
        // than the unreadable-unit fallback (which also lands on ward).
        await seedWard({ ward_code: 'CO' });

        const result = await syncApplyFix.run(kindooOnly('CO', [BRANCH_PRESIDENT]));
        expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

        // The seat is created either way; only the grant is withheld.
        expect((await readSeat())?.scope).toBe('CO');
        expect(await readAccess()).toBeUndefined();
      });

      it('kindoo-only: a WARD calling on a branch scope derives nothing', async () => {
        await seedManager();
        await seedBranch();

        // `Ward Clerk` is in the ward set and not the branch one. Pins that
        // the branch set REPLACES the ward set rather than extending it —
        // a union would grant here.
        await syncApplyFix.run(kindooOnly(BRANCH_CODE, ['Ward Clerk']));
        expect(await readAccess()).toBeUndefined();
      });

      it('kindoo-only: a ward is unaffected — Bishop still grants at a ward scope', async () => {
        await seedManager();
        await seedWard({ ward_code: 'CO' });

        await syncApplyFix.run(kindooOnly('CO', ['Bishop']));
        expect((await readAccess())?.importer_callings).toEqual({ CO: ['Bishop'] });
      });

      it('kindoo-only: the Elders Quorum President opt-in reaches a branch, on the limited tier', async () => {
        await seedManager();
        await seedStake({ eqPresidentAccess: true });
        await seedBranch();

        await syncApplyFix.run(kindooOnly(BRANCH_CODE, [EQ_PRESIDENT_CALLING]));

        const access = await readAccess();
        expect(access?.importer_callings).toEqual({ [BRANCH_CODE]: [EQ_PRESIDENT_CALLING] });
        // Keyed on the calling name, not the unit's kind (D25 / D26), so a
        // branch quorum president lands limited on the same terms as a ward one.
        expect(access?.importer_limited_callings).toEqual({
          [BRANCH_CODE]: [EQ_PRESIDENT_CALLING],
        });
      });

      // ----- callings-mismatch: the REPLACE recompute -----

      it('callings-mismatch: a replace onto Branch President on a branch scope writes the grant', async () => {
        await seedManager();
        await seedBranch();
        // Prior calling is in neither set, so there is no access doc to
        // start from — the grant has to be derived fresh from the branch set.
        await seedSeat({ scope: BRANCH_CODE, type: 'auto', callings: ['Elders Quorum Secretary'] });

        const result = await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'callings-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, callings: [BRANCH_PRESIDENT] },
              },
            },
          }),
        );
        expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

        expect((await readAccess())?.importer_callings).toEqual({
          [BRANCH_CODE]: [BRANCH_PRESIDENT],
        });
      });

      it('callings-mismatch: a replace onto a WARD calling on a branch scope clears the grant', async () => {
        await seedManager();
        await seedBranch();
        await seedSeat({ scope: BRANCH_CODE, type: 'auto', callings: [BRANCH_PRESIDENT] });
        await seedAccess({ importer_callings: { [BRANCH_CODE]: [BRANCH_PRESIDENT] } });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'callings-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, callings: ['Ward Clerk'] },
              },
            },
          }),
        );

        // `Ward Clerk` earns nothing at a branch, so the replace REMOVES
        // access — both maps empty, doc deleted. Under the ward set this
        // would have kept the grant.
        expect(await readAccess()).toBeUndefined();
      });

      // ----- type-mismatch: the manual → auto promote -----

      it('type-mismatch promote: a branch seat promoted to auto derives the branch grant', async () => {
        await seedManager();
        await seedBranch();
        await seedSeat({ scope: BRANCH_CODE, type: 'manual', callings: [] });

        const result = await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'type-mismatch',
                payload: {
                  memberEmail: MEMBER_EMAIL,
                  newType: 'auto',
                  callings: [BRANCH_PRESIDENT],
                },
              },
            },
          }),
        );
        expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

        expect((await readSeat())?.type).toBe('auto');
        expect((await readAccess())?.importer_callings).toEqual({
          [BRANCH_CODE]: [BRANCH_PRESIDENT],
        });
      });

      // ----- Unresolvable unit: fall back to ward -----
      //
      // A branch IS a ward in this system — same collection, same
      // `ward_code`, same claims, same rosters — differing only in a few
      // calling names. So ward is right for nearly every unit, and it is
      // what these paths derived before D32. Refusing instead would strand
      // a seat whose unit doc was deleted: unit delete reaps no seats, and
      // a legacy 2-letter `ward_code` can't be recreated from the
      // Configuration UI, so the drift row would re-emit and fail forever.

      it('kindoo-only auto: an unreadable unit derives the WARD set', async () => {
        await seedManager();

        const result = await syncApplyFix.run(kindooOnly('ZZ', ['Ward Clerk']));
        expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

        expect((await readSeat())?.scope).toBe('ZZ');
        expect((await readAccess())?.importer_callings).toEqual({ ZZ: ['Ward Clerk'] });
      });

      it('kindoo-only auto: an unreadable unit derives nothing for a BRANCH calling', async () => {
        await seedManager();

        // The accepted cost of the ward default, and identical to what a
        // real ward does with this calling. The seat is still created;
        // only the grant is withheld.
        const result = await syncApplyFix.run(kindooOnly('ZZ', [BRANCH_PRESIDENT]));
        expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });
        expect((await readSeat())?.callings).toEqual([BRANCH_PRESIDENT]);
        expect(await readAccess()).toBeUndefined();
      });

      it('kindoo-only auto: a unit doc whose ward_name is blank falls back to ward', async () => {
        await seedManager();
        // A nameless unit resolves no kind, so it takes the same default a
        // missing doc does.
        await seedWard({ ward_code: 'blankunit', ward_name: '   ' });

        const result = await syncApplyFix.run(kindooOnly('blankunit', ['Ward Clerk']));
        expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });
        expect((await readAccess())?.importer_callings).toEqual({ blankunit: ['Ward Clerk'] });
      });

      it('callings-mismatch: an unreadable seat scope derives the WARD set', async () => {
        await seedManager();
        await seedSeat({ scope: 'ZZ', type: 'auto', callings: ['Elders Quorum Secretary'] });

        const result = await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'callings-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, callings: ['Ward Clerk'] },
              },
            },
          }),
        );
        expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

        expect((await readSeat())?.callings).toEqual(['Ward Clerk']);
        expect((await readAccess())?.importer_callings).toEqual({ ZZ: ['Ward Clerk'] });
      });

      it('type-mismatch promote: an unreadable seat scope derives the WARD set', async () => {
        await seedManager();
        await seedSeat({ scope: 'ZZ', type: 'manual', callings: [] });

        const result = await syncApplyFix.run(
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
        expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });

        expect((await readSeat())?.type).toBe('auto');
        expect((await readAccess())?.importer_callings).toEqual({ ZZ: ['Bishop'] });
      });

      it('type-mismatch DEMOTE: an unreadable unit is no obstacle — the demote needs no calling set', async () => {
        await seedManager();
        await seedSeat({ scope: 'ZZ', type: 'auto', callings: ['Bishop'] });
        await seedAccess({ importer_callings: { ZZ: ['Bishop'] } });

        const result = await syncApplyFix.run(
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
        // Clearing a grant is correct whatever kind the unit is, so this
        // branch reads no unit doc and needs no fallback.
        expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });
        expect(await readAccess()).toBeUndefined();
      });

      it('kindoo-unparseable: probes the stake set only, so an unreadable unit is no obstacle', async () => {
        await seedManager();
        await seedSeat({ scope: 'ZZ', type: 'auto', callings: ['Bishop'] });

        const result = await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'kindoo-unparseable',
                payload: { memberEmail: MEMBER_EMAIL, calling: 'Stake Clerk' },
              },
            },
          }),
        );
        // This path moves the seat to stake scope and probes the STAKE set,
        // which `unitType` never reaches. It reads no unit doc and needs none.
        expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });
        expect((await readSeat())?.scope).toBe('stake');
        expect((await readAccess())?.importer_callings).toEqual({ stake: ['Stake Clerk'] });
      });

      it('stake-scope auto fixes fetch no unit doc — the stake set ignores the kind', async () => {
        await seedManager();
        await seedSeat({ scope: 'stake', type: 'auto', callings: ['Stake Executive Secretary'] });

        const result = await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'callings-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, callings: ['Stake Clerk'] },
              },
            },
          }),
        );
        expect(result).toEqual({ success: true, seatId: MEMBER_EMAIL });
        expect((await readAccess())?.importer_callings).toEqual({ stake: ['Stake Clerk'] });
      });
    });

    // D26 tier stamp. The writer decides the tier once and stores it in
    // `importer_limited_callings[scope]` — the subset of that scope's
    // `importer_callings` that confers LIMITED access. Both maps are
    // always written together, so a scope whose limited calling goes
    // away must never leave a stale stamp behind.
    describe('importer_limited_callings tier stamp', () => {
      const EQP = 'Elders Quorum President';

      it('kindoo-only: a scope containing the limited calling stamps BOTH maps in one write', async () => {
        await seedManager();
        await seedStake({ eqPresidentAccess: true });

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
                  callings: ['Bishop', EQP],
                  buildingNames: ['Maple Building'],
                  isTempUser: false,
                },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        expect(access.importer_callings).toEqual({ CO: ['Bishop', EQP] });
        // Only the limited-tier calling is stamped, and it is a literal
        // subset of the list above.
        expect(access.importer_limited_callings).toEqual({ CO: [EQP] });
      });

      it('kindoo-only: a scope with no limited calling writes an EMPTY stamp map, not a missing one', async () => {
        await seedManager();
        await seedStake({ eqPresidentAccess: true });

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
                  callings: ['Bishop'],
                  buildingNames: ['Maple Building'],
                  isTempUser: false,
                },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        expect(access.importer_callings).toEqual({ CO: ['Bishop'] });
        expect(access.importer_limited_callings).toEqual({});
      });

      it('kindoo-only: the calling with the gate OFF earns no grant, so no stamp either', async () => {
        await seedManager();
        await seedStake({ eqPresidentAccess: false });

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
                  callings: [EQP],
                  buildingNames: ['Maple Building'],
                  isTempUser: false,
                },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        expect((await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()).exists).toBe(
          false,
        );
      });

      it('callings-mismatch: replacing a full calling with the limited one adds the stamp', async () => {
        await seedManager();
        await seedStake({ eqPresidentAccess: true });
        await seedSeat({
          scope: 'CO',
          type: 'auto',
          callings: ['Bishop'],
          sort_order: BISHOP_ORDER,
        });
        await seedAccess({ importer_callings: { CO: ['Bishop'] }, sort_order: BISHOP_ORDER });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'callings-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, callings: [EQP] },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        expect(access.importer_callings).toEqual({ CO: [EQP] });
        expect(access.importer_limited_callings).toEqual({ CO: [EQP] });
      });

      it('callings-mismatch: replacing the limited calling with a full one CLEARS the stale stamp', async () => {
        // The regression this pins: a `set merge` would deep-merge the
        // stamp map key-by-key and leave `{ CO: [EQP] }` behind, keeping
        // the member limited on the strength of a calling they no longer
        // hold. The write must replace the map wholesale.
        await seedManager();
        await seedStake({ eqPresidentAccess: true });
        await seedSeat({ scope: 'CO', type: 'auto', callings: [EQP], sort_order: EQP_ORDER });
        await seedAccess({
          importer_callings: { CO: [EQP] },
          importer_limited_callings: { CO: [EQP] },
          sort_order: EQP_ORDER,
        });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'callings-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, callings: ['Bishop'] },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        expect(access.importer_callings).toEqual({ CO: ['Bishop'] });
        expect(access.importer_limited_callings).toEqual({});
      });

      it("callings-mismatch: writing one scope leaves ANOTHER scope's stamp untouched", async () => {
        await seedManager();
        await seedStake({ eqPresidentAccess: true });
        await seedSeat({
          scope: 'CO',
          type: 'auto',
          callings: ['Bishop'],
          sort_order: BISHOP_ORDER,
        });
        await seedAccess({
          importer_callings: { CO: ['Bishop'], DR: [EQP] },
          importer_limited_callings: { DR: [EQP] },
          sort_order: BISHOP_ORDER,
        });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'callings-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, callings: ['Ward Clerk'] },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        expect(access.importer_callings).toEqual({ CO: ['Ward Clerk'], DR: [EQP] });
        expect(access.importer_limited_callings).toEqual({ DR: [EQP] });
      });

      it('type-mismatch demote: clearing a scope drops its stamp with it', async () => {
        await seedManager();
        await seedStake({ eqPresidentAccess: true });
        await seedSeat({ scope: 'CO', type: 'auto', callings: [EQP], sort_order: EQP_ORDER });
        await seedAccess({
          importer_callings: { CO: [EQP], DR: ['Bishop'] },
          importer_limited_callings: { CO: [EQP] },
          sort_order: BISHOP_ORDER,
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
        expect(access.importer_callings).toEqual({ DR: ['Bishop'] });
        expect(access.importer_limited_callings).toEqual({});
      });

      it('sba-only reap: a stale stamp never keeps an otherwise-empty access doc alive', async () => {
        await seedManager();
        await seedStake({ eqPresidentAccess: true });
        await seedSeat({ scope: 'CO', type: 'auto', callings: [EQP], sort_order: EQP_ORDER });
        await seedAccess({
          importer_callings: { CO: [EQP] },
          importer_limited_callings: { CO: [EQP] },
          sort_order: EQP_ORDER,
        });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: { code: 'sba-only', payload: { memberEmail: MEMBER_EMAIL } },
            },
          }),
        );

        const { db } = requireEmulators();
        expect((await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()).exists).toBe(
          false,
        );
      });

      it('kindoo-unparseable: the ward stamp is reaped along with the ward scope', async () => {
        await seedManager();
        await seedStake({ eqPresidentAccess: true });
        await seedSeat({ scope: 'CO', type: 'auto', callings: [EQP], sort_order: EQP_ORDER });
        await seedAccess({
          importer_callings: { CO: [EQP] },
          importer_limited_callings: { CO: [EQP] },
          manual_grants: {
            CO: [
              {
                grant_id: 'grant-1',
                reason: 'manager grant',
                granted_by: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
                granted_at: Timestamp.now(),
              },
            ],
          },
          sort_order: EQP_ORDER,
        });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'kindoo-unparseable',
                payload: { memberEmail: MEMBER_EMAIL, calling: 'Stake Clerk' },
              },
            },
          }),
        );

        const { db } = requireEmulators();
        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        // Moved to stake scope on a full-tier stake calling: the ward
        // grant and its stamp are both gone, the new grant is unstamped.
        expect(access.importer_callings).toEqual({ stake: ['Stake Clerk'] });
        expect(access.importer_limited_callings).toEqual({});
        expect(access.manual_grants.CO?.length).toBe(1);
      });

      it('an untiered pre-existing doc is re-stamped when Sync next writes that scope', async () => {
        // The one path by which an already-granted Elders Quorum
        // President becomes limited: not a sweep, just the next ordinary
        // write to their scope.
        await seedManager();
        await seedStake({ eqPresidentAccess: true });
        await seedSeat({ scope: 'CO', type: 'manual', callings: [] });
        const { db } = requireEmulators();
        await db.doc(`stakes/${STAKE_ID}/seats/${MEMBER_EMAIL}`).update({ reason: EQP });
        // Pre-D26 shape: the calling is granted, nothing is stamped.
        await seedAccess({ importer_callings: { CO: [EQP] }, sort_order: EQP_ORDER });

        await syncApplyFix.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              fix: {
                code: 'type-mismatch',
                payload: { memberEmail: MEMBER_EMAIL, newType: 'auto', callings: [EQP] },
              },
            },
          }),
        );

        const access = (
          await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get()
        ).data() as Access;
        expect(access.importer_callings).toEqual({ CO: [EQP] });
        expect(access.importer_limited_callings).toEqual({ CO: [EQP] });
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

      // Read the forged row by its DETERMINISTIC doc id, not `docs[0]` of
      // the whole collection: the real `syncApplyFix` call above also
      // fired the DEPLOYED `auditSeatWrites` trigger (plus, via the
      // seed/request churn, sibling-file leftovers can land here under the
      // shared `csnorth` stake). `auditId(time, suffix)` pins us to exactly
      // the row this test wrote.
      const docId = auditId(new Date(time), `seats_${MEMBER_EMAIL}`);
      const rowSnap = await db.doc(`stakes/${STAKE_ID}/auditLog/${docId}`).get();
      expect(rowSnap.exists).toBe(true);
      const row = rowSnap.data() as AuditLog;
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

      // Read the forged row by its DETERMINISTIC doc id, not `docs[0]` of
      // the whole collection: the real `syncApplyFix` call above also
      // fired the DEPLOYED `auditSeatWrites` trigger (plus, via the
      // seed/request churn, sibling-file leftovers can land here under the
      // shared `csnorth` stake). `auditId(time, suffix)` pins us to exactly
      // the row this test wrote.
      const docId = auditId(new Date(time), `seats_${MEMBER_EMAIL}`);
      const rowSnap = await db.doc(`stakes/${STAKE_ID}/auditLog/${docId}`).get();
      expect(rowSnap.exists).toBe(true);
      const row = rowSnap.data() as AuditLog;
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

      // Read the forged row by its DETERMINISTIC doc id, not `docs[0]` of
      // the whole collection: the real `syncApplyFix` call above also
      // fired the DEPLOYED `auditSeatWrites` trigger (plus, via the
      // seed/request churn, sibling-file leftovers can land here under the
      // shared `csnorth` stake). `auditId(time, suffix)` pins us to exactly
      // the row this test wrote.
      const docId = auditId(new Date(time), `seats_${MEMBER_EMAIL}`);
      const rowSnap = await db.doc(`stakes/${STAKE_ID}/auditLog/${docId}`).get();
      expect(rowSnap.exists).toBe(true);
      const row = rowSnap.data() as AuditLog;
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

      // Read the forged row by its DETERMINISTIC doc id, not `docs[0]` of
      // the whole collection: the real `syncApplyFix` call above also
      // fired the DEPLOYED `auditSeatWrites` trigger (plus, via the
      // seed/request churn, sibling-file leftovers can land here under the
      // shared `csnorth` stake). `auditId(time, suffix)` pins us to exactly
      // the row this test wrote.
      const docId = auditId(new Date(time), `seats_${MEMBER_EMAIL}`);
      const rowSnap = await db.doc(`stakes/${STAKE_ID}/auditLog/${docId}`).get();
      expect(rowSnap.exists).toBe(true);
      const row = rowSnap.data() as AuditLog;
      expect(row.entity_type).toBe('seat');
      expect(row.action).toBe('update_seat');
      expect(row.actor_email).toBe('SyncActor:scope-mismatch');
      expect(row.actor_canonical).toBe('SyncActor:scope-mismatch');
    });
  });
});
