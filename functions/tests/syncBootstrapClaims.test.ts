// Integration tests for `syncBootstrapClaims`. Fires on every write to
// `stakes/{stakeId}`; mints or clears the `bootstrap` marker (see
// `StakeClaims.bootstrap`) on the designated bootstrap admin's claim
// block for that stake, reconciled off the AFTER
// `(bootstrap_admin_email, setup_complete)` state on every write (not
// just eligibility transitions) so a divergence between the claim and
// the doc heals on the next write, whatever it is.
//
// Coverage: mint on create; no-op when no Auth user exists for the
// email; clear when `setup_complete` flips to true; re-point when
// `bootstrap_admin_email` changes while still in setup; clear on
// stake-doc delete; `setup_complete` absent or non-boolean does NOT
// mint; an irrelevant write performs no claim write / no token
// revocation, both mid-setup and in the (far more common) steady state
// of an already-complete stake; a stuck divergence in either direction
// (claim true but doc complete, claim missing but doc mid-setup) heals
// on the next unrelated write.

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
    { timeout: 50_000 },
    async () => {
      const { auth } = requireEmulators();
      const uid = await makeSettledUser('bootstrapadmin1@example.com', functionsEmulatorReachable);

      await syncBootstrapClaims.run(
        makeEvent({
          stakeId: 'new-stake',
          before: null,
          after: { bootstrap_admin_email: 'bootstrapadmin1@example.com', setup_complete: false },
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

  it('clears the marker when setup_complete flips to true', { timeout: 50_000 }, async () => {
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
    { timeout: 90_000 },
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

  it('clears the marker when the stake doc is deleted', { timeout: 50_000 }, async () => {
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

  it('does NOT mint when setup_complete is absent', { timeout: 50_000 }, async () => {
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

    // NOT the same `settledBaseline` as above: `syncBootstrapClaims`
    // converges on every write that has a candidate email, eligible or
    // not — `applyBootstrapClaim`/`mergeBootstrap` always establishes
    // the `{ canonical }` shape the first time it touches a uid (an
    // all-false stake block is pruned to nothing by
    // `isNonEmptyStakeClaims`, leaving just `canonical`). So the run
    // above converges the claim to `{ canonical }` regardless of
    // whether `onAuthUserCreate` already put it there (CI) or this call
    // is the first claim write this uid has ever gotten (local) — what
    // the "does NOT mint" contract actually rules out is a `stakes`
    // block appearing at all, let alone `bootstrap: true`.
    expect(claimsOf(await auth.getUser(uid))).toEqual({ canonical: email });
  });

  it('does NOT mint when setup_complete is a non-boolean value', { timeout: 50_000 }, async () => {
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

    // Same divergence from `settledBaseline` as the sibling "absent"
    // test above, and for the same reason: the run itself establishes
    // `{ canonical }` on a first touch, so that's the post-run shape
    // under both configs, not just under CI.
    expect(claimsOf(await auth.getUser(uid))).toEqual({ canonical: email });
  });

  it(
    'no-ops when the doc write does not change bootstrap eligibility',
    { timeout: 50_000 },
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

  it(
    'no-ops on ordinary writes to an already-complete stake (steady state)',
    { timeout: 50_000 },
    async () => {
      // The common case for the lifetime of a stake: setup finished
      // long ago, `bootstrap_admin_email` is still on the doc (it's
      // never cleared), and ordinary operation keeps writing the doc
      // (config changes, `last_over_caps_json`, seat-count churn). None
      // of that may write claims or revoke tokens — assert on the
      // absence of the write via `tokensValidAfterTime`, not just the
      // resulting claim shape, since the whole point is avoiding churn.
      const { auth } = requireEmulators();
      const email = 'complete@example.com';
      const uid = await makeSettledUser(email, functionsEmulatorReachable);
      const doc = { bootstrap_admin_email: email, setup_complete: true };

      // Prime the canonical baseline with an identity write (before ===
      // after) before capturing `tokensValidAfterTime`. Under CI,
      // `onAuthUserCreate` already established `{ canonical }` by the
      // time `makeSettledUser` returns, so this is a genuine no-op.
      // Under `test:integration:local` that trigger never fires, so
      // without priming, the very first claim write this uid ever gets
      // would be the one under test below — always triggering a revoke
      // (see `applyBootstrapClaim`/`mergeBootstrap`: a first touch
      // always writes at least `{ canonical }`) regardless of whether
      // it's steady-state churn, which is exactly what this test means
      // to rule out.
      await syncBootstrapClaims.run(
        makeEvent({ stakeId: 'complete-stake', before: doc, after: doc }),
      );
      const tokensValidBefore = (await auth.getUser(uid)).tokensValidAfterTime;

      await syncBootstrapClaims.run(
        makeEvent({
          stakeId: 'complete-stake',
          before: doc,
          after: { ...doc, last_over_caps_json: '[]' },
        }),
      );

      const refreshed = await auth.getUser(uid);
      expect(bootstrapFlag(refreshed.customClaims, 'complete-stake')).toBeUndefined();
      expect(refreshed.tokensValidAfterTime).toBe(tokensValidBefore);
    },
  );

  it(
    'heals a claim stuck at bootstrap: true after setup already completed',
    { timeout: 50_000 },
    async () => {
      // Models the durability gap directly: the doc is already past
      // setup, but the claim never got cleared — a lost update racing
      // a concurrent same-uid claim write, a failed claim write, or a
      // half-completed backfill. Force the divergence directly
      // (bypassing the trigger) rather than trying to construct a real
      // race. The very next write to the doc, unrelated to bootstrap,
      // must heal it.
      const { auth } = requireEmulators();
      const email = 'stale@example.com';
      const uid = await makeSettledUser(email, functionsEmulatorReachable);

      await auth.setCustomUserClaims(uid, {
        canonical: email,
        stakes: { 'stale-stake': { manager: false, stake: false, wards: [], bootstrap: true } },
      });
      expect(bootstrapFlag((await auth.getUser(uid)).customClaims, 'stale-stake')).toBe(true);

      const doc = { bootstrap_admin_email: email, setup_complete: true };
      await syncBootstrapClaims.run(
        makeEvent({
          stakeId: 'stale-stake',
          before: doc,
          after: { ...doc, stake_seat_cap: 60 },
        }),
      );

      const refreshed = await auth.getUser(uid);
      expect(bootstrapFlag(refreshed.customClaims, 'stale-stake')).toBeUndefined();
    },
  );

  it(
    'heals a claim stuck missing bootstrap: true while still mid-setup',
    { timeout: 50_000 },
    async () => {
      // The inverse divergence: the doc is still eligible but the
      // claim never got minted. An unrelated write must heal it too.
      const { auth } = requireEmulators();
      const email = 'missing@example.com';
      const uid = await makeSettledUser(email, functionsEmulatorReachable);
      expect(
        bootstrapFlag((await auth.getUser(uid)).customClaims, 'missing-stake'),
      ).toBeUndefined();

      const doc = { bootstrap_admin_email: email, setup_complete: false };
      await syncBootstrapClaims.run(
        makeEvent({
          stakeId: 'missing-stake',
          before: doc,
          after: { ...doc, stake_seat_cap: 12 },
        }),
      );

      const refreshed = await auth.getUser(uid);
      expect(bootstrapFlag(refreshed.customClaims, 'missing-stake')).toBe(true);
    },
  );
});
