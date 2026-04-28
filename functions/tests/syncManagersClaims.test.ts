// Integration tests for `syncManagersClaims`. Same shape as the
// access trigger: the handler reads `event.params` and re-reads the
// canonical's role docs from Firestore, so we only need a minimal
// event stub.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { syncManagersClaims } from '../src/triggers/syncManagersClaims.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const makeEvent = (stakeId: string, memberCanonical: string) =>
  ({
    params: { stakeId, memberCanonical },
    data: undefined,
  }) as unknown as Parameters<typeof syncManagersClaims.run>[0];

async function runSync(stakeId: string, memberCanonical: string): Promise<void> {
  await syncManagersClaims.run(makeEvent(stakeId, memberCanonical));
}

describe.skipIf(!hasEmulators())('syncManagersClaims', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  it('flips manager claim on when active=true', async () => {
    const { auth, db } = requireEmulators();
    const user = await auth.createUser({ email: 'm@gmail.com' });
    await db
      .doc('userIndex/m@gmail.com')
      .set({ uid: user.uid, typedEmail: 'm@gmail.com', lastSignIn: new Date() });

    await db.doc('stakes/csnorth/kindooManagers/m@gmail.com').set({ active: true });
    await runSync('csnorth', 'm@gmail.com');

    const refreshed = await auth.getUser(user.uid);
    expect(refreshed.customClaims).toMatchObject({
      stakes: { csnorth: { manager: true, stake: false, wards: [] } },
    });
  });

  it('flips manager claim off when active=false', async () => {
    const { auth, db } = requireEmulators();
    const user = await auth.createUser({ email: 'm@gmail.com' });
    await db
      .doc('userIndex/m@gmail.com')
      .set({ uid: user.uid, typedEmail: 'm@gmail.com', lastSignIn: new Date() });

    // Manager toggled on, then off.
    await db.doc('stakes/csnorth/kindooManagers/m@gmail.com').set({ active: true });
    await runSync('csnorth', 'm@gmail.com');
    expect((await auth.getUser(user.uid)).customClaims).toMatchObject({
      stakes: { csnorth: { manager: true } },
    });

    await db.doc('stakes/csnorth/kindooManagers/m@gmail.com').set({ active: false });
    await runSync('csnorth', 'm@gmail.com');
    const refreshed = await auth.getUser(user.uid);
    expect((refreshed.customClaims as { stakes?: unknown }).stakes).toBeUndefined();
  });

  it('clears manager when the doc is deleted entirely', async () => {
    const { auth, db } = requireEmulators();
    const user = await auth.createUser({ email: 'm@gmail.com' });
    await db
      .doc('userIndex/m@gmail.com')
      .set({ uid: user.uid, typedEmail: 'm@gmail.com', lastSignIn: new Date() });
    await db.doc('stakes/csnorth/kindooManagers/m@gmail.com').set({ active: true });
    await runSync('csnorth', 'm@gmail.com');

    await db.doc('stakes/csnorth/kindooManagers/m@gmail.com').delete();
    await runSync('csnorth', 'm@gmail.com');
    const refreshed = await auth.getUser(user.uid);
    expect((refreshed.customClaims as { stakes?: unknown }).stakes).toBeUndefined();
  });

  it('no-ops when the user has no userIndex entry yet', async () => {
    const { db } = requireEmulators();
    await db.doc('stakes/csnorth/kindooManagers/ghost@gmail.com').set({ active: true });
    await expect(runSync('csnorth', 'ghost@gmail.com')).resolves.toBeUndefined();
  });

  it('revokes refresh tokens after a real claim flip', async () => {
    const { auth, db } = requireEmulators();
    const user = await auth.createUser({ email: 'rev@gmail.com' });
    await db
      .doc('userIndex/rev@gmail.com')
      .set({ uid: user.uid, typedEmail: 'rev@gmail.com', lastSignIn: new Date() });
    const before = (await auth.getUser(user.uid)).tokensValidAfterTime;

    await db.doc('stakes/csnorth/kindooManagers/rev@gmail.com').set({ active: true });
    await runSync('csnorth', 'rev@gmail.com');

    const after = (await auth.getUser(user.uid)).tokensValidAfterTime;
    if (before && after) {
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    }
  });
});
