// Integration tests for the `markRequestComplete` callable. Invoked
// from the Chrome MV3 extension's side panel after the manager has
// worked the door system. Flips a pending request to `complete` —
// the audit trigger + email trigger handle the fan-out from the
// resulting write.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { AccessRequest, Seat } from '@kindoo/shared';
import { markRequestComplete } from '../src/callable/markRequestComplete.js';
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
    duplicate_grants: [],
    granted_by_request: 'seed',
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
    expect(result).toEqual({ ok: true });

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
      expect(result).toEqual({ ok: true });

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

    // Mirrors the SPA's "already has a seat" guard. The SPA does not
    // do duplicate-grant merge on completion — that flow is handled
    // by the All Seats Reconcile dialog. Surface a friendly message
    // instead of the raw permission-denied a no-op create would yield.
    it('add_manual: errors with failed-precondition when the seat already exists', async () => {
      await seedManager();
      await seedSeat({ canonical: 'alice@gmail.com', scope: 'stake' });
      await seedRequest({
        requestId: 'r1',
        status: 'pending',
        type: 'add_manual',
        scope: 'CO',
        building_names: ['Cordera Building'],
      });

      await expect(
        markRequestComplete.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: { stakeId: STAKE_ID, requestId: 'r1' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'failed-precondition' });

      // The seat write and the request flip share a transaction —
      // the request must stay pending when the seat-exists check
      // fails.
      const { db } = requireEmulators();
      const after = (await db.doc(`stakes/${STAKE_ID}/requests/r1`).get()).data() as AccessRequest;
      expect(after.status).toBe('pending');
      // Existing seat untouched.
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(seat.scope).toBe('stake');
    });

    it('add_temp: errors with failed-precondition when an existing permanent seat is present', async () => {
      await seedManager();
      await seedSeat({ canonical: 'alice@gmail.com', scope: 'stake', type: 'manual' });
      await seedRequest({
        requestId: 'r1',
        status: 'pending',
        type: 'add_temp',
        scope: 'CO',
        building_names: ['Cordera Building'],
        start_date: '2026-06-01',
        end_date: '2026-06-30',
      });

      await expect(
        markRequestComplete.run(
          callableReq({
            auth: { email: MANAGER_EMAIL },
            data: { stakeId: STAKE_ID, requestId: 'r1' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'failed-precondition' });
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
  });
});
