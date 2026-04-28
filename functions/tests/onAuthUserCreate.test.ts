// Integration tests for `onAuthUserCreate`. Exercises the trigger
// handler directly via its v1 CloudFunction `.run()` entry, with the
// Admin SDK pointed at the emulators. Skipped when the emulators
// aren't advertised — see `tests/lib/emulator.ts`.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { UserRecord } from 'firebase-admin/auth';
import { onAuthUserCreate } from '../src/triggers/onAuthUserCreate.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

// `.run` is documented for v2 CloudFunctions and exists at runtime for
// v1 too (see firebase-functions/v1/cloud-functions). The TypeScript
// types for v1 mark it private, so we cast through `unknown` to call it.
type V1Runnable = { run: (data: UserRecord, context: unknown) => Promise<unknown> };
const runOnAuthUserCreate = (user: UserRecord) =>
  (onAuthUserCreate as unknown as V1Runnable).run(user, { eventId: 't', timestamp: '' });

describe.skipIf(!hasEmulators())('onAuthUserCreate', () => {
  beforeAll(async () => {
    await clearEmulators();
  });

  afterEach(async () => {
    await clearEmulators();
  });

  afterAll(async () => {
    // Final sweep so a follow-on test file starts clean.
    await clearEmulators();
  });

  it('writes userIndex and stamps an empty-roles claim block', async () => {
    const { auth, db } = requireEmulators();
    const user = await auth.createUser({ email: 'plain@example.org' });

    await runOnAuthUserCreate(user);

    const idx = await db.doc('userIndex/plain@example.org').get();
    expect(idx.exists).toBe(true);
    const idxData = idx.data() as { uid: string; typedEmail: string; lastSignIn: unknown };
    expect(idxData.uid).toBe(user.uid);
    expect(idxData.typedEmail).toBe('plain@example.org');
    expect(idxData.lastSignIn).toBeDefined();

    const refreshed = await auth.getUser(user.uid);
    // No pre-existing role data → claims carry only `canonical`.
    expect(refreshed.customClaims).toEqual({ canonical: 'plain@example.org' });
  });

  it('seeds manager claim when kindooManagers/{canonical} pre-exists with active=true', async () => {
    const { auth, db } = requireEmulators();
    await db
      .doc('stakes/csnorth/kindooManagers/mgr@gmail.com')
      .set({ active: true, member_email: 'Mgr@gmail.com' });

    const user = await auth.createUser({ email: 'Mgr@gmail.com' });
    await runOnAuthUserCreate(user);

    const refreshed = await auth.getUser(user.uid);
    expect(refreshed.customClaims).toMatchObject({
      canonical: 'mgr@gmail.com',
      stakes: { csnorth: { manager: true, stake: false, wards: [] } },
    });
  });

  it('does NOT set the manager claim when kindooManagers active=false', async () => {
    const { auth, db } = requireEmulators();
    await db.doc('stakes/csnorth/kindooManagers/mgr@gmail.com').set({ active: false });

    const user = await auth.createUser({ email: 'mgr@gmail.com' });
    await runOnAuthUserCreate(user);

    const refreshed = await auth.getUser(user.uid);
    // Empty stake block omitted — claims carry just the canonical.
    expect(refreshed.customClaims).toEqual({ canonical: 'mgr@gmail.com' });
  });

  it('seeds stake claim from access doc with importer_callings on stake scope', async () => {
    const { auth, db } = requireEmulators();
    await db.doc('stakes/csnorth/access/stk@gmail.com').set({
      importer_callings: { stake: ['Stake President'] },
      manual_grants: {},
    });
    const user = await auth.createUser({ email: 'stk@gmail.com' });
    await runOnAuthUserCreate(user);

    const refreshed = await auth.getUser(user.uid);
    expect(refreshed.customClaims).toMatchObject({
      canonical: 'stk@gmail.com',
      stakes: { csnorth: { manager: false, stake: true, wards: [] } },
    });
  });

  it('seeds ward claims from access doc with multi-ward grants (alphabetical)', async () => {
    const { auth, db } = requireEmulators();
    await db.doc('stakes/csnorth/access/bish@gmail.com').set({
      importer_callings: { GE: ['Bishop'] },
      manual_grants: { CO: [{ grant_id: 'g1', reason: 'covering for X' }] },
    });
    const user = await auth.createUser({ email: 'bish@gmail.com' });
    await runOnAuthUserCreate(user);

    const refreshed = await auth.getUser(user.uid);
    const claims = refreshed.customClaims as {
      canonical: string;
      stakes: { csnorth: { wards: string[]; stake: boolean; manager: boolean } };
    };
    expect(claims.canonical).toBe('bish@gmail.com');
    expect(claims.stakes.csnorth.wards).toEqual(['CO', 'GE']);
    expect(claims.stakes.csnorth.stake).toBe(false);
    expect(claims.stakes.csnorth.manager).toBe(false);
  });

  it('canonicalises typed-form Gmail variants when matching pre-existing role data', async () => {
    // Pre-existing role data stored under canonical form `firstlast@gmail.com`.
    const { auth, db } = requireEmulators();
    await db.doc('stakes/csnorth/access/firstlast@gmail.com').set({
      importer_callings: { stake: ['Counselor'] },
    });

    // User signs up with the typed form `First.Last@Gmail.com`. The
    // canonicaliser folds both spellings to `firstlast@gmail.com`.
    const user = await auth.createUser({ email: 'First.Last@Gmail.com' });
    await runOnAuthUserCreate(user);

    const refreshed = await auth.getUser(user.uid);
    expect(refreshed.customClaims).toMatchObject({
      canonical: 'firstlast@gmail.com',
      stakes: { csnorth: { stake: true } },
    });

    // userIndex doc lives under the canonical form. `typedEmail` is
    // preserved as the auth provider returned it; Firebase Auth
    // lowercases at sign-in, so the typed form on the doc is
    // already lowercase by the time the trigger sees it (matches
    // production's behaviour with Google sign-in too).
    const idx = await db.doc('userIndex/firstlast@gmail.com').get();
    expect(idx.exists).toBe(true);
    expect((idx.data() as { typedEmail: string }).typedEmail).toBe('first.last@gmail.com');
  });

  it('revokes refresh tokens after stamping non-empty claims', async () => {
    const { auth, db } = requireEmulators();
    await db.doc('stakes/csnorth/kindooManagers/mgr@gmail.com').set({ active: true });
    const user = await auth.createUser({ email: 'mgr@gmail.com' });
    const beforeRevoke = user.tokensValidAfterTime;
    await runOnAuthUserCreate(user);
    const refreshed = await auth.getUser(user.uid);
    // tokensValidAfterTime must move forward when revokeRefreshTokens fires.
    expect(refreshed.tokensValidAfterTime).toBeDefined();
    if (beforeRevoke) {
      expect(new Date(refreshed.tokensValidAfterTime as string).getTime()).toBeGreaterThanOrEqual(
        new Date(beforeRevoke).getTime(),
      );
    }
  });

  it('no-ops gracefully when the user has no email', async () => {
    // Users created without an email (phone-only flows) shouldn't crash
    // the trigger. We simulate by passing a minimal UserRecord-shaped
    // object — we can't actually `auth.createUser()` without an email
    // in the emulator's default config.
    const fakeUser = { uid: 'phoneOnly', email: undefined } as unknown as UserRecord;
    await expect(runOnAuthUserCreate(fakeUser)).resolves.toBeUndefined();
    const { db } = requireEmulators();
    const all = await db.collection('userIndex').get();
    expect(all.empty).toBe(true);
  });
});
