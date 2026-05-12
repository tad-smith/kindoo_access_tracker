// Integration tests for the `markRequestComplete` callable. Invoked
// from the Chrome MV3 extension's side panel after the manager has
// worked the door system. Flips a pending request to `complete` —
// the audit trigger + email trigger handle the fan-out from the
// resulting write.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { AccessRequest } from '@kindoo/shared';
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
}): Promise<void> {
  const { db } = requireEmulators();
  await db.doc(`stakes/${STAKE_ID}/requests/${opts.requestId}`).set({
    request_id: opts.requestId,
    type: 'add_manual',
    scope: 'CO',
    member_email: 'alice@gmail.com',
    member_canonical: 'alice@gmail.com',
    member_name: 'Alice',
    reason: 'helper',
    comment: '',
    building_names: [],
    status: opts.status,
    requester_email: MANAGER_EMAIL,
    requester_canonical: MANAGER_EMAIL,
    requested_at: Timestamp.fromMillis(1_000),
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
});
