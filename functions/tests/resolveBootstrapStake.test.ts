// Integration tests for the `resolveBootstrapStake` callable. Fixes
// the bootstrap admin of a newly-created stake landing on
// "Not Authorized": before the wizard runs, no claim exists that
// identifies them as the bootstrap admin of anything, so the client
// has no other way to discover the stakeId(s).
//
// Coverage:
//   - Unauthenticated caller → HttpsError('unauthenticated').
//   - Signed-in caller with no email on the token → { stakeIds: [] }
//     (not an error).
//   - Happy path: exact `bootstrap_admin_email` match on a
//     not-yet-set-up stake → that stake's id.
//   - `setup_complete: true` → excluded even on an exact email match.
//   - No match at all → { stakeIds: [] }.
//   - Gmail dot / `+suffix` alias stored verbatim by `createStake` →
//     matches the token email verbatim. Guards against a regression
//     that canonicalises the lookup (which would silently break the
//     match, since the stored value is deliberately NOT canonicalised
//     — see `firestore.rules` `isBootstrapAdmin` / `createStake.ts`).
//   - Multiple matching stakes (e.g. a superadmin bootstrapping two
//     stakes with the same admin email) → all returned, sorted
//     ascending by doc id.
//   - `setup_complete` absent entirely, or set to a non-boolean value
//     → excluded. Only an exact boolean `false` matches
//     `firestore.rules` `isBootstrapAdmin`'s `== false`; `createStake`
//     always writes a real boolean, but an out-of-band console seed
//     (permitted by `infra/runbooks/provision-firebase-projects.md`)
//     might not.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { Stake } from '@kindoo/shared';
import { resolveBootstrapStake } from '../src/callable/resolveBootstrapStake.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const ACTOR = { email: 'super@example.com', canonical: 'super@example.com' };

/** Bookkeeping/capacity fields every seeded stake doc needs, minus `setup_complete`. */
function baseStakeBody(bootstrapAdminEmail: string): Record<string, unknown> {
  return {
    stake_name: 'Test Stake',
    created_at: Timestamp.now(),
    created_by: ACTOR.canonical,
    bootstrap_admin_email: bootstrapAdminEmail,
    stake_seat_cap: 0,
    timezone: 'America/Denver',
    notifications_enabled: true,
    last_over_caps_json: [],
    last_modified_at: Timestamp.now(),
    last_modified_by: ACTOR,
    lastActor: ACTOR,
  };
}

async function seedStake(stakeId: string, overrides: Partial<Stake> = {}): Promise<void> {
  const { db } = requireEmulators();
  const stake: Stake = {
    ...(baseStakeBody('admin@example.com') as Omit<Stake, 'setup_complete'>),
    setup_complete: false,
    ...overrides,
  };
  await db.doc(`stakes/${stakeId}`).set(stake);
}

/**
 * Seed a stake doc with a malformed `setup_complete` — absent
 * (`setupComplete === undefined`) or a non-boolean value — bypassing
 * the `Stake` type entirely. Models a doc seeded out-of-band via the
 * Firestore console rather than through `createStake` (which always
 * writes a real boolean); `infra/runbooks/provision-firebase-projects.md`
 * explicitly permits that seed path, so this is reachable in practice.
 */
async function seedMalformedStake(
  stakeId: string,
  bootstrapAdminEmail: string,
  setupComplete: unknown,
): Promise<void> {
  const { db } = requireEmulators();
  const body = baseStakeBody(bootstrapAdminEmail);
  if (setupComplete !== undefined) {
    body['setup_complete'] = setupComplete;
  }
  await db.doc(`stakes/${stakeId}`).set(body);
}

/** Build the `req` argument `onCall(...).run(...)` accepts. `email:
 * undefined` omits the token's `email` claim entirely (rather than
 * setting it to an empty string), matching how a real auth provider
 * that doesn't emit an email claim would look on `req.auth.token`. */
function callableReq(opts: { auth?: { email?: string } | null } = {}): never {
  const auth = opts.auth
    ? {
        uid: opts.auth.email ?? 'no-email-uid',
        token: opts.auth.email !== undefined ? { email: opts.auth.email } : {},
      }
    : undefined;
  return {
    data: {},
    auth,
    rawRequest: {} as unknown,
    acceptsStreaming: false,
  } as unknown as never;
}

describe.skipIf(!hasEmulators())('resolveBootstrapStake callable', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  it('rejects an unauthenticated caller with unauthenticated', async () => {
    await expect(resolveBootstrapStake.run(callableReq({ auth: null }))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('returns { stakeIds: [] } for a signed-in caller with no email on the token', async () => {
    const result = await resolveBootstrapStake.run(callableReq({ auth: {} }));
    expect(result).toEqual({ stakeIds: [] });
  });

  it('returns the stakeId on an exact bootstrap_admin_email match', async () => {
    await seedStake('happy-stake', {
      bootstrap_admin_email: 'admin@example.com',
      setup_complete: false,
    });

    const result = await resolveBootstrapStake.run(
      callableReq({ auth: { email: 'admin@example.com' } }),
    );

    expect(result).toEqual({ stakeIds: ['happy-stake'] });
  });

  it('excludes a stake that has finished setup', async () => {
    await seedStake('done-stake', {
      bootstrap_admin_email: 'doneadmin@example.com',
      setup_complete: true,
    });

    const result = await resolveBootstrapStake.run(
      callableReq({ auth: { email: 'doneadmin@example.com' } }),
    );

    expect(result).toEqual({ stakeIds: [] });
  });

  it('returns { stakeIds: [] } when no stake matches the caller email', async () => {
    await seedStake('other-stake', {
      bootstrap_admin_email: 'someone-else@example.com',
      setup_complete: false,
    });

    const result = await resolveBootstrapStake.run(
      callableReq({ auth: { email: 'nobody@example.com' } }),
    );

    expect(result).toEqual({ stakeIds: [] });
  });

  it('matches a Gmail dot/+suffix alias verbatim (no canonicalisation)', async () => {
    // `createStake` stores `.trim().toLowerCase()` only — dots and
    // `+suffix` survive. Firebase Auth emits the same literal string
    // on `token.email`. If this callable canonicalised the lookup
    // email, it would search for `janedoe@gmail.com` and miss.
    const alias = 'jane.doe+admin@gmail.com';
    await seedStake('gmail-stake', {
      bootstrap_admin_email: alias,
      setup_complete: false,
    });

    const result = await resolveBootstrapStake.run(callableReq({ auth: { email: alias } }));

    expect(result).toEqual({ stakeIds: ['gmail-stake'] });
  });

  it('returns all matching stakes, sorted ascending by doc id', async () => {
    // Models a caller (e.g. a platform superadmin) who is the
    // bootstrap admin of more than one in-progress stake at once —
    // the web switcher lists all of them rather than picking one.
    const email = 'shared-admin@example.com';
    await seedStake('zzz-stake', { bootstrap_admin_email: email, setup_complete: false });
    await seedStake('aaa-stake', { bootstrap_admin_email: email, setup_complete: false });
    await seedStake('mmm-stake', { bootstrap_admin_email: email, setup_complete: false });
    // A finished stake with the same email must not appear.
    await seedStake('done-shared-stake', {
      bootstrap_admin_email: email,
      setup_complete: true,
    });

    const result = await resolveBootstrapStake.run(callableReq({ auth: { email } }));

    expect(result).toEqual({ stakeIds: ['aaa-stake', 'mmm-stake', 'zzz-stake'] });
  });

  it('excludes a stake whose setup_complete field is absent entirely', async () => {
    await seedMalformedStake('absent-field-stake', 'noflag@example.com', undefined);

    const result = await resolveBootstrapStake.run(
      callableReq({ auth: { email: 'noflag@example.com' } }),
    );

    expect(result).toEqual({ stakeIds: [] });
  });

  it('excludes a stake whose setup_complete is a non-boolean value', async () => {
    await seedMalformedStake('non-boolean-stake', 'stringflag@example.com', 'false');

    const result = await resolveBootstrapStake.run(
      callableReq({ auth: { email: 'stringflag@example.com' } }),
    );

    expect(result).toEqual({ stakeIds: [] });
  });
});
