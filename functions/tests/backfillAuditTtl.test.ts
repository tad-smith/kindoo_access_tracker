// Integration tests for the T-101 one-shot retention backfill. Runs
// against the Firestore emulator. Covers:
//
//   - Auth gate: signed-out, non-superadmin, missing stakeId.
//   - The rewrite: `ttl` becomes `timestamp + AUDIT_TTL_MS` on every
//     row, derived from the row's OWN timestamp (never wall-clock now).
//   - Idempotence: a second run reports zero writes.
//   - Per-stake scoping via the `stakeId` parameter.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { AUDIT_TTL_MS } from '@kindoo/shared';
import { backfillAuditTtl, backfillAuditTtlForStake } from '../src/callable/backfillAuditTtl.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

// A private stake id: the shared `csnorth` collection can receive
// late-landing rows from a previous file's deployed audit triggers (see
// `lib/emulator.ts`), and this suite counts whole-collection reads.
const STAKE_ID = 'backfill-audit-ttl-suite';
const OTHER_STAKE_ID = 'backfill-audit-ttl-other';
const SUPERADMIN_EMAIL = 'super@gmail.com';

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

/** Seed one audit row. `ttl` is omitted when `ttlMs` is undefined. */
async function seedRow(opts: {
  stakeId?: string;
  auditId: string;
  timestampMs: number;
  ttlMs?: number;
}): Promise<void> {
  const { db } = requireEmulators();
  const stakeId = opts.stakeId ?? STAKE_ID;
  const doc: Record<string, unknown> = {
    audit_id: opts.auditId,
    timestamp: Timestamp.fromMillis(opts.timestampMs),
    actor_email: 'mgr@gmail.com',
    actor_canonical: 'mgr@gmail.com',
    action: 'create_seat',
    entity_type: 'seat',
    entity_id: 'alice@gmail.com',
    before: null,
    after: { scope: 'stake', type: 'manual' },
  };
  if (opts.ttlMs !== undefined) doc.ttl = Timestamp.fromMillis(opts.ttlMs);
  await db.doc(`stakes/${stakeId}/auditLog/${opts.auditId}`).set(doc);
}

async function readTtlMs(auditId: string, stakeId = STAKE_ID): Promise<number | undefined> {
  const { db } = requireEmulators();
  const snap = await db.doc(`stakes/${stakeId}/auditLog/${auditId}`).get();
  const ttl = snap.get('ttl') as Timestamp | undefined;
  return ttl?.toMillis();
}

const OLD_TTL_MS = 365 * 24 * 60 * 60 * 1000;

describe.skipIf(!hasEmulators())('backfillAuditTtl (integration)', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  // ---- auth gate ----

  it('rejects a signed-out caller with unauthenticated', async () => {
    await expect(
      backfillAuditTtl.run(callableReq({ auth: null, data: { stakeId: STAKE_ID } })),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects an authenticated caller without the superadmin claim', async () => {
    await expect(
      backfillAuditTtl.run(
        callableReq({ auth: { email: 'mgr@gmail.com' }, data: { stakeId: STAKE_ID } }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects a missing stakeId with invalid-argument', async () => {
    await expect(
      backfillAuditTtl.run(
        callableReq({
          auth: { email: SUPERADMIN_EMAIL, isPlatformSuperadmin: true },
          data: {},
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('runs for a superadmin', async () => {
    const ts = Date.parse('2026-06-01T00:00:00.000Z');
    await seedRow({ auditId: 'row-a', timestampMs: ts, ttlMs: ts + OLD_TTL_MS });

    const result = await backfillAuditTtl.run(
      callableReq({
        auth: { email: SUPERADMIN_EMAIL, isPlatformSuperadmin: true },
        data: { stakeId: STAKE_ID },
      }),
    );
    expect(result).toMatchObject({ ok: true, rows_total: 1, rows_updated: 1, rows_failed: 0 });
    expect(await readTtlMs('row-a')).toBe(ts + AUDIT_TTL_MS);
  });

  // ---- the rewrite ----

  it('derives each ttl from the row own timestamp, not wall-clock now', async () => {
    const { db } = requireEmulators();
    // Two rows a year apart. If the backfill used `Date.now()` both would
    // land on (near enough) the same ttl; deriving from `timestamp` keeps
    // them a year apart, and neither is anywhere near now + 5y.
    const oldTs = Date.parse('2026-05-04T09:00:00.000Z');
    const newTs = Date.parse('2027-05-04T09:00:00.000Z');
    await seedRow({ auditId: 'row-old', timestampMs: oldTs, ttlMs: oldTs + OLD_TTL_MS });
    await seedRow({ auditId: 'row-new', timestampMs: newTs, ttlMs: newTs + OLD_TTL_MS });

    const result = await backfillAuditTtlForStake(db, STAKE_ID);
    expect(result.rows_total).toBe(2);
    expect(result.rows_updated).toBe(2);
    expect(result.rows_unchanged).toBe(0);
    expect(result.rows_failed).toBe(0);

    expect(await readTtlMs('row-old')).toBe(oldTs + AUDIT_TTL_MS);
    expect(await readTtlMs('row-new')).toBe(newTs + AUDIT_TTL_MS);
    expect((await readTtlMs('row-new'))! - (await readTtlMs('row-old'))!).toBe(newTs - oldTs);
  });

  it('stamps a ttl on a row that has none, and skips a row with no timestamp', async () => {
    const { db } = requireEmulators();
    const ts = Date.parse('2026-06-01T00:00:00.000Z');
    await seedRow({ auditId: 'row-no-ttl', timestampMs: ts });
    // A row whose `timestamp` is unusable has nothing to derive from —
    // left untouched rather than guessed at.
    await db.doc(`stakes/${STAKE_ID}/auditLog/row-bad`).set({
      audit_id: 'row-bad',
      actor_email: 'mgr@gmail.com',
      actor_canonical: 'mgr@gmail.com',
      action: 'create_seat',
      entity_type: 'seat',
      entity_id: 'alice@gmail.com',
      before: null,
      after: null,
    });

    const result = await backfillAuditTtlForStake(db, STAKE_ID);
    expect(result.rows_total).toBe(2);
    expect(result.rows_updated).toBe(1);
    expect(result.rows_skipped_no_timestamp).toBe(1);
    expect(await readTtlMs('row-no-ttl')).toBe(ts + AUDIT_TTL_MS);
    expect(await readTtlMs('row-bad')).toBeUndefined();
  });

  it('leaves the rest of the row alone', async () => {
    const { db } = requireEmulators();
    const ts = Date.parse('2026-06-01T00:00:00.000Z');
    await seedRow({ auditId: 'row-a', timestampMs: ts, ttlMs: ts + OLD_TTL_MS });

    await backfillAuditTtlForStake(db, STAKE_ID);

    const snap = await db.doc(`stakes/${STAKE_ID}/auditLog/row-a`).get();
    expect(snap.get('action')).toBe('create_seat');
    expect(snap.get('actor_canonical')).toBe('mgr@gmail.com');
    expect(snap.get('after')).toEqual({ scope: 'stake', type: 'manual' });
    expect((snap.get('timestamp') as Timestamp).toMillis()).toBe(ts);
  });

  // ---- idempotence ----

  it('is idempotent — a second run writes nothing', async () => {
    const { db } = requireEmulators();
    const ts = Date.parse('2026-06-01T00:00:00.000Z');
    await seedRow({ auditId: 'row-a', timestampMs: ts, ttlMs: ts + OLD_TTL_MS });
    await seedRow({ auditId: 'row-b', timestampMs: ts + 60_000 });

    const first = await backfillAuditTtlForStake(db, STAKE_ID);
    expect(first.rows_updated).toBe(2);

    const second = await backfillAuditTtlForStake(db, STAKE_ID);
    expect(second.rows_total).toBe(2);
    expect(second.rows_updated).toBe(0);
    expect(second.rows_unchanged).toBe(2);
    expect(await readTtlMs('row-a')).toBe(ts + AUDIT_TTL_MS);
    expect(await readTtlMs('row-b')).toBe(ts + 60_000 + AUDIT_TTL_MS);
  });

  // ---- scoping ----

  it('touches only the named stake', async () => {
    const { db } = requireEmulators();
    const ts = Date.parse('2026-06-01T00:00:00.000Z');
    await seedRow({ auditId: 'row-a', timestampMs: ts, ttlMs: ts + OLD_TTL_MS });
    await seedRow({
      stakeId: OTHER_STAKE_ID,
      auditId: 'row-a',
      timestampMs: ts,
      ttlMs: ts + OLD_TTL_MS,
    });

    const result = await backfillAuditTtlForStake(db, STAKE_ID);
    expect(result.rows_total).toBe(1);
    expect(await readTtlMs('row-a')).toBe(ts + AUDIT_TTL_MS);
    expect(await readTtlMs('row-a', OTHER_STAKE_ID)).toBe(ts + OLD_TTL_MS);
  });

  it('reports an empty stake without writing', async () => {
    const { db } = requireEmulators();
    const result = await backfillAuditTtlForStake(db, STAKE_ID);
    expect(result).toEqual({
      ok: true,
      rows_total: 0,
      rows_updated: 0,
      rows_unchanged: 0,
      rows_skipped_no_timestamp: 0,
      rows_failed: 0,
    });
  });
});
