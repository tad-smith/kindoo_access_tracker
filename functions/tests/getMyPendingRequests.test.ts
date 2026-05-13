// Integration tests for the `getMyPendingRequests` callable. The
// callable is the bridge for the Chrome MV3 extension's side-panel
// queue surface. We invoke `.run({ data, auth })` directly — that's
// the test hook firebase-functions v2 exposes on `CallableFunction`.
//
// Coverage:
//   - Happy path: active manager → returns the FIFO list.
//   - Unauthenticated caller → `HttpsError('unauthenticated')`.
//   - Signed-in non-manager → `HttpsError('permission-denied')`.
//   - Signed-in manager with active=false → `HttpsError('permission-denied')`.
//   - Filtering: returns only `status=='pending'` rows, oldest first.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { AccessRequest } from '@kindoo/shared';
import { getMyPendingRequests } from '../src/callable/getMyPendingRequests.js';
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
  requestedAt: Timestamp;
  memberEmail?: string;
}): Promise<void> {
  const { db } = requireEmulators();
  const memberEmail = opts.memberEmail ?? 'alice@gmail.com';
  await db.doc(`stakes/${STAKE_ID}/requests/${opts.requestId}`).set({
    request_id: opts.requestId,
    type: 'add_manual',
    scope: 'CO',
    member_email: memberEmail,
    member_canonical: memberEmail,
    member_name: 'Alice',
    reason: 'helper',
    comment: '',
    building_names: [],
    status: opts.status,
    requester_email: MANAGER_EMAIL,
    requester_canonical: MANAGER_EMAIL,
    requested_at: opts.requestedAt,
    lastActor: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
  });
}

/** Build a v2 CallableRequest stub with the fields our handler reads. */
function callableReq(opts: { auth?: { email: string } | null; data: unknown }): never {
  return {
    data: opts.data,
    auth: opts.auth ? { uid: opts.auth.email, token: { email: opts.auth.email } } : undefined,
    rawRequest: {} as unknown,
    acceptsStreaming: false,
  } as unknown as never;
}

describe.skipIf(!hasEmulators())('getMyPendingRequests callable', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  it('returns pending requests oldest-first when caller is an active manager', async () => {
    await seedManager();
    // Seed three pending requests with explicit out-of-order timestamps
    // so the FIFO sort is non-trivially verified.
    await seedRequest({
      requestId: 'r2',
      status: 'pending',
      requestedAt: Timestamp.fromMillis(2_000),
      memberEmail: 'bob@gmail.com',
    });
    await seedRequest({
      requestId: 'r1',
      status: 'pending',
      requestedAt: Timestamp.fromMillis(1_000),
      memberEmail: 'alice@gmail.com',
    });
    await seedRequest({
      requestId: 'r3',
      status: 'pending',
      requestedAt: Timestamp.fromMillis(3_000),
      memberEmail: 'carol@gmail.com',
    });

    const result = await getMyPendingRequests.run(
      callableReq({ auth: { email: MANAGER_EMAIL }, data: { stakeId: STAKE_ID } }),
    );

    expect(result.requests.map((r: AccessRequest) => r.request_id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('filters out non-pending requests', async () => {
    await seedManager();
    await seedRequest({
      requestId: 'pending-1',
      status: 'pending',
      requestedAt: Timestamp.fromMillis(1_000),
      memberEmail: 'alice@gmail.com',
    });
    await seedRequest({
      requestId: 'complete-1',
      status: 'complete',
      requestedAt: Timestamp.fromMillis(2_000),
      memberEmail: 'bob@gmail.com',
    });
    await seedRequest({
      requestId: 'rejected-1',
      status: 'rejected',
      requestedAt: Timestamp.fromMillis(3_000),
      memberEmail: 'carol@gmail.com',
    });
    await seedRequest({
      requestId: 'pending-2',
      status: 'pending',
      requestedAt: Timestamp.fromMillis(4_000),
      memberEmail: 'dan@gmail.com',
    });

    const result = await getMyPendingRequests.run(
      callableReq({ auth: { email: MANAGER_EMAIL }, data: { stakeId: STAKE_ID } }),
    );

    expect(result.requests.map((r: AccessRequest) => r.request_id)).toEqual([
      'pending-1',
      'pending-2',
    ]);
    expect(result.requests.every((r: AccessRequest) => r.status === 'pending')).toBe(true);
  });

  it('rejects an unauthenticated caller with HttpsError(unauthenticated)', async () => {
    await seedManager();
    await expect(
      getMyPendingRequests.run(callableReq({ auth: null, data: { stakeId: STAKE_ID } })),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a signed-in non-manager with permission-denied', async () => {
    // No kindooManagers doc → permission-denied.
    await expect(
      getMyPendingRequests.run(
        callableReq({ auth: { email: 'outsider@gmail.com' }, data: { stakeId: STAKE_ID } }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects a manager with active=false with permission-denied', async () => {
    await seedManager({ active: false });
    await expect(
      getMyPendingRequests.run(
        callableReq({ auth: { email: MANAGER_EMAIL }, data: { stakeId: STAKE_ID } }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects a call missing stakeId with invalid-argument', async () => {
    await expect(
      getMyPendingRequests.run(callableReq({ auth: { email: MANAGER_EMAIL }, data: {} })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
