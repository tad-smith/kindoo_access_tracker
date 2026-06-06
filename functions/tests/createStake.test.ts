// Integration tests for the `createStake` callable. Backs the Stake
// List page's Create Stake form (spec §5.4 / F19). Coverage: auth gate
// on the `isPlatformSuperadmin` claim, slug derivation + collision
// detection, soft-failure envelope on empty inputs / invalid slugs,
// lowercased-but-dots-and-+suffix-preserved bootstrap email storage,
// ActorRef shape on the bookkeeping fields, and `platformAuditLog`
// row emission.

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

  it('returns invalid_email for a malformed bootstrap_admin_email; no parent doc, no audit row', async () => {
    // Defense in depth alongside the web's zod `.email()` validation —
    // catches a missing-TLD / missing-@ string sent by a non-form
    // client (direct REST, extension, etc.). Fires pre-transaction so
    // neither the parent doc nor the audit row lands.
    const result = await createStake.run(
      callableReq({
        auth: { email: SUPERADMIN_EMAIL, isPlatformSuperadmin: true },
        data: { stake_name: 'Bad Email Stake', bootstrap_admin_email: 'admin@bad' },
      }),
    );
    expect(result).toEqual({ success: false, error: 'invalid_email' });

    const { db } = requireEmulators();
    const stakeSnap = await db.doc('stakes/bad-email-stake').get();
    expect(stakeSnap.exists).toBe(false);
    const auditSnap = await db.collection('platformAuditLog').get();
    expect(auditSnap.empty).toBe(true);
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

  it('returns invalid_timezone for a non-IANA tz; no parent doc, no audit row', async () => {
    // The audit-log date filter and other tz-sensitive paths call
    // `Intl.DateTimeFormat(undefined, { timeZone })`; a malformed value
    // would throw `RangeError`. Catch it here at provisioning time.
    const result = await createStake.run(
      callableReq({
        auth: { email: SUPERADMIN_EMAIL, isPlatformSuperadmin: true },
        data: {
          stake_name: 'Bad TZ Stake',
          bootstrap_admin_email: 'admin@example.com',
          timezone: 'Mars/Olympus',
        },
      }),
    );
    expect(result).toEqual({ success: false, error: 'invalid_timezone' });

    // No parent doc and no audit row should land — the check fires
    // before the transaction is entered.
    const { db } = requireEmulators();
    const stakeSnap = await db.doc('stakes/bad-tz-stake').get();
    expect(stakeSnap.exists).toBe(false);
    const auditSnap = await db.collection('platformAuditLog').get();
    expect(auditSnap.empty).toBe(true);
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

  it('lowercases bootstrap_admin_email on write (case normalized; dots + +suffix preserved)', async () => {
    // Per F19 / firebase-schema.md §4.1: the isBootstrapAdmin rule
    // does a plain string compare against request.auth.token.email,
    // and Firebase Auth always emits the email claim lowercased.
    // Case-normalize on write so an operator typo (`Foo@Bar`) can't
    // defeat the gate. We do NOT call canonicalEmail() — that would
    // strip Gmail dots and +suffix, silently breaking the escape
    // hatch for operators who use those address variants.
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
    // Lowercased — case normalized.
    expect(stake.bootstrap_admin_email).toBe('foo.bar+wizard@gmail.com');
    // Dots and +suffix survive (NOT the canonical 'foobar@gmail.com').
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

  it('emits a platformAuditLog row whose `after` is the full snapshot of the just-written stake doc', async () => {
    // Mirrors the parameterized `auditTrigger`'s convention: `after`
    // carries the entire post-write doc body, not a four-field subset.
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
    expect(row.timestamp).toBeInstanceOf(Timestamp);
    expect(row.ttl).toBeInstanceOf(Timestamp);

    // Pull the stake doc back and assert the audit `after` snapshot
    // equals it field-for-field. Excludes the doc-snapshot's
    // bookkeeping timestamps (Timestamp instances on both sides are
    // equal by reference at this point — they're written from the same
    // in-process value — so toEqual would still pass; the structural
    // assertion below is the contract).
    const stake = (await db.doc('stakes/audit-stake').get()).data() as Stake;
    const after = row.after as Record<string, unknown>;

    // Every field on the stake doc must appear on `after.*` with the
    // same value (Timestamp pairs compare via Timestamp.isEqual).
    for (const [k, v] of Object.entries(stake)) {
      if (v instanceof Timestamp) {
        expect(after[k]).toBeInstanceOf(Timestamp);
        expect((after[k] as Timestamp).isEqual(v)).toBe(true);
      } else {
        expect(after[k]).toEqual(v);
      }
    }
    // And the audit row carries no extra fields beyond what's on the doc.
    expect(new Set(Object.keys(after))).toEqual(new Set(Object.keys(stake)));

    // Spot-check the identity / setup / default fields explicitly so a
    // future stake-schema addition doesn't silently slip out of the
    // audit snapshot.
    expect(after['stake_id']).toBe('audit-stake');
    expect(after['stake_name']).toBe('Audit Stake');
    expect(after['bootstrap_admin_email']).toBe('admin@example.com');
    expect(after['setup_complete']).toBe(false);
    expect(after['stake_seat_cap']).toBe(0);
    expect(after['timezone']).toBe('America/Phoenix');
    expect(after['notifications_enabled']).toBe(true);
    expect(after['last_over_caps_json']).toEqual([]);
    expect(after['created_by']).toBe(SUPERADMIN_EMAIL);
    expect(after['last_modified_by']).toEqual({
      email: SUPERADMIN_EMAIL,
      canonical: SUPERADMIN_EMAIL,
    });
    expect(after['lastActor']).toEqual({ email: SUPERADMIN_EMAIL, canonical: SUPERADMIN_EMAIL });

    // The doc ID should be the `<ISO timestamp>_<suffix>` shape from
    // `auditId()`. Cheap sanity check: presence of the underscore
    // separator between an ISO-8601 prefix and a non-empty suffix.
    const docId = auditSnap.docs[0]!.id;
    expect(docId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_.+/);
  });

  it('lowercased bootstrap email lands identically on the stake doc and the audit `after`; actor stays the typed caller email', async () => {
    // Round-trip the case-normalization through both writes:
    //   - `stakes/{slug}.bootstrap_admin_email` is lowercased.
    //   - `platformAuditLog.after.bootstrap_admin_email` mirrors that.
    //   - `actor_email` is the CALLER's typed superadmin email — only
    //     the stored bootstrap-admin field is normalized.
    const TYPED_CALLER = 'Super@gmail.com';
    await createStake.run(
      callableReq({
        auth: { email: TYPED_CALLER, isPlatformSuperadmin: true },
        data: {
          stake_name: 'Lowercase Email Stake',
          bootstrap_admin_email: 'Foo.Bar+work@Gmail.com',
        },
      }),
    );

    const { db } = requireEmulators();
    const stake = (await db.doc('stakes/lowercase-email-stake').get()).data() as Stake;
    expect(stake.bootstrap_admin_email).toBe('foo.bar+work@gmail.com');

    const auditSnap = await db.collection('platformAuditLog').get();
    expect(auditSnap.size).toBe(1);
    const row = auditSnap.docs[0]!.data() as PlatformAuditLog & { after: Record<string, unknown> };
    expect(row.after['bootstrap_admin_email']).toBe('foo.bar+work@gmail.com');
    // The caller's typed email lands on `actor_email` (display field);
    // case-normalization on `bootstrap_admin_email` is unrelated to
    // the audit's `actor_*` provenance fields.
    expect(row.actor_email).toBe(TYPED_CALLER);
    expect(row.actor_canonical).toBe('super@gmail.com');
  });
});
