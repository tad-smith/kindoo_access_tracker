// Integration tests for the `markRequestComplete` callable. Invoked
// from the Chrome MV3 extension's side panel after the manager has
// worked the door system. Flips a pending request to `complete` —
// the audit trigger + email trigger handle the fan-out from the
// resulting write.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { AccessRequest, AuditLog, OverCapEntry, Seat, Stake } from '@kindoo/shared';
import { markRequestComplete } from '../src/callable/markRequestComplete.js';
import { auditRequestWrites } from '../src/triggers/auditTrigger.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'csnorth';
const MANAGER_EMAIL = 'mgr@gmail.com';

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

async function seedRequest(opts: {
  requestId: string;
  status: 'pending' | 'complete' | 'rejected' | 'cancelled';
  type?: 'add_manual' | 'add_temp' | 'remove';
  scope?: string;
  member_email?: string;
  member_name?: string;
  reason?: string;
  building_names?: string[];
  start_date?: string;
  end_date?: string;
}): Promise<void> {
  const { db } = requireEmulators();
  const type = opts.type ?? 'add_manual';
  const memberEmail = opts.member_email ?? 'alice@gmail.com';
  const body: Record<string, unknown> = {
    request_id: opts.requestId,
    type,
    scope: opts.scope ?? 'CO',
    member_email: memberEmail,
    member_canonical: memberEmail,
    member_name: opts.member_name ?? 'Alice',
    reason: opts.reason ?? 'helper',
    comment: '',
    building_names: opts.building_names ?? [],
    status: opts.status,
    requester_email: MANAGER_EMAIL,
    requester_canonical: MANAGER_EMAIL,
    requested_at: Timestamp.fromMillis(1_000),
    lastActor: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
  };
  if (type === 'add_temp') {
    if (opts.start_date) body.start_date = opts.start_date;
    if (opts.end_date) body.end_date = opts.end_date;
  }
  if (type === 'remove') {
    body.seat_member_canonical = memberEmail;
  }
  await db.doc(`stakes/${STAKE_ID}/requests/${opts.requestId}`).set(body);
}

async function seedSeat(opts: {
  canonical?: string;
  scope?: string;
  type?: Seat['type'];
  building_names?: string[];
  reason?: string;
  duplicate_grants?: Seat['duplicate_grants'];
}): Promise<void> {
  const { db } = requireEmulators();
  const canonical = opts.canonical ?? 'alice@gmail.com';
  await db.doc(`stakes/${STAKE_ID}/seats/${canonical}`).set({
    member_canonical: canonical,
    member_email: canonical,
    member_name: 'Alice',
    scope: opts.scope ?? 'CO',
    type: opts.type ?? 'manual',
    callings: [],
    reason: opts.reason ?? 'existing-grant',
    building_names: opts.building_names ?? ['Cordera Building'],
    duplicate_grants: opts.duplicate_grants ?? [],
    granted_by_request: 'seed',
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    last_modified_by: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
    lastActor: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
  });
}

/**
 * Seed the parent stake doc with optional `last_over_caps_json` +
 * `stake_seat_cap`. The post-pivot callable recomputes over-caps from
 * the post-write seat set against the stake cap + per-ward caps, so
 * tests that exercise the cap-pivot path supply both.
 */
async function seedStake(
  opts: {
    overCaps?: OverCapEntry[];
    stake_seat_cap?: number;
  } = {},
): Promise<void> {
  const { db } = requireEmulators();
  const body: Record<string, unknown> = {
    last_over_caps_json: opts.overCaps ?? [],
  };
  if (opts.stake_seat_cap !== undefined) body.stake_seat_cap = opts.stake_seat_cap;
  await db.doc(`stakes/${STAKE_ID}`).set(body, { merge: true });
}

/**
 * Seed a ward doc. `seat_cap` is the per-ward Kindoo cap; the callable
 * reads the wards collection inside its transaction to recompute
 * over-caps against the post-write seat set. `building_name` is also
 * used by the legacy ward-scope fallback when a request has empty
 * `building_names`.
 */
async function seedWard(opts: {
  ward_code: string;
  building_name?: string;
  seat_cap?: number;
}): Promise<void> {
  const { db } = requireEmulators();
  await db.doc(`stakes/${STAKE_ID}/wards/${opts.ward_code}`).set({
    ward_code: opts.ward_code,
    ward_name: `${opts.ward_code} Ward`,
    building_name: opts.building_name ?? `${opts.ward_code} Building`,
    seat_cap: opts.seat_cap ?? 0,
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
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

describe.skipIf(!hasEmulators())('markRequestComplete callable', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  it('flips a pending request to complete and stamps the manager as completer', async () => {
    await seedManager();
    await seedRequest({ requestId: 'r1', status: 'pending' });

    const result = await markRequestComplete.run(
      callableReq({
        auth: { email: MANAGER_EMAIL },
        data: { stakeId: STAKE_ID, requestId: 'r1' },
      }),
    );
    expect(result).toEqual({ ok: true, over_caps: [] });

    const { db } = requireEmulators();
    const after = (await db.doc(`stakes/${STAKE_ID}/requests/r1`).get()).data() as AccessRequest;
    expect(after.status).toBe('complete');
    expect(after.completer_email).toBe(MANAGER_EMAIL);
    expect(after.completer_canonical).toBe(MANAGER_EMAIL);
    expect(after.completed_at).toBeDefined();
    expect(after.lastActor).toEqual({ email: MANAGER_EMAIL, canonical: MANAGER_EMAIL });
    // No completion_note supplied → field stays absent.
    expect(after.completion_note ?? null).toBeNull();
  });

  it('persists a trimmed completion note when supplied', async () => {
    await seedManager();
    await seedRequest({ requestId: 'r1', status: 'pending' });

    await markRequestComplete.run(
      callableReq({
        auth: { email: MANAGER_EMAIL },
        data: {
          stakeId: STAKE_ID,
          requestId: 'r1',
          completionNote: '  granted; door syncs overnight.  ',
        },
      }),
    );

    const { db } = requireEmulators();
    const after = (await db.doc(`stakes/${STAKE_ID}/requests/r1`).get()).data() as AccessRequest;
    expect(after.completion_note).toBe('granted; door syncs overnight.');
  });

  it('drops an empty (or whitespace-only) completion note from the write', async () => {
    await seedManager();
    await seedRequest({ requestId: 'r1', status: 'pending' });

    await markRequestComplete.run(
      callableReq({
        auth: { email: MANAGER_EMAIL },
        data: { stakeId: STAKE_ID, requestId: 'r1', completionNote: '   ' },
      }),
    );

    const { db } = requireEmulators();
    const after = (await db.doc(`stakes/${STAKE_ID}/requests/r1`).get()).data() as AccessRequest;
    expect(after.status).toBe('complete');
    expect(after.completion_note ?? null).toBeNull();
  });

  it('rejects an unauthenticated caller with unauthenticated', async () => {
    await seedManager();
    await seedRequest({ requestId: 'r1', status: 'pending' });
    await expect(
      markRequestComplete.run(
        callableReq({ auth: null, data: { stakeId: STAKE_ID, requestId: 'r1' } }),
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a signed-in non-manager with permission-denied', async () => {
    await seedRequest({ requestId: 'r1', status: 'pending' });
    await expect(
      markRequestComplete.run(
        callableReq({
          auth: { email: 'outsider@gmail.com' },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects a manager with active=false with permission-denied', async () => {
    await seedManager({ active: false });
    await seedRequest({ requestId: 'r1', status: 'pending' });
    await expect(
      markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects a non-pending request with failed-precondition', async () => {
    await seedManager();
    await seedRequest({ requestId: 'r1', status: 'complete' });
    await expect(
      markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects a missing requestId with invalid-argument', async () => {
    await seedManager();
    await expect(
      markRequestComplete.run(
        callableReq({ auth: { email: MANAGER_EMAIL }, data: { stakeId: STAKE_ID } }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('returns not-found when the request doc is absent', async () => {
    await seedManager();
    await expect(
      markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'missing' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  // Extension v2.2 — Provision & Complete passes Kindoo metadata
  // alongside the standard completion. Both fields optional; when
  // present, persisted on the request doc in the same transaction.
  describe('extension v2.2 provisioning metadata', () => {
    it('persists kindoo_uid and provisioning_note when supplied', async () => {
      await seedManager();
      await seedRequest({ requestId: 'r1', status: 'pending' });

      await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            requestId: 'r1',
            kindooUid: 'kindoo-user-12345',
            provisioningNote: 'Added Alice to Kindoo with access to Cordera Building.',
          },
        }),
      );

      const { db } = requireEmulators();
      const after = (await db.doc(`stakes/${STAKE_ID}/requests/r1`).get()).data() as AccessRequest;
      expect(after.status).toBe('complete');
      expect(after.kindoo_uid).toBe('kindoo-user-12345');
      expect(after.provisioning_note).toBe(
        'Added Alice to Kindoo with access to Cordera Building.',
      );
    });

    it('regression: existing SPA path (no v2.2 fields) still works', async () => {
      await seedManager();
      await seedRequest({ requestId: 'r1', status: 'pending' });

      const result = await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      );
      expect(result).toEqual({ ok: true, over_caps: [] });

      const { db } = requireEmulators();
      const after = (await db.doc(`stakes/${STAKE_ID}/requests/r1`).get()).data() as AccessRequest;
      expect(after.status).toBe('complete');
      // Both v2.2 fields stay absent on a SPA-path completion.
      expect(after.kindoo_uid ?? null).toBeNull();
      expect(after.provisioning_note ?? null).toBeNull();
    });

    it('trims provisioning_note and drops it when whitespace-only', async () => {
      await seedManager();
      await seedRequest({ requestId: 'r1', status: 'pending' });

      await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            requestId: 'r1',
            kindooUid: '  kindoo-user-99  ',
            provisioningNote: '   ',
          },
        }),
      );

      const { db } = requireEmulators();
      const after = (await db.doc(`stakes/${STAKE_ID}/requests/r1`).get()).data() as AccessRequest;
      expect(after.kindoo_uid).toBe('kindoo-user-99');
      expect(after.provisioning_note ?? null).toBeNull();
    });

    it('rejects non-string kindooUid with invalid-argument', async () => {
      await seedManager();
      await seedRequest({ requestId: 'r1', status: 'pending' });
      await expect(
        markRequestComplete.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: { stakeId: STAKE_ID, requestId: 'r1', kindooUid: 42 },
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('rejects non-string provisioningNote with invalid-argument', async () => {
      await seedManager();
      await seedRequest({ requestId: 'r1', status: 'pending' });
      await expect(
        markRequestComplete.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: { stakeId: STAKE_ID, requestId: 'r1', provisioningNote: { x: 1 } },
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('rejects oversized provisioningNote (>500 chars) with invalid-argument', async () => {
      await seedManager();
      await seedRequest({ requestId: 'r1', status: 'pending' });
      await expect(
        markRequestComplete.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: {
              stakeId: STAKE_ID,
              requestId: 'r1',
              provisioningNote: 'x'.repeat(501),
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });
  });

  // Seat-side completion behaviour. The callable mirrors the SPA's
  // `useCompleteAddRequest` / `useCompleteRemoveRequest` hooks so that
  // the extension and SPA produce identical Firestore state for any
  // request they can both complete. Bug repro: prior to this, the
  // callable only flipped the request doc — so a v2.2 "Provision &
  // Complete" run that created request 1 left no seat behind, and the
  // extension's `getSeatByEmail` returned null when request 2 came in,
  // breaking the merged-description path.
  describe('seat-side completion (mirrors SPA hooks)', () => {
    it('add_manual: creates the seat with the request grant as primary', async () => {
      await seedManager();
      await seedRequest({
        requestId: 'r1',
        status: 'pending',
        type: 'add_manual',
        scope: 'CO',
        building_names: ['Cordera Building'],
        reason: 'sub teacher',
      });

      await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      );

      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(seat).toBeDefined();
      expect(seat.member_canonical).toBe('alice@gmail.com');
      expect(seat.scope).toBe('CO');
      expect(seat.type).toBe('manual');
      expect(seat.callings).toEqual([]);
      expect(seat.building_names).toEqual(['Cordera Building']);
      expect(seat.duplicate_grants).toEqual([]);
      expect(seat.granted_by_request).toBe('r1');
      expect(seat.reason).toBe('sub teacher');
      // start_date / end_date never set on add_manual seats.
      expect(seat.start_date ?? null).toBeNull();
      expect(seat.end_date ?? null).toBeNull();
      // Request flip happens in the same transaction.
      const after = (await db.doc(`stakes/${STAKE_ID}/requests/r1`).get()).data() as AccessRequest;
      expect(after.status).toBe('complete');
    });

    it('add_temp: creates the seat with type=temp and start/end dates', async () => {
      await seedManager();
      await seedRequest({
        requestId: 'r1',
        status: 'pending',
        type: 'add_temp',
        scope: 'CO',
        building_names: ['Cordera Building'],
        reason: 'cleaning crew',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
      });

      await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      );

      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(seat.type).toBe('temp');
      expect(seat.start_date).toBe('2026-06-01');
      expect(seat.end_date).toBe('2026-06-30');
      expect(seat.granted_by_request).toBe('r1');
    });

    // Extension v2.2 — the callable diverges from the SPA hook when a
    // seat already exists. The SPA throws "reconcile via All Seats
    // first" because it has the reconcile UI; the extension does not,
    // so the callable auto-merges the new grant into the existing seat
    // (primary scope+type match → extend primary's building_names;
    // duplicate scope+type match → extend that duplicate's
    // building_names; no match → append a new duplicate_grants entry).
    // The "create-new-seat" path is unaffected — those tests live in
    // the create-* group above; below covers the merge variants.

    describe('add-type auto-merge into existing seat', () => {
      it('primary match (scope+type): extends primary building_names', async () => {
        await seedManager();
        await seedStake();
        await seedSeat({
          canonical: 'alice@gmail.com',
          scope: 'stake',
          type: 'manual',
          building_names: ['Cordera Building'],
        });
        await seedRequest({
          requestId: 'r1',
          status: 'pending',
          type: 'add_manual',
          scope: 'stake',
          building_names: ['Briargate Building'],
        });

        await markRequestComplete.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: { stakeId: STAKE_ID, requestId: 'r1' },
          }),
        );

        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()
        ).data() as Seat;
        expect(seat.scope).toBe('stake');
        expect(seat.type).toBe('manual');
        expect(seat.building_names).toEqual(['Cordera Building', 'Briargate Building']);
        // No duplicate appended on a primary match.
        expect(seat.duplicate_grants).toEqual([]);
        const after = (
          await db.doc(`stakes/${STAKE_ID}/requests/r1`).get()
        ).data() as AccessRequest;
        expect(after.status).toBe('complete');
      });

      it('primary scope-mismatch: appends a new duplicate_grants entry; primary unchanged', async () => {
        await seedManager();
        await seedStake();
        await seedSeat({
          canonical: 'alice@gmail.com',
          scope: 'stake',
          type: 'manual',
          building_names: ['Cordera Building'],
          reason: 'sub teacher',
        });
        await seedRequest({
          requestId: 'r1',
          status: 'pending',
          type: 'add_manual',
          scope: 'CO',
          building_names: ['Cordera Building'],
          reason: 'second-ward helper',
        });

        await markRequestComplete.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: { stakeId: STAKE_ID, requestId: 'r1' },
          }),
        );

        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()
        ).data() as Seat;
        // Primary stays as it was.
        expect(seat.scope).toBe('stake');
        expect(seat.type).toBe('manual');
        expect(seat.building_names).toEqual(['Cordera Building']);
        expect(seat.reason).toBe('sub teacher');
        // New entry appended.
        expect(seat.duplicate_grants.length).toBe(1);
        const dup = seat.duplicate_grants[0]!;
        expect(dup.scope).toBe('CO');
        expect(dup.type).toBe('manual');
        expect(dup.building_names).toEqual(['Cordera Building']);
        expect(dup.reason).toBe('second-ward helper');
        expect(dup.detected_at).toBeDefined();
      });

      it('add_temp primary match: extends primary building_names', async () => {
        await seedManager();
        await seedStake();
        await seedSeat({
          canonical: 'alice@gmail.com',
          scope: 'stake',
          type: 'temp',
          building_names: ['Cordera Building'],
        });
        await seedRequest({
          requestId: 'r1',
          status: 'pending',
          type: 'add_temp',
          scope: 'stake',
          building_names: ['Briargate Building'],
          start_date: '2026-06-01',
          end_date: '2026-06-30',
        });

        await markRequestComplete.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: { stakeId: STAKE_ID, requestId: 'r1' },
          }),
        );

        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()
        ).data() as Seat;
        expect(seat.type).toBe('temp');
        expect(seat.scope).toBe('stake');
        expect(seat.building_names).toEqual(['Cordera Building', 'Briargate Building']);
        expect(seat.duplicate_grants).toEqual([]);
      });

      it('type-mismatch (manual primary, temp request): appends a temp duplicate_grants entry; primary stays manual', async () => {
        await seedManager();
        await seedStake();
        await seedSeat({
          canonical: 'alice@gmail.com',
          scope: 'stake',
          type: 'manual',
          building_names: ['Cordera Building'],
          reason: 'sub teacher',
        });
        await seedRequest({
          requestId: 'r1',
          status: 'pending',
          type: 'add_temp',
          scope: 'stake',
          building_names: ['Briargate Building'],
          start_date: '2026-06-01',
          end_date: '2026-06-30',
          reason: 'cleaning crew',
        });

        await markRequestComplete.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: { stakeId: STAKE_ID, requestId: 'r1' },
          }),
        );

        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()
        ).data() as Seat;
        // Primary unchanged — same scope, type, building_names.
        expect(seat.type).toBe('manual');
        expect(seat.scope).toBe('stake');
        expect(seat.building_names).toEqual(['Cordera Building']);
        expect(seat.reason).toBe('sub teacher');
        // New temp duplicate appended.
        expect(seat.duplicate_grants.length).toBe(1);
        const dup = seat.duplicate_grants[0]!;
        expect(dup.scope).toBe('stake');
        expect(dup.type).toBe('temp');
        expect(dup.building_names).toEqual(['Briargate Building']);
        expect(dup.start_date).toBe('2026-06-01');
        expect(dup.end_date).toBe('2026-06-30');
        expect(dup.reason).toBe('cleaning crew');
      });

      it('building merge de-duplicates and preserves order', async () => {
        await seedManager();
        await seedStake();
        await seedSeat({
          canonical: 'alice@gmail.com',
          scope: 'stake',
          type: 'manual',
          building_names: ['A', 'B'],
        });
        await seedRequest({
          requestId: 'r1',
          status: 'pending',
          type: 'add_manual',
          scope: 'stake',
          building_names: ['B', 'C'],
        });

        await markRequestComplete.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: { stakeId: STAKE_ID, requestId: 'r1' },
          }),
        );

        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()
        ).data() as Seat;
        expect(seat.building_names).toEqual(['A', 'B', 'C']);
      });

      it('existing duplicate_grants entry match: extends that duplicate; primary untouched', async () => {
        await seedManager();
        await seedStake();
        await seedSeat({
          canonical: 'alice@gmail.com',
          scope: 'stake',
          type: 'manual',
          building_names: ['Cordera Building'],
          duplicate_grants: [
            {
              scope: 'CO',
              type: 'manual',
              building_names: ['Cordera Building'],
              detected_at: Timestamp.fromMillis(2_000),
              reason: 'prior-helper',
            },
          ],
        });
        await seedRequest({
          requestId: 'r1',
          status: 'pending',
          type: 'add_manual',
          scope: 'CO',
          building_names: ['Briargate Building'],
        });

        await markRequestComplete.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: { stakeId: STAKE_ID, requestId: 'r1' },
          }),
        );

        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()
        ).data() as Seat;
        // Primary unchanged.
        expect(seat.scope).toBe('stake');
        expect(seat.building_names).toEqual(['Cordera Building']);
        // Existing duplicate extended; reason preserved.
        expect(seat.duplicate_grants.length).toBe(1);
        const dup = seat.duplicate_grants[0]!;
        expect(dup.scope).toBe('CO');
        expect(dup.type).toBe('manual');
        expect(dup.building_names).toEqual(['Cordera Building', 'Briargate Building']);
        expect(dup.reason).toBe('prior-helper');
      });

      it('merge into over-cap pool succeeds (cap no longer a guard); pool remains over-cap in last_over_caps_json', async () => {
        // Post-2026-05-12 pivot: cap is not enforced; completion always
        // succeeds. The pool stays over-cap because the merge doesn't
        // change pool counts (extending primary's building_names leaves
        // `s.scope === 'stake'` set count unchanged), so the importer's
        // earlier over-cap finding remains valid post-write.
        await seedManager();
        await seedStake({
          stake_seat_cap: 1,
          overCaps: [{ pool: 'stake', count: 2, cap: 1, over_by: 1 }],
        });
        // Seed two stake-scope seats so post-write count = 2 > cap 1.
        await seedSeat({
          canonical: 'alice@gmail.com',
          scope: 'stake',
          type: 'manual',
          building_names: ['Cordera Building'],
        });
        await seedSeat({
          canonical: 'bob@gmail.com',
          scope: 'stake',
          type: 'manual',
          building_names: ['Briargate Building'],
        });
        await seedRequest({
          requestId: 'r1',
          status: 'pending',
          type: 'add_manual',
          scope: 'stake',
          building_names: ['Briargate Building'],
        });

        const result = await markRequestComplete.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: { stakeId: STAKE_ID, requestId: 'r1' },
          }),
        );

        // Completion succeeds; output echoes the over-cap state.
        expect(result.ok).toBe(true);
        expect(result.over_caps).toEqual([{ pool: 'stake', count: 2, cap: 1, over_by: 1 }]);

        // Seat write applied; request flipped.
        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()
        ).data() as Seat;
        expect(seat.building_names).toEqual(['Cordera Building', 'Briargate Building']);
        const after = (
          await db.doc(`stakes/${STAKE_ID}/requests/r1`).get()
        ).data() as AccessRequest;
        expect(after.status).toBe('complete');

        // Stake doc reflects the recomputed snapshot.
        const stake = (await db.doc(`stakes/${STAKE_ID}`).get()).data() as Stake;
        expect(stake.last_over_caps_json).toEqual([
          { pool: 'stake', count: 2, cap: 1, over_by: 1 },
        ]);
      });

      it('no-op merge (request building_names already present): flips request without writing seat', async () => {
        await seedManager();
        await seedStake();
        await seedSeat({
          canonical: 'alice@gmail.com',
          scope: 'stake',
          type: 'manual',
          building_names: ['Cordera Building', 'Briargate Building'],
        });
        await seedRequest({
          requestId: 'r1',
          status: 'pending',
          type: 'add_manual',
          scope: 'stake',
          building_names: ['Cordera Building'],
        });

        await markRequestComplete.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: { stakeId: STAKE_ID, requestId: 'r1' },
          }),
        );

        const { db } = requireEmulators();
        const seat = (
          await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()
        ).data() as Seat;
        expect(seat.building_names).toEqual(['Cordera Building', 'Briargate Building']);
        const after = (
          await db.doc(`stakes/${STAKE_ID}/requests/r1`).get()
        ).data() as AccessRequest;
        expect(after.status).toBe('complete');
      });
    });

    it('remove: flips the request without writing a seat doc; trigger handles delete', async () => {
      await seedManager();
      await seedSeat({ canonical: 'alice@gmail.com', scope: 'CO' });
      await seedRequest({
        requestId: 'r1',
        status: 'pending',
        type: 'remove',
        scope: 'CO',
      });

      await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      );

      const { db } = requireEmulators();
      const after = (await db.doc(`stakes/${STAKE_ID}/requests/r1`).get()).data() as AccessRequest;
      expect(after.status).toBe('complete');
      // No R-1 race — seat existed at completion time, so no system
      // tag. completion_note left absent (no manager prose).
      expect(after.completion_note ?? null).toBeNull();
      // Seat still present here because the trigger is not driven by
      // `.run()` — it fires on the real Firestore write event. The
      // removeSeatOnRequestComplete test file covers the trigger path
      // directly; here we only assert the callable does not delete.
      const seat = await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get();
      expect(seat.exists).toBe(true);
    });

    it('remove: R-1 race stamps the system note when the seat is already gone', async () => {
      await seedManager();
      await seedRequest({
        requestId: 'r1',
        status: 'pending',
        type: 'remove',
        scope: 'CO',
      });

      await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      );

      const { db } = requireEmulators();
      const after = (await db.doc(`stakes/${STAKE_ID}/requests/r1`).get()).data() as AccessRequest;
      expect(after.status).toBe('complete');
      expect(after.completion_note).toBe('Seat already removed at completion time (no-op).');
    });

    it('remove: R-1 race appends the system tag to manager prose when both are present', async () => {
      await seedManager();
      await seedRequest({
        requestId: 'r1',
        status: 'pending',
        type: 'remove',
        scope: 'CO',
      });

      await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: {
            stakeId: STAKE_ID,
            requestId: 'r1',
            completionNote: 'manager handled in person',
          },
        }),
      );

      const { db } = requireEmulators();
      const after = (await db.doc(`stakes/${STAKE_ID}/requests/r1`).get()).data() as AccessRequest;
      expect(after.completion_note).toBe(
        'manager handled in person\n\n[System: Seat already removed at completion time (no-op).]',
      );
    });

    // Create-path coverage that didn't fit cleanly into the happy-path
    // tests above.
    it('add_manual with multiple building_names: all land on the new primary', async () => {
      await seedManager();
      await seedRequest({
        requestId: 'r1',
        status: 'pending',
        type: 'add_manual',
        scope: 'stake',
        building_names: ['Cordera Building', 'Briargate Building', 'Lexington Building'],
      });

      await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      );

      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(seat.building_names).toEqual([
        'Cordera Building',
        'Briargate Building',
        'Lexington Building',
      ]);
    });

    it('add_manual ward-scope with empty building_names: falls back to ward.building_name', async () => {
      await seedManager();
      await seedWard({ ward_code: 'CO', building_name: 'Cordera Building', seat_cap: 10 });
      await seedRequest({
        requestId: 'r1',
        status: 'pending',
        type: 'add_manual',
        scope: 'CO',
        building_names: [],
      });

      await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      );

      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(seat.scope).toBe('CO');
      expect(seat.building_names).toEqual(['Cordera Building']);
    });
  });

  // ----------------------------------------------------------------------
  // Cap-pivot policy (2026-05-12+).
  //
  // markRequestComplete no longer rejects for over-cap. Kindoo is the
  // source of truth — if Kindoo accepted the user, SBA reflects that.
  // The callable recomputes over-caps from the post-write seat set
  // inside the same transaction, writes the snapshot to
  // `stake.last_over_caps_json`, and echoes it on the response. The
  // existing `notifyOnOverCap` trigger fires on the empty-to-non-empty
  // transition.
  // ----------------------------------------------------------------------
  describe('over-cap recompute (post-2026-05-12 pivot)', () => {
    it('create that pushes the stake-wide pool from at-cap to over-cap: succeeds + over_caps populated', async () => {
      // stake_seat_cap = 2, no ward seats, 2 existing stake seats →
      // already at cap. Adding a 3rd stake-scope seat → over by 1.
      await seedManager();
      await seedStake({ stake_seat_cap: 2 });
      await seedSeat({
        canonical: 'bob@gmail.com',
        scope: 'stake',
        type: 'manual',
        building_names: ['Cordera Building'],
      });
      await seedSeat({
        canonical: 'carol@gmail.com',
        scope: 'stake',
        type: 'manual',
        building_names: ['Cordera Building'],
      });
      await seedRequest({
        requestId: 'r1',
        status: 'pending',
        type: 'add_manual',
        scope: 'stake',
        building_names: ['Cordera Building'],
      });

      const result = await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      );

      expect(result.ok).toBe(true);
      expect(result.over_caps).toEqual([{ pool: 'stake', count: 3, cap: 2, over_by: 1 }]);

      const { db } = requireEmulators();
      const stake = (await db.doc(`stakes/${STAKE_ID}`).get()).data() as Stake;
      expect(stake.last_over_caps_json).toEqual([{ pool: 'stake', count: 3, cap: 2, over_by: 1 }]);
    });

    it('create that pushes a ward pool over cap: succeeds + ward entry in last_over_caps_json', async () => {
      await seedManager();
      await seedStake({ stake_seat_cap: 100 });
      await seedWard({ ward_code: 'CO', building_name: 'Cordera Building', seat_cap: 1 });
      await seedSeat({
        canonical: 'bob@gmail.com',
        scope: 'CO',
        type: 'manual',
        building_names: ['Cordera Building'],
      });
      await seedRequest({
        requestId: 'r1',
        status: 'pending',
        type: 'add_manual',
        scope: 'CO',
        building_names: ['Cordera Building'],
      });

      const result = await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      );

      expect(result.over_caps).toEqual([{ pool: 'CO', count: 2, cap: 1, over_by: 1 }]);

      const { db } = requireEmulators();
      const stake = (await db.doc(`stakes/${STAKE_ID}`).get()).data() as Stake;
      expect(stake.last_over_caps_json).toEqual([{ pool: 'CO', count: 2, cap: 1, over_by: 1 }]);
    });

    it('completion that does not push any pool over cap: writes [] (clears any stale state)', async () => {
      await seedManager();
      await seedStake({ stake_seat_cap: 100 });
      await seedWard({ ward_code: 'CO', building_name: 'Cordera Building', seat_cap: 10 });
      await seedRequest({
        requestId: 'r1',
        status: 'pending',
        type: 'add_manual',
        scope: 'CO',
        building_names: ['Cordera Building'],
      });

      const result = await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      );

      expect(result.over_caps).toEqual([]);

      const { db } = requireEmulators();
      const stake = (await db.doc(`stakes/${STAKE_ID}`).get()).data() as Stake;
      expect(stake.last_over_caps_json).toEqual([]);
    });

    it('two-pool over-cap: both ward and stake portion appear in last_over_caps_json', async () => {
      // stake_seat_cap=2, ward CO seat_cap=1. Existing: 1 stake-scope +
      // 2 CO-scope (CO already over by 1 — captured by the importer).
      // Now adding a new stake-scope seat: post-write stake-portion =
      // 2 - 2(ward CO seats) = 0; stake count = 2 > 0 → stake over by
      // 2; CO unchanged at over_by 1. Two entries.
      await seedManager();
      await seedStake({ stake_seat_cap: 2 });
      await seedWard({ ward_code: 'CO', building_name: 'Cordera Building', seat_cap: 1 });
      await seedSeat({
        canonical: 'bob@gmail.com',
        scope: 'stake',
        type: 'manual',
        building_names: ['Cordera Building'],
      });
      await seedSeat({
        canonical: 'carol@gmail.com',
        scope: 'CO',
        type: 'manual',
        building_names: ['Cordera Building'],
      });
      await seedSeat({
        canonical: 'dave@gmail.com',
        scope: 'CO',
        type: 'manual',
        building_names: ['Cordera Building'],
      });
      await seedRequest({
        requestId: 'r1',
        status: 'pending',
        type: 'add_manual',
        scope: 'stake',
        building_names: ['Cordera Building'],
      });

      const result = await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      );

      // CO over by 1 (2 vs 1) AND stake-portion over by 2 (2 vs 0).
      expect(result.over_caps).toEqual([
        { pool: 'CO', count: 2, cap: 1, over_by: 1 },
        { pool: 'stake', count: 2, cap: 0, over_by: 2 },
      ]);
    });

    it('pool was over before AND stays over after a count-changing completion: over_by reflects new count', async () => {
      // 2 stake-scope seats with stake_seat_cap=1 → over_by 1. Adding a
      // 3rd stake-scope seat → over_by 2 in the post-write snapshot.
      await seedManager();
      await seedStake({
        stake_seat_cap: 1,
        overCaps: [{ pool: 'stake', count: 2, cap: 1, over_by: 1 }],
      });
      await seedSeat({
        canonical: 'bob@gmail.com',
        scope: 'stake',
        type: 'manual',
        building_names: ['Cordera Building'],
      });
      await seedSeat({
        canonical: 'carol@gmail.com',
        scope: 'stake',
        type: 'manual',
        building_names: ['Cordera Building'],
      });
      await seedRequest({
        requestId: 'r1',
        status: 'pending',
        type: 'add_manual',
        scope: 'stake',
        building_names: ['Cordera Building'],
      });

      const result = await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      );

      expect(result.over_caps).toEqual([{ pool: 'stake', count: 3, cap: 1, over_by: 2 }]);
      const { db } = requireEmulators();
      const stake = (await db.doc(`stakes/${STAKE_ID}`).get()).data() as Stake;
      expect(stake.last_over_caps_json).toEqual([{ pool: 'stake', count: 3, cap: 1, over_by: 2 }]);
    });

    it('merge against an existing seat in an already-over-cap pool: succeeds; entry preserved unchanged', async () => {
      // Two stake-scope seats with cap=1 → over by 1. Merge into
      // alice's primary doesn't change pool counts, so the snapshot is
      // identical post-write.
      await seedManager();
      await seedStake({
        stake_seat_cap: 1,
        overCaps: [{ pool: 'stake', count: 2, cap: 1, over_by: 1 }],
      });
      await seedSeat({
        canonical: 'alice@gmail.com',
        scope: 'stake',
        type: 'manual',
        building_names: ['Cordera Building'],
      });
      await seedSeat({
        canonical: 'bob@gmail.com',
        scope: 'stake',
        type: 'manual',
        building_names: ['Cordera Building'],
      });
      await seedRequest({
        requestId: 'r1',
        status: 'pending',
        type: 'add_manual',
        scope: 'stake',
        building_names: ['Briargate Building'],
      });

      const result = await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      );

      expect(result.over_caps).toEqual([{ pool: 'stake', count: 2, cap: 1, over_by: 1 }]);
      const { db } = requireEmulators();
      const stake = (await db.doc(`stakes/${STAKE_ID}`).get()).data() as Stake;
      expect(stake.last_over_caps_json).toEqual([{ pool: 'stake', count: 2, cap: 1, over_by: 1 }]);
      // Seat write applied.
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(seat.building_names).toEqual(['Cordera Building', 'Briargate Building']);
    });

    it('remove path does NOT touch last_over_caps_json (responsibility split with seat-delete trigger)', async () => {
      // Pre-existing over-cap state captured by the importer must
      // survive a remove completion — the seat-delete trigger owns the
      // post-remove recompute, not the callable.
      const pre: OverCapEntry[] = [{ pool: 'stake', count: 2, cap: 1, over_by: 1 }];
      await seedManager();
      await seedStake({ stake_seat_cap: 1, overCaps: pre });
      await seedSeat({ canonical: 'alice@gmail.com', scope: 'stake' });
      await seedRequest({
        requestId: 'r1',
        status: 'pending',
        type: 'remove',
        scope: 'stake',
      });

      const result = await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      );

      // Remove path returns empty over_caps (no recompute performed).
      expect(result.over_caps).toEqual([]);
      const { db } = requireEmulators();
      const stake = (await db.doc(`stakes/${STAKE_ID}`).get()).data() as Stake;
      expect(stake.last_over_caps_json).toEqual(pre);
    });
  });

  // ----------------------------------------------------------------------
  // Audit smoke check. The audit trigger is wired to onDocumentWritten,
  // so it does not fire under callable .run(). We invoke the trigger
  // directly with a before/after constructed from observed Firestore
  // state to confirm the request-flip write produces a valid audit row.
  // ----------------------------------------------------------------------
  describe('audit smoke check', () => {
    it('happy-path completion produces a valid audit row via auditRequestWrites', async () => {
      // Seed a request from a different requester than the completer so
      // the `lastActor` field genuinely changes across before/after —
      // otherwise the audit trigger's out-of-band carve-out kicks in
      // and resolves the actor to `OutOfBand` (per B-5).
      await seedManager();
      const { db } = requireEmulators();
      await db.doc(`stakes/${STAKE_ID}/requests/r1`).set({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'CO',
        member_email: 'alice@gmail.com',
        member_canonical: 'alice@gmail.com',
        member_name: 'Alice',
        reason: 'helper',
        comment: '',
        building_names: [],
        status: 'pending',
        requester_email: 'requester@gmail.com',
        requester_canonical: 'requester@gmail.com',
        requested_at: Timestamp.fromMillis(1_000),
        lastActor: { email: 'requester@gmail.com', canonical: 'requester@gmail.com' },
      });
      const beforeSnap = await db.doc(`stakes/${STAKE_ID}/requests/r1`).get();
      const before = beforeSnap.data() as AccessRequest;

      await markRequestComplete.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, requestId: 'r1' },
        }),
      );

      const afterSnap = await db.doc(`stakes/${STAKE_ID}/requests/r1`).get();
      const after = afterSnap.data() as AccessRequest;

      const time = '2026-05-12T18:00:00.000Z';
      const event = {
        params: { stakeId: STAKE_ID, requestId: 'r1' },
        time,
        data: {
          before: { exists: true, data: () => before },
          after: { exists: true, data: () => after },
        },
      } as unknown as never;
      await auditRequestWrites.run(event);

      const audit = await db.collection(`stakes/${STAKE_ID}/auditLog`).get();
      expect(audit.empty).toBe(false);
      const row = audit.docs[0]!.data() as AuditLog;
      expect(row.entity_type).toBe('request');
      expect(row.entity_id).toBe('r1');
      expect(row.actor_canonical).toBe(MANAGER_EMAIL);
    });
  });
});
