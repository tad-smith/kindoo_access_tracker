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
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

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

  it('mints bootstrap: true on create when setup_complete is false', async () => {
    const { auth } = requireEmulators();
    const user = await auth.createUser({ email: 'admin@example.com' });

    await syncBootstrapClaims.run(
      makeEvent({
        stakeId: 'new-stake',
        before: null,
        after: { bootstrap_admin_email: 'admin@example.com', setup_complete: false },
      }),
    );

    const refreshed = await auth.getUser(user.uid);
    expect(bootstrapFlag(refreshed.customClaims, 'new-stake')).toBe(true);
  });

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

  it('clears the marker when setup_complete flips to true', async () => {
    const { auth } = requireEmulators();
    const user = await auth.createUser({ email: 'admin2@example.com' });

    await syncBootstrapClaims.run(
      makeEvent({
        stakeId: 'flip-stake',
        before: null,
        after: { bootstrap_admin_email: 'admin2@example.com', setup_complete: false },
      }),
    );
    expect(bootstrapFlag((await auth.getUser(user.uid)).customClaims, 'flip-stake')).toBe(true);

    await syncBootstrapClaims.run(
      makeEvent({
        stakeId: 'flip-stake',
        before: { bootstrap_admin_email: 'admin2@example.com', setup_complete: false },
        after: { bootstrap_admin_email: 'admin2@example.com', setup_complete: true },
      }),
    );

    const refreshed = await auth.getUser(user.uid);
    expect(bootstrapFlag(refreshed.customClaims, 'flip-stake')).toBeUndefined();
    // No other role data exists for this user in this stake — the
    // whole block, and the empty `stakes` map, should be pruned.
    expect((refreshed.customClaims as { stakes?: unknown } | null)?.stakes).toBeUndefined();
  });

  it('re-points the marker when bootstrap_admin_email changes mid-setup', async () => {
    const { auth } = requireEmulators();
    const userA = await auth.createUser({ email: 'adminA@example.com' });
    const userB = await auth.createUser({ email: 'adminB@example.com' });

    await syncBootstrapClaims.run(
      makeEvent({
        stakeId: 'repoint-stake',
        before: null,
        after: { bootstrap_admin_email: 'adminA@example.com', setup_complete: false },
      }),
    );
    expect(bootstrapFlag((await auth.getUser(userA.uid)).customClaims, 'repoint-stake')).toBe(true);

    await syncBootstrapClaims.run(
      makeEvent({
        stakeId: 'repoint-stake',
        before: { bootstrap_admin_email: 'adminA@example.com', setup_complete: false },
        after: { bootstrap_admin_email: 'adminB@example.com', setup_complete: false },
      }),
    );

    const refreshedA = await auth.getUser(userA.uid);
    const refreshedB = await auth.getUser(userB.uid);
    expect(bootstrapFlag(refreshedA.customClaims, 'repoint-stake')).toBeUndefined();
    expect(bootstrapFlag(refreshedB.customClaims, 'repoint-stake')).toBe(true);
  });

  it('clears the marker when the stake doc is deleted', async () => {
    const { auth } = requireEmulators();
    const user = await auth.createUser({ email: 'admin3@example.com' });

    await syncBootstrapClaims.run(
      makeEvent({
        stakeId: 'deleted-stake',
        before: null,
        after: { bootstrap_admin_email: 'admin3@example.com', setup_complete: false },
      }),
    );
    expect(bootstrapFlag((await auth.getUser(user.uid)).customClaims, 'deleted-stake')).toBe(true);

    await syncBootstrapClaims.run(
      makeEvent({
        stakeId: 'deleted-stake',
        before: { bootstrap_admin_email: 'admin3@example.com', setup_complete: false },
        after: null,
      }),
    );

    const refreshed = await auth.getUser(user.uid);
    expect(bootstrapFlag(refreshed.customClaims, 'deleted-stake')).toBeUndefined();
  });

  it('does NOT mint when setup_complete is absent', async () => {
    const { auth } = requireEmulators();
    const user = await auth.createUser({ email: 'noflag@example.com' });

    await syncBootstrapClaims.run(
      makeEvent({
        stakeId: 'absent-flag-stake',
        before: null,
        after: { bootstrap_admin_email: 'noflag@example.com' },
      }),
    );

    const refreshed = await auth.getUser(user.uid);
    expect(refreshed.customClaims ?? null).toBeNull();
  });

  it('does NOT mint when setup_complete is a non-boolean value', async () => {
    const { auth } = requireEmulators();
    const user = await auth.createUser({ email: 'stringflag@example.com' });

    await syncBootstrapClaims.run(
      makeEvent({
        stakeId: 'non-boolean-stake',
        before: null,
        after: { bootstrap_admin_email: 'stringflag@example.com', setup_complete: 'false' },
      }),
    );

    const refreshed = await auth.getUser(user.uid);
    expect(refreshed.customClaims ?? null).toBeNull();
  });

  it('no-ops when the doc write does not change bootstrap eligibility', async () => {
    // Unrelated field (e.g. stake_seat_cap) changes while
    // bootstrap_admin_email/setup_complete stay the same — must not
    // re-mint (which would needlessly revoke the admin's tokens).
    const { auth } = requireEmulators();
    const user = await auth.createUser({ email: 'stable@example.com' });
    const before = { bootstrap_admin_email: 'stable@example.com', setup_complete: false };

    await syncBootstrapClaims.run(
      makeEvent({ stakeId: 'stable-stake', before: null, after: before }),
    );
    const afterFirstMint = await auth.getUser(user.uid);
    const tokensValidAfterFirstMint = afterFirstMint.tokensValidAfterTime;

    await syncBootstrapClaims.run(
      makeEvent({
        stakeId: 'stable-stake',
        before,
        after: { ...before, stake_seat_cap: 50 },
      }),
    );

    const refreshed = await auth.getUser(user.uid);
    expect(bootstrapFlag(refreshed.customClaims, 'stable-stake')).toBe(true);
    expect(refreshed.tokensValidAfterTime).toBe(tokensValidAfterFirstMint);
  });
});
