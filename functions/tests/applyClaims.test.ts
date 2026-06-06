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
import {
  clearEmulators,
  hasEmulators,
  hasFunctionsEmulator,
  requireEmulators,
  waitFor,
} from './lib/emulator.js';

// A uid that has never existed in the Auth emulator. `getUser` on it
// throws `auth/user-not-found` — the exact condition the fix handles.
const MISSING_UID = 'uid-that-was-deleted-before-the-trigger-fired';

// CI boots this suite under `--only firestore,auth,functions`, so the
// `onAuthUserCreate` v1 auth trigger is live and fires (async, via
// Eventarc) on every `auth.createUser(...)` — its `applyFullClaims`
// write a few hundred ms later races any in-process claim write the
// test makes right after `createUser`. Snapshot once at module load:
// the emulator is or isn't up for the suite's lifetime.
const functionsEmulatorReachable = await hasFunctionsEmulator();

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

  it(
    'still applies claims normally when the user exists (no false-positive skip)',
    { timeout: 30_000 },
    async () => {
      const { auth } = requireEmulators();
      const user = await auth.createUser({ email: 'present@gmail.com' });

      // `auth.createUser` fires the real `onAuthUserCreate` trigger when
      // the Functions emulator is up (the CI integration config). That
      // trigger's one async write — `applyFullClaims` stamping the
      // baseline `{ canonical }` block — would otherwise land a few
      // hundred ms after our `applySuperadminClaim` and clobber the flag
      // we just set, making this assertion flake `undefined`. The trigger
      // writes exactly once per user, so wait for that baseline to settle
      // BEFORE applying the superadmin claim; once it has landed it can't
      // overwrite a later write. Skipped when the Functions emulator
      // isn't running (the trigger never fires; `customClaims` stays
      // null), so this stays correct under `test:integration:local` too.
      if (functionsEmulatorReachable) {
        const seeded = await waitFor(async () => {
          const u = await auth.getUser(user.uid);
          const claims = (u.customClaims ?? {}) as { canonical?: string };
          return claims.canonical === 'present@gmail.com';
        }, 20_000);
        expect(seeded).toBe(true);
      }

      await applySuperadminClaim(user.uid, 'present@gmail.com', true);

      const refreshed = await auth.getUser(user.uid);
      const claims = (refreshed.customClaims ?? {}) as { isPlatformSuperadmin?: boolean };
      expect(claims.isPlatformSuperadmin).toBe(true);
    },
  );
});
