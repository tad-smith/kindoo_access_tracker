// Integration tests for the `createStake` callable. Backs the Stake
// List page's Create Stake form (spec §5.4 / F19). Coverage: auth gate
// on the `isPlatformSuperadmin` claim, slug derivation + collision
// detection, soft-failure envelope on empty inputs / invalid slugs,
// typed (NOT canonicalized) bootstrap email storage, ActorRef shape on
// the bookkeeping fields, and `platformAuditLog` row emission.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { PlatformAuditLog, Stake } from '@kindoo/shared';
import { createStake } from '../src/callable/createStake.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const SUPERADMIN_EMAIL = 'super@gmail.com';

/**
 * Build the `req` argument `onCall(...).run(...)` accepts. Mirrors the
 * helper in `syncApplyFix.test.ts`. The third positional ctor arg
 * (`isPlatformSuperadmin`) injects the custom claim under test.
 */
function callableReq(opts: {
  auth?: { email: string; isPlatformSuperadmin?: boolean } | null;
  data: unknown;
}): never {
  const auth = opts.auth
    ? {
        uid: opts.auth.email,
        token: {
          email: opts.auth.email,
          ...(opts.auth.isPlatformSuperadmin === true ? { isPlatformSuperadmin: true } : {}),
        },
      }
    : undefined;
  return {
    data: opts.data,
    auth,
    rawRequest: {} as unknown,
    acceptsStreaming: false,
  } as unknown as never;
}

describe.skipIf(!hasEmulators())('createStake callable', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  // ----- Auth -----

  it('rejects an unauthenticated caller with unauthenticated', async () => {
    await expect(
      createStake.run(
        callableReq({
          auth: null,
          data: {
            stake_name: 'Cottonwood South Stake',
            bootstrap_admin_email: 'admin@example.com',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a signed-in non-superadmin with permission-denied', async () => {
    await expect(
      createStake.run(
        callableReq({
          auth: { email: 'someone@gmail.com' },
          data: {
            stake_name: 'Cottonwood South Stake',
            bootstrap_admin_email: 'admin@example.com',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects an auth token without an email with failed-precondition', async () => {
    // Synthesize a superadmin token that's missing the email field — the
    // callable cannot derive the actor canonical without it.
    const reqArg = {
      data: { stake_name: 'X Stake', bootstrap_admin_email: 'admin@example.com' },
      auth: { uid: 'no-email', token: { isPlatformSuperadmin: true } },
      rawRequest: {} as unknown,
      acceptsStreaming: false,
    } as unknown as Parameters<typeof createStake.run>[0];
    await expect(createStake.run(reqArg)).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  // ----- Input validation -----

  it('returns name_required on empty stake_name', async () => {
    const result = await createStake.run(
      callableReq({
        auth: { email: SUPERADMIN_EMAIL, isPlatformSuperadmin: true },
        data: { stake_name: '   ', bootstrap_admin_email: 'admin@example.com' },
      }),
    );
    expect(result).toEqual({ success: false, error: 'name_required' });
  });

  it('returns email_required on empty bootstrap_admin_email', async () => {
    const result = await createStake.run(
      callableReq({
        auth: { email: SUPERADMIN_EMAIL, isPlatformSuperadmin: true },
        data: { stake_name: 'Cottonwood South Stake', bootstrap_admin_email: '   ' },
      }),
    );
    expect(result).toEqual({ success: false, error: 'email_required' });
  });

  it('returns invalid_slug when stake_name slugifies to empty', async () => {
    const result = await createStake.run(
      callableReq({
        auth: { email: SUPERADMIN_EMAIL, isPlatformSuperadmin: true },
        data: { stake_name: '!!!', bootstrap_admin_email: 'admin@example.com' },
      }),
    );
    expect(result).toEqual({ success: false, error: 'invalid_slug' });
  });

  it('rejects non-string stake_name with invalid-argument', async () => {
    await expect(
      createStake.run(
        callableReq({
          auth: { email: SUPERADMIN_EMAIL, isPlatformSuperadmin: true },
          data: { stake_name: 42, bootstrap_admin_email: 'admin@example.com' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects non-string bootstrap_admin_email with invalid-argument', async () => {
    await expect(
      createStake.run(
        callableReq({
          auth: { email: SUPERADMIN_EMAIL, isPlatformSuperadmin: true },
          data: { stake_name: 'Cottonwood South Stake', bootstrap_admin_email: 42 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  // ----- Happy path -----

  it('writes a fully-populated parent stake doc with the derived slug as doc ID', async () => {
    const result = await createStake.run(
      callableReq({
        auth: { email: SUPERADMIN_EMAIL, isPlatformSuperadmin: true },
        data: {
          stake_name: 'Cottonwood South Stake',
          bootstrap_admin_email: 'admin@example.com',
        },
      }),
    );
    expect(result).toEqual({ success: true, stakeId: 'cottonwood-south-stake' });

    const { db } = requireEmulators();
    const snap = await db.doc('stakes/cottonwood-south-stake').get();
    expect(snap.exists).toBe(true);
    const stake = snap.data() as Stake;
    expect(stake.stake_id).toBe('cottonwood-south-stake');
    expect(stake.stake_name).toBe('Cottonwood South Stake');
    expect(stake.bootstrap_admin_email).toBe('admin@example.com');
    expect(stake.setup_complete).toBe(false);
    expect(stake.stake_seat_cap).toBe(0);
    expect(stake.expiry_hour).toBe(4);
    expect(stake.timezone).toBe('America/Denver');
    expect(stake.notifications_enabled).toBe(true);
    expect(stake.last_over_caps_json).toEqual([]);
    // Bookkeeping
    expect(stake.created_by).toBe(SUPERADMIN_EMAIL); // bare canonical email per §4.1
    expect(stake.last_modified_by).toEqual({
      email: SUPERADMIN_EMAIL,
      canonical: SUPERADMIN_EMAIL,
    });
    expect(stake.lastActor).toEqual({ email: SUPERADMIN_EMAIL, canonical: SUPERADMIN_EMAIL });
    // Timestamps are server-timestamped — type-check only.
    expect(stake.created_at).toBeInstanceOf(Timestamp);
    expect(stake.last_modified_at).toBeInstanceOf(Timestamp);

    // None of the deprecated importer fields should be set on a fresh stake.
    const raw = snap.data() as Record<string, unknown>;
    expect(raw['callings_sheet_id']).toBeUndefined();
    expect(raw['import_day']).toBeUndefined();
    expect(raw['import_hour']).toBeUndefined();
  });

  it('slugifies dotted / mixed-case names ("St. George Utah" → "st-george-utah")', async () => {
    const result = await createStake.run(
      callableReq({
        auth: { email: SUPERADMIN_EMAIL, isPlatformSuperadmin: true },
        data: {
          stake_name: 'St. George Utah',
          bootstrap_admin_email: 'admin@example.com',
        },
      }),
    );
    expect(result).toEqual({ success: true, stakeId: 'st-george-utah' });

    const { db } = requireEmulators();
    const snap = await db.doc('stakes/st-george-utah').get();
    expect(snap.exists).toBe(true);
    expect((snap.data() as Stake).stake_name).toBe('St. George Utah');
  });

  it('honours an operator-typed timezone override', async () => {
    await createStake.run(
      callableReq({
        auth: { email: SUPERADMIN_EMAIL, isPlatformSuperadmin: true },
        data: {
          stake_name: 'Pacific Stake',
          bootstrap_admin_email: 'admin@example.com',
          timezone: 'America/Los_Angeles',
        },
      }),
    );
    const { db } = requireEmulators();
    const stake = (await db.doc('stakes/pacific-stake').get()).data() as Stake;
    expect(stake.timezone).toBe('America/Los_Angeles');
  });

  it('stores bootstrap_admin_email TYPED (mixed-case, dots, +suffix preserved — NOT canonicalized)', async () => {
    // Per F19 / firebase-schema.md §4.1: the isBootstrapAdmin rule
    // compares typed against request.auth.token.email, so canonicalising
    // here would silently break the bootstrap-admin escape hatch.
    await createStake.run(
      callableReq({
        auth: { email: SUPERADMIN_EMAIL, isPlatformSuperadmin: true },
        data: {
          stake_name: 'Bootstrap Stake',
          bootstrap_admin_email: 'Foo.Bar+wizard@Gmail.com',
        },
      }),
    );
    const { db } = requireEmulators();
    const stake = (await db.doc('stakes/bootstrap-stake').get()).data() as Stake;
    expect(stake.bootstrap_admin_email).toBe('Foo.Bar+wizard@Gmail.com');
    // Sanity: the canonical form is `foobar@gmail.com`; verify the value
    // is NOT that, i.e. the callable preserved the typed string.
    expect(stake.bootstrap_admin_email).not.toBe('foobar@gmail.com');
  });

  it('preserves typed caller email on lastActor.email while canonicalizing for the canonical half', async () => {
    // Mixed-case + +suffix caller. created_by is the canonical form
    // (bare string per §4.1); lastActor / last_modified_by carry the
    // {email: typed, canonical} pair.
    const TYPED_CALLER = 'A.D.M.I.N+work@Gmail.com';
    await createStake.run(
      callableReq({
        auth: { email: TYPED_CALLER, isPlatformSuperadmin: true },
        data: {
          stake_name: 'Actor Stake',
          bootstrap_admin_email: 'admin@example.com',
        },
      }),
    );
    const { db } = requireEmulators();
    const stake = (await db.doc('stakes/actor-stake').get()).data() as Stake;
    expect(stake.created_by).toBe('admin@gmail.com');
    expect(stake.lastActor).toEqual({ email: TYPED_CALLER, canonical: 'admin@gmail.com' });
    expect(stake.last_modified_by).toEqual({ email: TYPED_CALLER, canonical: 'admin@gmail.com' });
  });

  // ----- Slug collision -----

  it('returns slug_collision when a stake doc already exists at the derived slug; no audit row written', async () => {
    const { db } = requireEmulators();
    // Pre-seed the colliding parent doc with a minimal body. We don't
    // care about its content — only that `tx.get(stakeRef).exists` is
    // true.
    await db.doc('stakes/cottonwood-south-stake').set({
      stake_id: 'cottonwood-south-stake',
      stake_name: 'Pre-existing Cottonwood South Stake',
    });

    const result = await createStake.run(
      callableReq({
        auth: { email: SUPERADMIN_EMAIL, isPlatformSuperadmin: true },
        data: {
          stake_name: 'Cottonwood South Stake',
          bootstrap_admin_email: 'admin@example.com',
        },
      }),
    );
    expect(result).toEqual({ success: false, error: 'slug_collision' });

    // Pre-existing doc untouched: still carries the seed `stake_name`.
    const stake = (await db.doc('stakes/cottonwood-south-stake').get()).data() as Stake;
    expect(stake.stake_name).toBe('Pre-existing Cottonwood South Stake');

    // No audit row written.
    const auditSnap = await db.collection('platformAuditLog').get();
    expect(auditSnap.empty).toBe(true);
  });

  // ----- platformAuditLog -----

  it('emits a platformAuditLog row with action=create_stake on success', async () => {
    await createStake.run(
      callableReq({
        auth: { email: SUPERADMIN_EMAIL, isPlatformSuperadmin: true },
        data: {
          stake_name: 'Audit Stake',
          bootstrap_admin_email: 'admin@example.com',
          timezone: 'America/Phoenix',
        },
      }),
    );

    const { db } = requireEmulators();
    const auditSnap = await db.collection('platformAuditLog').get();
    expect(auditSnap.size).toBe(1);
    const row = auditSnap.docs[0]!.data() as PlatformAuditLog & { after: Record<string, unknown> };
    expect(row.action).toBe('create_stake');
    expect(row.entity_type).toBe('stake');
    expect(row.entity_id).toBe('audit-stake');
    expect(row.actor_email).toBe(SUPERADMIN_EMAIL);
    expect(row.actor_canonical).toBe(SUPERADMIN_EMAIL);
    expect(row.before).toBe(null);
    expect(row.after).toMatchObject({
      stake_id: 'audit-stake',
      stake_name: 'Audit Stake',
      bootstrap_admin_email: 'admin@example.com',
      timezone: 'America/Phoenix',
    });
    expect(row.timestamp).toBeInstanceOf(Timestamp);
    expect(row.ttl).toBeInstanceOf(Timestamp);

    // The doc ID should be the `<ISO timestamp>_<suffix>` shape from
    // `auditId()`. Cheap sanity check: presence of the underscore
    // separator between an ISO-8601 prefix and a non-empty suffix.
    const docId = auditSnap.docs[0]!.id;
    expect(docId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_.+/);
  });
});
