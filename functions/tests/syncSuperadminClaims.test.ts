// Integration tests for `syncSuperadminClaims`. v1 has no
// superadmins, so coverage is skeleton-level: doc-create flips the
// claim on; doc-delete flips it off.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { syncSuperadminClaims } from '../src/triggers/syncSuperadminClaims.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

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

  it('sets isPlatformSuperadmin=true on doc create', async () => {
    const { auth, db } = requireEmulators();
    const user = await auth.createUser({ email: 'super@gmail.com' });
    await db
      .doc('userIndex/super@gmail.com')
      .set({ uid: user.uid, typedEmail: 'super@gmail.com', lastSignIn: new Date() });

    await syncSuperadminClaims.run(makeEvent('super@gmail.com', true));
    const refreshed = await auth.getUser(user.uid);
    expect(
      (refreshed.customClaims as { isPlatformSuperadmin?: boolean }).isPlatformSuperadmin,
    ).toBe(true);
  });

  it('clears isPlatformSuperadmin on doc delete', async () => {
    const { auth, db } = requireEmulators();
    const user = await auth.createUser({ email: 'super@gmail.com' });
    await db
      .doc('userIndex/super@gmail.com')
      .set({ uid: user.uid, typedEmail: 'super@gmail.com', lastSignIn: new Date() });

    // First add (after.exists=true), then remove (after.exists=false).
    await syncSuperadminClaims.run(makeEvent('super@gmail.com', true));
    await syncSuperadminClaims.run(makeEvent('super@gmail.com', false));

    const refreshed = await auth.getUser(user.uid);
    const claims = (refreshed.customClaims ?? {}) as { isPlatformSuperadmin?: boolean };
    expect(claims.isPlatformSuperadmin).toBeUndefined();
  });

  it('no-ops when the canonical has no userIndex entry', async () => {
    await expect(
      syncSuperadminClaims.run(makeEvent('unknown@gmail.com', true)),
    ).resolves.toBeUndefined();
  });
});
