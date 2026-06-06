// Integration tests for the claim appliers in `src/lib/applyClaims.ts`,
// focused on the deleted-auth-user race.
//
// A role-doc write can outlive its auth user: the user is deleted
// between the write and the trigger firing (a prod race, and constant
// in this very suite where sibling tests create-then-delete users).
// `auth.getUser(uid)` then throws `auth/user-not-found`. Before the
// fix, that unhandled throw propagated out of the trigger and Eventarc
// retried it forever — an infinite retry storm that saturated the
// emulator and starved sibling triggers (the `syncSuperadminClaims`
// e2e flake). The appliers must now treat a missing user as a benign
// no-op: return without throwing and without writing any claims.
//
// We drive the appliers directly (not via `.run(event)`) because the
// behaviour under test is entirely inside the applier — the trigger is
// a thin wrapper that forwards a uid.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { logger } from 'firebase-functions';
import { applyFullClaims, applyStakeClaims, applySuperadminClaim } from '../src/lib/applyClaims.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

// A uid that has never existed in the Auth emulator. `getUser` on it
// throws `auth/user-not-found` — the exact condition the fix handles.
const MISSING_UID = 'uid-that-was-deleted-before-the-trigger-fired';

describe.skipIf(!hasEmulators())('applyClaims — deleted auth user is a benign no-op', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  it('applySuperadminClaim does not throw and writes no claims when the user is gone', async () => {
    const { auth } = requireEmulators();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const setClaims = vi.spyOn(auth, 'setCustomUserClaims');
    const revoke = vi.spyOn(auth, 'revokeRefreshTokens');

    await expect(
      applySuperadminClaim(MISSING_UID, 'gone@gmail.com', true),
    ).resolves.toBeUndefined();

    // No claim write attempted on the missing user.
    expect(setClaims).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();

    // The skip is observable, not silently swallowed.
    expect(info).toHaveBeenCalledWith('skipping claim sync: auth user no longer exists', {
      uid: MISSING_UID,
    });
  });

  it('applyStakeClaims does not throw and writes no claims when the user is gone', async () => {
    const { auth } = requireEmulators();
    const setClaims = vi.spyOn(auth, 'setCustomUserClaims');
    const revoke = vi.spyOn(auth, 'revokeRefreshTokens');

    await expect(
      applyStakeClaims(MISSING_UID, 'gone@gmail.com', 'csnorth', {
        manager: false,
        stake: true,
        wards: [],
      }),
    ).resolves.toBeUndefined();

    expect(setClaims).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('applyFullClaims does not throw and writes no claims when the user is gone', async () => {
    const { auth } = requireEmulators();
    const setClaims = vi.spyOn(auth, 'setCustomUserClaims');
    const revoke = vi.spyOn(auth, 'revokeRefreshTokens');

    await expect(
      applyFullClaims(MISSING_UID, { canonical: 'gone@gmail.com', isPlatformSuperadmin: true }),
    ).resolves.toBeUndefined();

    expect(setClaims).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('still applies claims normally when the user exists (no false-positive skip)', async () => {
    const { auth } = requireEmulators();
    const user = await auth.createUser({ email: 'present@gmail.com' });

    await applySuperadminClaim(user.uid, 'present@gmail.com', true);

    const refreshed = await auth.getUser(user.uid);
    const claims = (refreshed.customClaims ?? {}) as { isPlatformSuperadmin?: boolean };
    expect(claims.isPlatformSuperadmin).toBe(true);
  });
});
