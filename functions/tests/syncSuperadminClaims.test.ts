// Integration tests for `syncSuperadminClaims`. v1 has no
// superadmins, so coverage is skeleton-level: doc-create flips the
// claim on; doc-delete flips it off.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { syncSuperadminClaims } from '../src/triggers/syncSuperadminClaims.js';
import {
  hasFunctionsEmulator,
  makeSettledUser,
  clearEmulators,
  hasEmulators,
  requireEmulators,
} from './lib/emulator.js';
// CI boots this suite under `--only firestore,auth,functions`, so the
// `onAuthUserCreate` v1 auth trigger is live and fires (async, via
// Eventarc) on every `auth.createUser(...)` — its `applyFullClaims`
// write a few hundred ms later races the in-process claim write each
// test makes right after. Snapshot once at module load: the emulator
// is or isn't up for the suite's lifetime.
const functionsEmulatorReachable = await hasFunctionsEmulator();

// The trigger reads `event.data?.after?.exists` to decide whether the
// flag should be on; supply a minimal stub. params.memberCanonical is
// also consulted.
const makeEvent = (memberCanonical: string, exists: boolean) =>
  ({
    params: { memberCanonical },
    data: { after: { exists } },
  }) as unknown as Parameters<typeof syncSuperadminClaims.run>[0];

describe.skipIf(!hasEmulators())('syncSuperadminClaims', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  it('sets isPlatformSuperadmin=true on doc create', { timeout: 30_000 }, async () => {
    const { auth, db } = requireEmulators();
    const uid = await makeSettledUser('super-add@gmail.com', functionsEmulatorReachable);
    await db
      .doc('userIndex/super-add@gmail.com')
      .set({ uid, typedEmail: 'super-add@gmail.com', lastSignIn: new Date() });

    await syncSuperadminClaims.run(makeEvent('super-add@gmail.com', true));
    const refreshed = await auth.getUser(uid);
    expect(
      (refreshed.customClaims as { isPlatformSuperadmin?: boolean }).isPlatformSuperadmin,
    ).toBe(true);
  });

  it('clears isPlatformSuperadmin on doc delete', { timeout: 30_000 }, async () => {
    const { auth, db } = requireEmulators();
    const uid = await makeSettledUser('super-del@gmail.com', functionsEmulatorReachable);
    await db
      .doc('userIndex/super-del@gmail.com')
      .set({ uid, typedEmail: 'super-del@gmail.com', lastSignIn: new Date() });

    // First add (after.exists=true), then remove (after.exists=false).
    await syncSuperadminClaims.run(makeEvent('super-del@gmail.com', true));
    await syncSuperadminClaims.run(makeEvent('super-del@gmail.com', false));

    const refreshed = await auth.getUser(uid);
    const claims = (refreshed.customClaims ?? {}) as { isPlatformSuperadmin?: boolean };
    expect(claims.isPlatformSuperadmin).toBeUndefined();
  });

  it('no-ops when the canonical has no userIndex entry', async () => {
    await expect(
      syncSuperadminClaims.run(makeEvent('unknown@gmail.com', true)),
    ).resolves.toBeUndefined();
  });
});
