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
import type { StakeClaims } from '@kindoo/shared';
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

// D24 limited access. `limited` rides inside the per-stake block, so the
// merge must carry it through untouched and the change-detection compare
// must notice it appearing or disappearing — that's what revokes the
// token when a user's tier actually flips. Both are exercised through
// the public applier (`mergeStake` / `claimsEqual` are module-private).
describe.skipIf(!hasEmulators())('applyClaims — limited claim round-trip', () => {
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

  /**
   * Create a user and wait out `onAuthUserCreate`'s async baseline claim
   * write when the Functions emulator is live, so the trigger can't
   * clobber what the test writes next. Mirrors the wait in the suite
   * above.
   */
  async function makeSettledUser(email: string): Promise<string> {
    const { auth } = requireEmulators();
    const user = await auth.createUser({ email });
    if (functionsEmulatorReachable) {
      const seeded = await waitFor(async () => {
        const u = await auth.getUser(user.uid);
        return ((u.customClaims ?? {}) as { canonical?: string }).canonical === email;
      }, 20_000);
      expect(seeded).toBe(true);
    }
    return user.uid;
  }

  const stakeBlock = (over: Partial<StakeClaims> = {}): StakeClaims => ({
    manager: false,
    stake: false,
    wards: ['GE'],
    ...over,
  });

  /** The stored claim block for `stakeId`, as it round-tripped through Auth. */
  async function readBlock(uid: string, stakeId: string): Promise<Record<string, unknown>> {
    const { auth } = requireEmulators();
    const claims = ((await auth.getUser(uid)).customClaims ?? {}) as {
      stakes?: Record<string, Record<string, unknown>>;
    };
    return claims.stakes?.[stakeId] ?? {};
  }

  it(
    'carries limited: true through the merge without clobbering sibling stakes',
    { timeout: 30_000 },
    async () => {
      const email = 'multi@gmail.com';
      const uid = await makeSettledUser(email);

      // Full-access block in stake A, then a limited block in stake B.
      await applyStakeClaims(uid, email, 'alpha', stakeBlock({ stake: true, wards: [] }));
      await applyStakeClaims(uid, email, 'beta', stakeBlock({ limited: true }));

      expect(await readBlock(uid, 'beta')).toEqual({
        manager: false,
        stake: false,
        wards: ['GE'],
        limited: true,
      });
      // Sibling stake survives the merge and stays full-access.
      const alpha = await readBlock(uid, 'alpha');
      expect(alpha).toEqual({ manager: false, stake: true, wards: [] });
      expect('limited' in alpha).toBe(false);
    },
  );

  it(
    'revokes tokens when limited is added and again when it is removed',
    { timeout: 30_000 },
    async () => {
      const { auth } = requireEmulators();
      const email = 'flip@gmail.com';
      const uid = await makeSettledUser(email);

      await applyStakeClaims(uid, email, 'csnorth', stakeBlock());

      const revoke = vi.spyOn(auth, 'revokeRefreshTokens');

      // Same block again: no change, no revoke.
      await applyStakeClaims(uid, email, 'csnorth', stakeBlock());
      expect(revoke).not.toHaveBeenCalled();

      // Tier flips to limited: a real change.
      await applyStakeClaims(uid, email, 'csnorth', stakeBlock({ limited: true }));
      expect(revoke).toHaveBeenCalledTimes(1);
      expect((await readBlock(uid, 'csnorth'))['limited']).toBe(true);

      // Idempotent re-apply of the limited block: still no change.
      await applyStakeClaims(uid, email, 'csnorth', stakeBlock({ limited: true }));
      expect(revoke).toHaveBeenCalledTimes(1);

      // And back to full: dropping the key is a change too.
      await applyStakeClaims(uid, email, 'csnorth', stakeBlock());
      expect(revoke).toHaveBeenCalledTimes(2);
      const back = await readBlock(uid, 'csnorth');
      expect(back).toEqual({ manager: false, stake: false, wards: ['GE'] });
      expect('limited' in back).toBe(false);
    },
  );
});
