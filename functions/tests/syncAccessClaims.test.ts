// Integration tests for `syncAccessClaims`. Skipped if the emulators
// aren't advertised. Cases mirror the migration plan's enumeration:
// stake scope → stake claim, multi-ward → wards array, deletion →
// claim cleared, no userIndex → graceful no-op.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { syncAccessClaims } from '../src/triggers/syncAccessClaims.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

// Minimal event payload shape — the trigger only consults
// `event.params`; the doc body is reread from Firestore by
// `computeStakeClaims`. The cast through `unknown` is the cleanest way
// to feed `.run()` a structurally-sufficient event without
// constructing the full `Change<DocumentSnapshot>` (which requires
// reaching into firebase-admin internals).
const makeEvent = (stakeId: string, memberCanonical: string) =>
  ({
    params: { stakeId, memberCanonical },
    data: undefined,
  }) as unknown as Parameters<typeof syncAccessClaims.run>[0];

async function runSync(stakeId: string, memberCanonical: string): Promise<void> {
  await syncAccessClaims.run(makeEvent(stakeId, memberCanonical));
}

describe.skipIf(!hasEmulators())('syncAccessClaims', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  it('writes stake claim when access doc exists with stake-scope grant', async () => {
    const { auth, db } = requireEmulators();
    const user = await auth.createUser({ email: 'a@gmail.com' });
    await db
      .doc('userIndex/a@gmail.com')
      .set({ uid: user.uid, typedEmail: 'a@gmail.com', lastSignIn: new Date() });

    await db.doc('stakes/csnorth/access/a@gmail.com').set({
      importer_callings: { stake: ['Stake President'] },
      manual_grants: {},
    });
    await runSync('csnorth', 'a@gmail.com');

    const refreshed = await auth.getUser(user.uid);
    expect(refreshed.customClaims).toMatchObject({
      stakes: { csnorth: { stake: true, manager: false, wards: [] } },
    });
  });

  it('writes ward claims for multi-ward access (deduped, sorted)', async () => {
    const { auth, db } = requireEmulators();
    const user = await auth.createUser({ email: 'b@gmail.com' });
    await db
      .doc('userIndex/b@gmail.com')
      .set({ uid: user.uid, typedEmail: 'b@gmail.com', lastSignIn: new Date() });

    await db.doc('stakes/csnorth/access/b@gmail.com').set({
      importer_callings: { GE: ['Bishop'] },
      manual_grants: { CO: [{ grant_id: 'g1' }], GE: [{ grant_id: 'g2' }] },
    });
    await runSync('csnorth', 'b@gmail.com');

    const refreshed = await auth.getUser(user.uid);
    const claims = refreshed.customClaims as {
      stakes: { csnorth: { wards: string[] } };
    };
    expect(claims.stakes.csnorth.wards).toEqual(['CO', 'GE']);
  });

  it('clears the stake block when the access doc goes away', async () => {
    const { auth, db } = requireEmulators();
    const user = await auth.createUser({ email: 'c@gmail.com' });
    await db
      .doc('userIndex/c@gmail.com')
      .set({ uid: user.uid, typedEmail: 'c@gmail.com', lastSignIn: new Date() });
    // Stake-scope grant first; stake claim flips on.
    await db
      .doc('stakes/csnorth/access/c@gmail.com')
      .set({ importer_callings: { stake: ['Counselor'] } });
    await runSync('csnorth', 'c@gmail.com');
    expect(
      ((await auth.getUser(user.uid)).customClaims as { stakes?: Record<string, unknown> })?.stakes,
    ).toBeDefined();

    // Delete + re-fire trigger. Stake block goes away.
    await db.doc('stakes/csnorth/access/c@gmail.com').delete();
    await runSync('csnorth', 'c@gmail.com');
    const refreshed = await auth.getUser(user.uid);
    expect((refreshed.customClaims as { stakes?: unknown }).stakes).toBeUndefined();
  });

  it('preserves the manager bit when access changes (stake block recomputed in full)', async () => {
    // A user can be both a manager AND a stake-scope grant holder. A
    // write to access shouldn't clobber the manager flag (which lives
    // in a different collection). `computeStakeClaims` reads both so
    // the merged block is always self-consistent.
    const { auth, db } = requireEmulators();
    const user = await auth.createUser({ email: 'mix@gmail.com' });
    await db
      .doc('userIndex/mix@gmail.com')
      .set({ uid: user.uid, typedEmail: 'mix@gmail.com', lastSignIn: new Date() });
    await db.doc('stakes/csnorth/kindooManagers/mix@gmail.com').set({ active: true });
    // Now an access write fires. The trigger recomputes from both;
    // manager flag survives.
    await db
      .doc('stakes/csnorth/access/mix@gmail.com')
      .set({ importer_callings: { stake: ['HC'] } });
    await runSync('csnorth', 'mix@gmail.com');

    const refreshed = await auth.getUser(user.uid);
    expect(refreshed.customClaims).toMatchObject({
      stakes: { csnorth: { manager: true, stake: true, wards: [] } },
    });
  });

  it('no-ops gracefully when the user has not signed in (no userIndex)', async () => {
    // The access doc is written for a canonical that has no
    // userIndex entry yet (e.g., importer ran before the user signed
    // in for the first time). The trigger must NOT throw — when the
    // user signs in later, onAuthUserCreate seeds claims from the
    // existing role data.
    const { db } = requireEmulators();
    await db
      .doc('stakes/csnorth/access/ghost@gmail.com')
      .set({ importer_callings: { stake: ['Counselor'] } });
    await expect(runSync('csnorth', 'ghost@gmail.com')).resolves.toBeUndefined();
  });
});
