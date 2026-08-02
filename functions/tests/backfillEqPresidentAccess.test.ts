// Integration tests for the `backfillEqPresidentAccess` callable, run
// against the Firestore emulator. Covers:
//
//   - Auth gate: active Kindoo Manager of the stake (NOT superadmin).
//   - Direction-vs-config guard: `grant` requires the flag ON, `revoke`
//     requires it OFF; a stale dialog confirmation fails cleanly.
//   - Seat selection: auto + ward scope + exact `Elders Quorum
//     President` title only.
//   - Merge-only access writes: other scopes' `importer_callings` and
//     `manual_grants` survive both directions untouched.
//   - Skip-if-equal idempotency: a second run writes nothing.
//   - Exact counters on every case.
//   - Delete attribution: the revoke branch's stamp-then-delete split,
//     its re-validation against a concurrent write, and the resulting
//     `delete_access` row naming the confirming manager.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { auditId } from '@kindoo/shared';
import type { Access, ActorRef, AuditLog, ManualGrant, Seat } from '@kindoo/shared';
import {
  backfillEqPresidentAccess,
  backfillEqPresidentAccessForStake,
} from '../src/callable/backfillEqPresidentAccess.js';
import { auditAccessWrites } from '../src/triggers/auditTrigger.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'csnorth';
const MANAGER_EMAIL = 'mgr@gmail.com';
const MEMBER_EMAIL = 'alice@gmail.com';
const EQP = 'Elders Quorum President';
/** `Elders Quorum President`'s index in the canonical calling order. */
const EQP_ORDER = 51;
const ACTOR = { email: 'admin@gmail.com', canonical: 'admin@gmail.com' };
const MANAGER_ACTOR: ActorRef = { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL };
/** Stands in for whatever actor last touched the doc before the backfill. */
const SYNC_ACTOR = { email: 'SyncActor:kindoo-only', canonical: 'SyncActor:kindoo-only' };

function callableReq(opts: { auth?: { email: string } | null; data: unknown }): never {
  return {
    data: opts.data,
    auth: opts.auth ? { uid: opts.auth.email, token: { email: opts.auth.email } } : undefined,
    rawRequest: {} as unknown,
    acceptsStreaming: false,
  } as unknown as never;
}

async function seedManager(opts: { active?: boolean; email?: string } = {}): Promise<void> {
  const { db } = requireEmulators();
  const email = opts.email ?? MANAGER_EMAIL;
  await db.doc(`stakes/${STAKE_ID}/kindooManagers/${email}`).set({
    member_canonical: email,
    member_email: email,
    name: email,
    active: opts.active ?? true,
    added_at: Timestamp.now(),
    added_by: ACTOR,
    lastActor: ACTOR,
  });
}

async function seedStake(opts: { eqPresidentAccess?: boolean } = {}): Promise<void> {
  const { db } = requireEmulators();
  const body: Record<string, unknown> = {
    stake_name: 'Cottonwood South Stake',
    bootstrap_admin_email: ACTOR.email,
    setup_complete: true,
    stake_seat_cap: 0,
    timezone: 'America/Denver',
    notifications_enabled: true,
    last_over_caps_json: [],
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    last_modified_by: ACTOR,
    lastActor: ACTOR,
  };
  if (opts.eqPresidentAccess !== undefined) {
    body.eq_president_app_access = opts.eqPresidentAccess;
  }
  await db.doc(`stakes/${STAKE_ID}`).set(body);
}

async function seedSeat(opts: {
  canonical?: string;
  scope?: string;
  type?: Seat['type'];
  callings?: string[];
}): Promise<void> {
  const { db } = requireEmulators();
  const canonical = opts.canonical ?? MEMBER_EMAIL;
  await db.doc(`stakes/${STAKE_ID}/seats/${canonical}`).set({
    member_canonical: canonical,
    member_email: canonical,
    member_name: `Name ${canonical}`,
    scope: opts.scope ?? 'CO',
    type: opts.type ?? 'auto',
    callings: opts.callings ?? [EQP],
    building_names: ['Maple Building'],
    duplicate_grants: [],
    duplicate_scopes: [],
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    last_modified_by: ACTOR,
    lastActor: ACTOR,
  });
}

async function seedAccess(opts: {
  canonical?: string;
  importer_callings?: Record<string, string[]>;
  manual_grants?: Record<string, ManualGrant[]>;
  sort_order?: number | null;
  lastActor?: { email: string; canonical: string };
}): Promise<void> {
  const { db } = requireEmulators();
  const canonical = opts.canonical ?? MEMBER_EMAIL;
  const actor = opts.lastActor ?? ACTOR;
  const body: Record<string, unknown> = {
    member_canonical: canonical,
    member_email: canonical,
    member_name: `Name ${canonical}`,
    importer_callings: opts.importer_callings ?? {},
    manual_grants: opts.manual_grants ?? {},
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    last_modified_by: actor,
    lastActor: actor,
  };
  if (opts.sort_order !== undefined) body.sort_order = opts.sort_order;
  await db.doc(`stakes/${STAKE_ID}/access/${canonical}`).set(body);
}

/**
 * Wrap a Firestore handle so `onCommit(i)` runs after the i-th
 * transaction commits. The revoke delete path is two separate committed
 * writes by design, and the window BETWEEN them is what the delete's
 * audit attribution and its re-validation both hinge on — this is the
 * only place a test can observe or perturb it deterministically.
 *
 * Deliberately narrow: `backfillEqPresidentAccessForStake` reaches for
 * exactly `collection`, `doc`, and `runTransaction`, so anything else is
 * a loud TypeError rather than a silent pass-through.
 */
function tapTransactions(db: Firestore, onCommit: (index: number) => Promise<void>): Firestore {
  let index = 0;
  return {
    collection: (path: string) => db.collection(path),
    doc: (path: string) => db.doc(path),
    runTransaction: async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => {
      const result = await db.runTransaction(fn);
      await onCommit(index++);
      return result;
    },
  } as unknown as Firestore;
}

function manualGrant(reason: string): ManualGrant {
  return {
    grant_id: `grant-${reason}`,
    reason,
    granted_by: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
    granted_at: Timestamp.now(),
  };
}

async function readAccess(canonical = MEMBER_EMAIL): Promise<Access | undefined> {
  const { db } = requireEmulators();
  const snap = await db.doc(`stakes/${STAKE_ID}/access/${canonical}`).get();
  return snap.exists ? (snap.data() as Access) : undefined;
}

/** Invoke the callable as the seeded active manager. */
async function run(direction: 'grant' | 'revoke'): Promise<unknown> {
  return backfillEqPresidentAccess.run(
    callableReq({
      auth: { email: MANAGER_EMAIL },
      data: { stakeId: STAKE_ID, direction },
    }),
  );
}

describe.skipIf(!hasEmulators())('backfillEqPresidentAccess (integration)', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  // ----- Auth + shape guards -----

  it('rejects an unauthenticated caller with unauthenticated', async () => {
    await expect(
      backfillEqPresidentAccess.run(
        callableReq({ auth: null, data: { stakeId: STAKE_ID, direction: 'grant' } }),
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a signed-in non-manager with permission-denied', async () => {
    await seedStake({ eqPresidentAccess: true });
    await expect(
      backfillEqPresidentAccess.run(
        callableReq({
          auth: { email: 'outsider@gmail.com' },
          data: { stakeId: STAKE_ID, direction: 'grant' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects a manager whose record is inactive with permission-denied', async () => {
    await seedManager({ active: false });
    await seedStake({ eqPresidentAccess: true });
    await expect(run('grant')).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects a missing stakeId with invalid-argument', async () => {
    await seedManager();
    await expect(
      backfillEqPresidentAccess.run(
        callableReq({ auth: { email: MANAGER_EMAIL }, data: { direction: 'grant' } }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects an unknown direction with invalid-argument', async () => {
    await seedManager();
    await expect(
      backfillEqPresidentAccess.run(
        callableReq({
          auth: { email: MANAGER_EMAIL },
          data: { stakeId: STAKE_ID, direction: 'sideways' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  // ----- Direction-vs-config guard -----

  it("rejects direction='grant' when the stake flag is not enabled", async () => {
    await seedManager();
    await seedStake({ eqPresidentAccess: false });
    await seedSeat({});
    await expect(run('grant')).rejects.toMatchObject({ code: 'failed-precondition' });
    // Nothing written.
    expect(await readAccess()).toBeUndefined();
  });

  it("rejects direction='grant' when the stake doc is missing entirely (absent ⇒ off)", async () => {
    await seedManager();
    await seedSeat({});
    await expect(run('grant')).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it("rejects direction='revoke' while the stake flag is still enabled", async () => {
    await seedManager();
    await seedStake({ eqPresidentAccess: true });
    await seedSeat({});
    await seedAccess({ importer_callings: { CO: [EQP] }, sort_order: EQP_ORDER });
    await expect(run('revoke')).rejects.toMatchObject({ code: 'failed-precondition' });
    // The grant survives the rejected call.
    expect((await readAccess())?.importer_callings).toEqual({ CO: [EQP] });
  });

  // ----- Grant -----

  it('grant: creates an access doc for an Elders Quorum President auto ward seat', async () => {
    await seedManager();
    await seedStake({ eqPresidentAccess: true });
    await seedSeat({});

    const result = await run('grant');
    expect(result).toEqual({ ok: true, seats_matched: 1, docs_written: 1, docs_deleted: 0 });

    const access = await readAccess();
    expect(access?.importer_callings).toEqual({ CO: [EQP] });
    expect(access?.manual_grants).toEqual({});
    expect(access?.sort_order).toBe(EQP_ORDER);
    expect(access?.member_canonical).toBe(MEMBER_EMAIL);
    expect(access?.member_name).toBe(`Name ${MEMBER_EMAIL}`);
    // Human attribution — the manager who confirmed the backfill.
    expect(access?.lastActor).toEqual({ email: MANAGER_EMAIL, canonical: MANAGER_EMAIL });
    expect(access?.last_modified_by).toEqual({ email: MANAGER_EMAIL, canonical: MANAGER_EMAIL });
  });

  it("grant: merges into an existing doc, preserving other scopes' importer_callings and manual_grants", async () => {
    await seedManager();
    await seedStake({ eqPresidentAccess: true });
    await seedSeat({ scope: 'CO', callings: ['Bishop', EQP] });
    await seedAccess({
      importer_callings: { CO: ['Bishop'], DR: ['Ward Clerk'] },
      manual_grants: { CO: [manualGrant('training')] },
      sort_order: 42,
    });

    const result = await run('grant');
    expect(result).toEqual({ ok: true, seats_matched: 1, docs_written: 1, docs_deleted: 0 });

    const access = await readAccess();
    // Merged into the seat's scope; the other scope's list is byte-identical.
    expect(access?.importer_callings).toEqual({ CO: ['Bishop', EQP], DR: ['Ward Clerk'] });
    expect(access?.manual_grants['CO']?.length).toBe(1);
    expect(access?.manual_grants['CO']?.[0]?.reason).toBe('training');
    // MIN(prior 42, EQP 51) = 42.
    expect(access?.sort_order).toBe(42);
  });

  it('grant: skips manual / temp seats, stake-scope seats, and non-exact quorum titles', async () => {
    await seedManager();
    await seedStake({ eqPresidentAccess: true });
    await seedSeat({ canonical: 'manualseat@gmail.com', type: 'manual', callings: [EQP] });
    await seedSeat({ canonical: 'tempseat@gmail.com', type: 'temp', callings: [EQP] });
    await seedSeat({ canonical: 'stakeseat@gmail.com', scope: 'stake', callings: [EQP] });
    await seedSeat({
      canonical: 'counselor@gmail.com',
      callings: ['Elders Quorum First Counselor'],
    });
    await seedSeat({ canonical: 'secretary@gmail.com', callings: ['Elders Quorum Secretary'] });

    const result = await run('grant');
    expect(result).toEqual({ ok: true, seats_matched: 0, docs_written: 0, docs_deleted: 0 });

    const { db } = requireEmulators();
    const accessSnap = await db.collection(`stakes/${STAKE_ID}/access`).get();
    expect(accessSnap.size).toBe(0);
  });

  it('grant: matches the calling case-insensitively and preserves the seat casing', async () => {
    await seedManager();
    await seedStake({ eqPresidentAccess: true });
    await seedSeat({ callings: ['  elders quorum PRESIDENT '] });

    const result = await run('grant');
    expect(result).toEqual({ ok: true, seats_matched: 1, docs_written: 1, docs_deleted: 0 });
    expect((await readAccess())?.importer_callings).toEqual({ CO: ['  elders quorum PRESIDENT '] });
  });

  it('grant: re-run is a no-op (docs_written 0) while seats_matched stays', async () => {
    await seedManager();
    await seedStake({ eqPresidentAccess: true });
    await seedSeat({});

    expect(await run('grant')).toEqual({
      ok: true,
      seats_matched: 1,
      docs_written: 1,
      docs_deleted: 0,
    });
    expect(await run('grant')).toEqual({
      ok: true,
      seats_matched: 1,
      docs_written: 0,
      docs_deleted: 0,
    });
    expect((await readAccess())?.importer_callings).toEqual({ CO: [EQP] });
  });

  it('grant: counts every matched seat across a mixed roster', async () => {
    await seedManager();
    await seedStake({ eqPresidentAccess: true });
    await seedSeat({ canonical: 'a@gmail.com', scope: 'CO', callings: [EQP] });
    await seedSeat({ canonical: 'b@gmail.com', scope: 'DR', callings: ['Bishop', EQP] });
    // Already granted → matched but not written.
    await seedSeat({ canonical: 'c@gmail.com', scope: 'CO', callings: [EQP] });
    await seedAccess({ canonical: 'c@gmail.com', importer_callings: { CO: [EQP] } });
    // Not a match at all.
    await seedSeat({ canonical: 'd@gmail.com', scope: 'CO', callings: ['Bishop'] });

    expect(await run('grant')).toEqual({
      ok: true,
      seats_matched: 3,
      docs_written: 2,
      docs_deleted: 0,
    });
    expect(await readAccess('d@gmail.com')).toBeUndefined();
    expect((await readAccess('b@gmail.com'))?.importer_callings).toEqual({ DR: [EQP] });
  });

  // ----- Revoke -----

  it('revoke: removes only the Elders Quorum President entry; a Bishop entry survives', async () => {
    await seedManager();
    await seedStake({ eqPresidentAccess: false });
    await seedSeat({ callings: ['Bishop', EQP] });
    await seedAccess({ importer_callings: { CO: ['Bishop', EQP] }, sort_order: 42 });

    expect(await run('revoke')).toEqual({
      ok: true,
      seats_matched: 1,
      docs_written: 1,
      docs_deleted: 0,
    });

    const access = await readAccess();
    expect(access?.importer_callings).toEqual({ CO: ['Bishop'] });
    // Recomputed as the MIN across everything left in the map.
    expect(access?.sort_order).toBe(42);
    expect(access?.lastActor).toEqual({ email: MANAGER_EMAIL, canonical: MANAGER_EMAIL });
  });

  it("revoke: leaves other scopes' importer_callings intact and recomputes sort_order across them", async () => {
    await seedManager();
    await seedStake({ eqPresidentAccess: false });
    await seedSeat({ scope: 'DR', callings: [EQP] });
    await seedAccess({
      importer_callings: { CO: ['Ward Clerk'], DR: [EQP] },
      sort_order: EQP_ORDER,
    });

    expect(await run('revoke')).toEqual({
      ok: true,
      seats_matched: 1,
      docs_written: 1,
      docs_deleted: 0,
    });

    const access = await readAccess();
    // The DR key is dropped entirely once its list empties.
    expect(access?.importer_callings).toEqual({ CO: ['Ward Clerk'] });
    // `Ward Clerk` = 47.
    expect(access?.sort_order).toBe(47);
  });

  it('revoke: deletes the doc when the importer map empties and there are no manual grants', async () => {
    await seedManager();
    await seedStake({ eqPresidentAccess: false });
    await seedSeat({});
    await seedAccess({
      importer_callings: { CO: [EQP] },
      sort_order: EQP_ORDER,
      lastActor: SYNC_ACTOR,
    });

    expect(await run('revoke')).toEqual({
      ok: true,
      seats_matched: 1,
      docs_written: 0,
      docs_deleted: 1,
    });
    expect(await readAccess()).toBeUndefined();
  });

  it('revoke: keeps the doc when the importer map empties but manual grants remain', async () => {
    await seedManager();
    await seedStake({ eqPresidentAccess: false });
    await seedSeat({});
    await seedAccess({
      importer_callings: { CO: [EQP] },
      manual_grants: { CO: [manualGrant('training')] },
      sort_order: EQP_ORDER,
    });

    expect(await run('revoke')).toEqual({
      ok: true,
      seats_matched: 1,
      docs_written: 1,
      docs_deleted: 0,
    });

    const access = await readAccess();
    expect(access?.importer_callings).toEqual({});
    expect(access?.manual_grants['CO']?.length).toBe(1);
    expect(access?.manual_grants['CO']?.[0]?.reason).toBe('training');
    // Nothing left in the importer map → null per the Access contract.
    expect(access?.sort_order).toBe(null);
  });

  it('revoke: a manual-grants-only doc is untouched (nothing to reap)', async () => {
    await seedManager();
    await seedStake({ eqPresidentAccess: false });
    await seedSeat({});
    await seedAccess({ manual_grants: { CO: [manualGrant('training')] } });

    expect(await run('revoke')).toEqual({
      ok: true,
      seats_matched: 1,
      docs_written: 0,
      docs_deleted: 0,
    });

    const access = await readAccess();
    expect(access?.importer_callings).toEqual({});
    expect(access?.manual_grants['CO']?.length).toBe(1);
    // Untouched: still the seeded actor, not the calling manager.
    expect(access?.lastActor).toEqual(ACTOR);
  });

  it('revoke: no access doc at all is a skip, not an error', async () => {
    await seedManager();
    await seedStake({ eqPresidentAccess: false });
    await seedSeat({});

    expect(await run('revoke')).toEqual({
      ok: true,
      seats_matched: 1,
      docs_written: 0,
      docs_deleted: 0,
    });
    expect(await readAccess()).toBeUndefined();
  });

  it('revoke: re-run is a no-op', async () => {
    await seedManager();
    await seedStake({ eqPresidentAccess: false });
    await seedSeat({ callings: ['Bishop', EQP] });
    await seedAccess({ importer_callings: { CO: ['Bishop', EQP] }, sort_order: 42 });

    expect(await run('revoke')).toEqual({
      ok: true,
      seats_matched: 1,
      docs_written: 1,
      docs_deleted: 0,
    });
    expect(await run('revoke')).toEqual({
      ok: true,
      seats_matched: 1,
      docs_written: 0,
      docs_deleted: 0,
    });
    expect((await readAccess())?.importer_callings).toEqual({ CO: ['Bishop'] });
  });

  // ----- Revoke delete: attribution + re-validation -----
  //
  // The delete branch is two committed writes — a bookkeeping stamp,
  // then the delete — because a stamp and a delete in one transaction
  // coalesce to a bare delete, and the audit trigger reads the BEFORE
  // snapshot on a delete. These drive the inner
  // `backfillEqPresidentAccessForStake` through `tapTransactions` so the
  // window between the two commits is observable; the callable wrapper
  // adds only auth + the direction guard, covered above.

  describe('revoke delete: audit attribution', () => {
    it('stamps the confirming manager before deleting, so delete_access names them', async () => {
      const { db } = requireEmulators();
      await seedSeat({});
      // Prior actor is deliberately NOT the manager: without the stamp
      // the delete's BEFORE would still carry this value and the audit
      // row would name Sync.
      await seedAccess({
        importer_callings: { CO: [EQP] },
        sort_order: EQP_ORDER,
        lastActor: SYNC_ACTOR,
      });

      let stamped: Record<string, unknown> | undefined;
      const tapped = tapTransactions(db, async (index) => {
        if (index !== 0) return;
        const snap = await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).get();
        if (snap.exists) stamped = snap.data();
      });

      const result = await backfillEqPresidentAccessForStake(
        tapped,
        STAKE_ID,
        'revoke',
        MANAGER_ACTOR,
      );
      expect(result).toEqual({ ok: true, seats_matched: 1, docs_written: 0, docs_deleted: 1 });
      expect(await readAccess()).toBeUndefined();

      // The doc that the delete's BEFORE snapshot captured.
      expect(stamped).toBeDefined();
      expect(stamped?.['lastActor']).toEqual(MANAGER_ACTOR);
      expect(stamped?.['last_modified_by']).toEqual(MANAGER_ACTOR);
      // Bookkeeping-only: the first write changes no material field, so
      // the audit trigger no-ops it and the pair fans a single row.
      expect(stamped?.['importer_callings']).toEqual({ CO: [EQP] });

      // Replay the delete through the trigger with that real BEFORE.
      const time = '2026-06-02T18:00:00.000Z';
      await auditAccessWrites.run({
        params: { stakeId: STAKE_ID, memberCanonical: MEMBER_EMAIL },
        time,
        data: {
          before: { exists: true, data: () => stamped },
          after: { exists: false, data: () => undefined },
        },
      } as unknown as never);

      // Deterministic doc id — the deployed trigger fires on the real
      // delete too under the functions-emulator CI config, so reading
      // `docs[0]` of the collection would be ambiguous.
      const docId = auditId(new Date(time), `access_${MEMBER_EMAIL}`);
      const rowSnap = await db.doc(`stakes/${STAKE_ID}/auditLog/${docId}`).get();
      expect(rowSnap.exists).toBe(true);
      const row = rowSnap.data() as AuditLog;
      expect(row.entity_type).toBe('access');
      expect(row.entity_id).toBe(MEMBER_EMAIL);
      expect(row.action).toBe('delete_access');
      expect(row.actor_email).toBe(MANAGER_EMAIL);
      expect(row.actor_canonical).toBe(MANAGER_EMAIL);
    });

    it('re-validates: a manual grant landing between the two writes keeps the doc', async () => {
      const { db } = requireEmulators();
      await seedSeat({});
      await seedAccess({
        importer_callings: { CO: [EQP] },
        sort_order: EQP_ORDER,
        lastActor: SYNC_ACTOR,
      });

      const tapped = tapTransactions(db, async (index) => {
        if (index !== 0) return;
        await db
          .doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`)
          .update({ manual_grants: { CO: [manualGrant('training')] } });
      });

      const result = await backfillEqPresidentAccessForStake(
        tapped,
        STAKE_ID,
        'revoke',
        MANAGER_ACTOR,
      );
      // Not deleted — and counted as a write, because the revoke still
      // applied via the ordinary update path.
      expect(result).toEqual({ ok: true, seats_matched: 1, docs_written: 1, docs_deleted: 0 });

      const access = await readAccess();
      expect(access?.importer_callings).toEqual({});
      expect(access?.manual_grants['CO']?.length).toBe(1);
      expect(access?.manual_grants['CO']?.[0]?.reason).toBe('training');
      expect(access?.sort_order).toBe(null);
      expect(access?.lastActor).toEqual(MANAGER_ACTOR);
    });

    it('re-validates: importer callings regained for another scope keep the doc', async () => {
      const { db } = requireEmulators();
      await seedSeat({});
      await seedAccess({
        importer_callings: { CO: [EQP] },
        sort_order: EQP_ORDER,
        lastActor: SYNC_ACTOR,
      });

      const tapped = tapTransactions(db, async (index) => {
        if (index !== 0) return;
        await db
          .doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`)
          .update({ importer_callings: { CO: [EQP], DR: ['Ward Clerk'] } });
      });

      const result = await backfillEqPresidentAccessForStake(
        tapped,
        STAKE_ID,
        'revoke',
        MANAGER_ACTOR,
      );
      expect(result).toEqual({ ok: true, seats_matched: 1, docs_written: 1, docs_deleted: 0 });

      const access = await readAccess();
      // The Elders Quorum President entry is still reaped; the scope that
      // arrived mid-flight survives.
      expect(access?.importer_callings).toEqual({ DR: ['Ward Clerk'] });
      // `Ward Clerk` = 47.
      expect(access?.sort_order).toBe(47);
      expect(access?.lastActor).toEqual(MANAGER_ACTOR);
    });

    it('counts a doc deleted concurrently between the two writes as neither', async () => {
      const { db } = requireEmulators();
      await seedSeat({});
      await seedAccess({
        importer_callings: { CO: [EQP] },
        sort_order: EQP_ORDER,
        lastActor: SYNC_ACTOR,
      });

      const tapped = tapTransactions(db, async (index) => {
        if (index !== 0) return;
        await db.doc(`stakes/${STAKE_ID}/access/${MEMBER_EMAIL}`).delete();
      });

      const result = await backfillEqPresidentAccessForStake(
        tapped,
        STAKE_ID,
        'revoke',
        MANAGER_ACTOR,
      );
      // `docs_deleted` counts docs this run removed; this one was already
      // gone when the second write ran.
      expect(result).toEqual({ ok: true, seats_matched: 1, docs_written: 0, docs_deleted: 0 });
      expect(await readAccess()).toBeUndefined();
    });
  });
});
