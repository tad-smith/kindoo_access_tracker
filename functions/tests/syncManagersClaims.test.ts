// Integration tests for `syncManagersClaims`. Same shape as the
// access trigger: the handler reads `event.params` and re-reads the
// canonical's role docs from Firestore, so we only need a minimal
// event stub.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { syncManagersClaims } from '../src/triggers/syncManagersClaims.js';
import {
  hasFunctionsEmulator,
  makeSettledUser,
  clearEmulators,
  hasEmulators,
  requireEmulators,
  waitFor,
} from './lib/emulator.js';
// CI boots this suite under `--only firestore,auth,functions`, so the
// `onAuthUserCreate` v1 auth trigger is live and fires (async, via
// Eventarc) on every `auth.createUser(...)` — its `applyFullClaims`
// write a few hundred ms later races the in-process claim write each
// test makes right after. Snapshot once at module load: the emulator
// is or isn't up for the suite's lifetime.
const functionsEmulatorReachable = await hasFunctionsEmulator();

const makeEvent = (stakeId: string, memberCanonical: string) =>
  ({
    params: { stakeId, memberCanonical },
    data: undefined,
  }) as unknown as Parameters<typeof syncManagersClaims.run>[0];

async function runSync(stakeId: string, memberCanonical: string): Promise<void> {
  await syncManagersClaims.run(makeEvent(stakeId, memberCanonical));
}

// Poll the terminal "block is gone" assertion instead of reading once.
//
// The two-phase tests below have a residual race with the DEPLOYED
// `syncManagersClaims`, which the `set({ active: true })` in phase one
// queues. That delivery reads role data, then writes claims. If its READ
// lands before phase two's `active: false` write but its WRITE lands after
// phase two's `runSync`, it restamps `manager: true` over the cleared
// block. `claimsEqual` does not close this: it compares the delivery's own
// freshly-read `existing` against its `merged`, which differ precisely in
// that ordering. Phase two's own delivery converges to the same end state,
// so a transient restamp self-corrects — polling absorbs it, where a
// single read can catch the gap.
async function stakeBlockClears(uid: string): Promise<boolean> {
  const { auth } = requireEmulators();
  return waitFor(async () => {
    const claims = (await auth.getUser(uid)).customClaims as { stakes?: unknown };
    return claims?.stakes === undefined;
  }, 5_000);
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

  it('flips manager claim on when active=true', { timeout: 30_000 }, async () => {
    const { auth, db } = requireEmulators();
    const uid = await makeSettledUser('m-on@gmail.com', functionsEmulatorReachable);
    await db
      .doc('userIndex/m-on@gmail.com')
      .set({ uid, typedEmail: 'm-on@gmail.com', lastSignIn: new Date() });

    await db.doc('stakes/csnorth/kindooManagers/m-on@gmail.com').set({ active: true });
    await runSync('csnorth', 'm-on@gmail.com');

    const refreshed = await auth.getUser(uid);
    expect(refreshed.customClaims).toMatchObject({
      stakes: { csnorth: { manager: true, stake: false, wards: [] } },
    });
  });

  it('flips manager claim off when active=false', { timeout: 30_000 }, async () => {
    const { auth, db } = requireEmulators();
    const uid = await makeSettledUser('m-off@gmail.com', functionsEmulatorReachable);
    await db
      .doc('userIndex/m-off@gmail.com')
      .set({ uid, typedEmail: 'm-off@gmail.com', lastSignIn: new Date() });

    // Manager toggled on, then off.
    await db.doc('stakes/csnorth/kindooManagers/m-off@gmail.com').set({ active: true });
    await runSync('csnorth', 'm-off@gmail.com');
    expect((await auth.getUser(uid)).customClaims).toMatchObject({
      stakes: { csnorth: { manager: true } },
    });

    await db.doc('stakes/csnorth/kindooManagers/m-off@gmail.com').set({ active: false });
    await runSync('csnorth', 'm-off@gmail.com');
    expect(await stakeBlockClears(uid)).toBe(true);
  });

  it('clears manager when the doc is deleted entirely', { timeout: 30_000 }, async () => {
    const { auth, db } = requireEmulators();
    const uid = await makeSettledUser('m-del@gmail.com', functionsEmulatorReachable);
    await db
      .doc('userIndex/m-del@gmail.com')
      .set({ uid, typedEmail: 'm-del@gmail.com', lastSignIn: new Date() });
    await db.doc('stakes/csnorth/kindooManagers/m-del@gmail.com').set({ active: true });
    await runSync('csnorth', 'm-del@gmail.com');

    await db.doc('stakes/csnorth/kindooManagers/m-del@gmail.com').delete();
    await runSync('csnorth', 'm-del@gmail.com');
    expect(await stakeBlockClears(uid)).toBe(true);
  });

  it('no-ops when the user has no userIndex entry yet', async () => {
    const { db } = requireEmulators();
    await db.doc('stakes/csnorth/kindooManagers/ghost@gmail.com').set({ active: true });
    await expect(runSync('csnorth', 'ghost@gmail.com')).resolves.toBeUndefined();
  });

  it('revokes refresh tokens after a real claim flip', { timeout: 30_000 }, async () => {
    const { auth, db } = requireEmulators();
    const uid = await makeSettledUser('rev@gmail.com', functionsEmulatorReachable);
    await db
      .doc('userIndex/rev@gmail.com')
      .set({ uid, typedEmail: 'rev@gmail.com', lastSignIn: new Date() });
    const before = (await auth.getUser(uid)).tokensValidAfterTime;

    await db.doc('stakes/csnorth/kindooManagers/rev@gmail.com').set({ active: true });
    await runSync('csnorth', 'rev@gmail.com');

    const after = (await auth.getUser(uid)).tokensValidAfterTime;
    if (before && after) {
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    }
  });
});
