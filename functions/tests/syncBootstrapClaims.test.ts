// Integration tests for `syncBootstrapClaims`. Fires on every write to
// `stakes/{stakeId}`; mints or clears the `bootstrap` marker (see
// `StakeClaims.bootstrap`) on the designated bootstrap admin's claim
// block for that stake, driven off the before/after
// `(bootstrap_admin_email, setup_complete)` pair.
//
// Coverage: mint on create; no-op when no Auth user exists for the
// email; clear when `setup_complete` flips to true; re-point when
// `bootstrap_admin_email` changes while still in setup; clear on
// stake-doc delete; `setup_complete` absent or non-boolean does NOT
// mint.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { syncBootstrapClaims } from '../src/triggers/syncBootstrapClaims.js';
import {
  clearEmulators,
  hasEmulators,
  hasFunctionsEmulator,
  makeSettledUser,
  requireEmulators,
} from './lib/emulator.js';

// CI boots this suite under `--only firestore,auth,functions`, so the
// `onAuthUserCreate` v1 auth trigger is live and fires (async, via
// Eventarc) on every `auth.createUser(...)` — its `applyFullClaims`
// write a few hundred ms later races any in-process claim write a test
// makes right after `createUser`, in both directions: it can clobber a
// bootstrap marker this suite just minted, or land the baseline
// `{ canonical }` block after a "does NOT mint" assertion expected no
// claims at all. `makeSettledUser` (mirrors `applyClaims.test.ts`)
// waits out that baseline first. Snapshot once at module load: the
// emulator is or isn't up for the suite's lifetime.
const functionsEmulatorReachable = await hasFunctionsEmulator();

/**
 * Build an event payload that satisfies the v2 onDocumentWritten
 * signature. The trigger only consults `event.params.stakeId` and
 * `event.data.before/after.exists/data()` — mirrors the `makeEvent`
 * pattern in `auditTrigger.test.ts` / the other sync-claims suites.
 */
function makeEvent(opts: {
  stakeId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}): Parameters<typeof syncBootstrapClaims.run>[0] {
  const beforeSnap = {
    exists: opts.before != null,
    data: () => opts.before ?? undefined,
  };
  const afterSnap = {
    exists: opts.after != null,
    data: () => opts.after ?? undefined,
  };
  return {
    params: { stakeId: opts.stakeId },
    data: { before: beforeSnap, after: afterSnap },
  } as unknown as Parameters<typeof syncBootstrapClaims.run>[0];
}

/** `bootstrapStakes` reader off the raw claims payload the Auth emulator returns. */
function bootstrapFlag(claims: unknown, stakeId: string): boolean | undefined {
  const c = claims as { stakes?: Record<string, { bootstrap?: boolean }> } | null | undefined;
  return c?.stakes?.[stakeId]?.bootstrap;
}

/** Normalises the Auth emulator's `customClaims` (`undefined` vs `null`) for comparison. */
function claimsOf(user: { customClaims?: unknown }): unknown {
  return user.customClaims ?? null;
}

describe.skipIf(!hasEmulators())('syncBootstrapClaims', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  it(
    'mints bootstrap: true on create when setup_complete is false',
    { timeout: 30_000 },
    async () => {
      const { auth } = requireEmulators();
      const uid = await makeSettledUser('admin@example.com', functionsEmulatorReachable);

      await syncBootstrapClaims.run(
        makeEvent({
          stakeId: 'new-stake',
          before: null,
          after: { bootstrap_admin_email: 'admin@example.com', setup_complete: false },
        }),
      );

      const refreshed = await auth.getUser(uid);
      expect(bootstrapFlag(refreshed.customClaims, 'new-stake')).toBe(true);
    },
  );

  it('no-ops silently when no Auth user exists for the bootstrap email', async () => {
    await expect(
      syncBootstrapClaims.run(
        makeEvent({
          stakeId: 'orphan-stake',
          before: null,
          after: { bootstrap_admin_email: 'nobody@example.com', setup_complete: false },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('clears the marker when setup_complete flips to true', { timeout: 30_000 }, async () => {
    const { auth } = requireEmulators();
    const uid = await makeSettledUser('admin2@example.com', functionsEmulatorReachable);

    await syncBootstrapClaims.run(
      makeEvent({
        stakeId: 'flip-stake',
        before: null,
        after: { bootstrap_admin_email: 'admin2@example.com', setup_complete: false },
      }),
    );
    expect(bootstrapFlag((await auth.getUser(uid)).customClaims, 'flip-stake')).toBe(true);

    await syncBootstrapClaims.run(
      makeEvent({
        stakeId: 'flip-stake',
        before: { bootstrap_admin_email: 'admin2@example.com', setup_complete: false },
        after: { bootstrap_admin_email: 'admin2@example.com', setup_complete: true },
      }),
    );

    const refreshed = await auth.getUser(uid);
    expect(bootstrapFlag(refreshed.customClaims, 'flip-stake')).toBeUndefined();
    // No other role data exists for this user in this stake — the
    // whole block, and the empty `stakes` map, should be pruned.
    expect((refreshed.customClaims as { stakes?: unknown } | null)?.stakes).toBeUndefined();
  });

  it(
    're-points the marker when bootstrap_admin_email changes mid-setup',
    { timeout: 30_000 },
    async () => {
      const { auth } = requireEmulators();
      const uidA = await makeSettledUser('adminA@example.com', functionsEmulatorReachable);
      const uidB = await makeSettledUser('adminB@example.com', functionsEmulatorReachable);

      await syncBootstrapClaims.run(
        makeEvent({
          stakeId: 'repoint-stake',
          before: null,
          after: { bootstrap_admin_email: 'adminA@example.com', setup_complete: false },
        }),
      );
      expect(bootstrapFlag((await auth.getUser(uidA)).customClaims, 'repoint-stake')).toBe(true);

      await syncBootstrapClaims.run(
        makeEvent({
          stakeId: 'repoint-stake',
          before: { bootstrap_admin_email: 'adminA@example.com', setup_complete: false },
          after: { bootstrap_admin_email: 'adminB@example.com', setup_complete: false },
        }),
      );

      const refreshedA = await auth.getUser(uidA);
      const refreshedB = await auth.getUser(uidB);
      expect(bootstrapFlag(refreshedA.customClaims, 'repoint-stake')).toBeUndefined();
      expect(bootstrapFlag(refreshedB.customClaims, 'repoint-stake')).toBe(true);
    },
  );

  it('clears the marker when the stake doc is deleted', { timeout: 30_000 }, async () => {
    const { auth } = requireEmulators();
    const uid = await makeSettledUser('admin3@example.com', functionsEmulatorReachable);

    await syncBootstrapClaims.run(
      makeEvent({
        stakeId: 'deleted-stake',
        before: null,
        after: { bootstrap_admin_email: 'admin3@example.com', setup_complete: false },
      }),
    );
    expect(bootstrapFlag((await auth.getUser(uid)).customClaims, 'deleted-stake')).toBe(true);

    await syncBootstrapClaims.run(
      makeEvent({
        stakeId: 'deleted-stake',
        before: { bootstrap_admin_email: 'admin3@example.com', setup_complete: false },
        after: null,
      }),
    );

    const refreshed = await auth.getUser(uid);
    expect(bootstrapFlag(refreshed.customClaims, 'deleted-stake')).toBeUndefined();
  });

  it('does NOT mint when setup_complete is absent', { timeout: 30_000 }, async () => {
    const { auth } = requireEmulators();
    const email = 'noflag@example.com';
    const uid = await makeSettledUser(email, functionsEmulatorReachable);
    // The settled baseline: `{ canonical }` when `onAuthUserCreate` fired
    // (the CI integration config), otherwise no claims at all (the
    // trigger never ran under `test:integration:local`). Asserting
    // against this rather than absolute absence is what makes the
    // check robust to which config is running, while still proving the
    // trigger under test added nothing beyond that baseline — i.e. did
    // not mint.
    const settledBaseline = functionsEmulatorReachable ? { canonical: email } : null;
    expect(claimsOf(await auth.getUser(uid))).toEqual(settledBaseline);

    await syncBootstrapClaims.run(
      makeEvent({
        stakeId: 'absent-flag-stake',
        before: null,
        after: { bootstrap_admin_email: email },
      }),
    );

    expect(claimsOf(await auth.getUser(uid))).toEqual(settledBaseline);
  });

  it('does NOT mint when setup_complete is a non-boolean value', { timeout: 30_000 }, async () => {
    const { auth } = requireEmulators();
    const email = 'stringflag@example.com';
    const uid = await makeSettledUser(email, functionsEmulatorReachable);
    const settledBaseline = functionsEmulatorReachable ? { canonical: email } : null;
    expect(claimsOf(await auth.getUser(uid))).toEqual(settledBaseline);

    await syncBootstrapClaims.run(
      makeEvent({
        stakeId: 'non-boolean-stake',
        before: null,
        after: { bootstrap_admin_email: email, setup_complete: 'false' },
      }),
    );

    expect(claimsOf(await auth.getUser(uid))).toEqual(settledBaseline);
  });

  it(
    'no-ops when the doc write does not change bootstrap eligibility',
    { timeout: 30_000 },
    async () => {
      // Unrelated field (e.g. stake_seat_cap) changes while
      // bootstrap_admin_email/setup_complete stay the same — must not
      // re-mint (which would needlessly revoke the admin's tokens).
      const { auth } = requireEmulators();
      const uid = await makeSettledUser('stable@example.com', functionsEmulatorReachable);
      const before = { bootstrap_admin_email: 'stable@example.com', setup_complete: false };

      await syncBootstrapClaims.run(
        makeEvent({ stakeId: 'stable-stake', before: null, after: before }),
      );
      const afterFirstMint = await auth.getUser(uid);
      const tokensValidAfterFirstMint = afterFirstMint.tokensValidAfterTime;

      await syncBootstrapClaims.run(
        makeEvent({
          stakeId: 'stable-stake',
          before,
          after: { ...before, stake_seat_cap: 50 },
        }),
      );

      const refreshed = await auth.getUser(uid);
      expect(bootstrapFlag(refreshed.customClaims, 'stable-stake')).toBe(true);
      expect(refreshed.tokensValidAfterTime).toBe(tokensValidAfterFirstMint);
    },
  );
});
