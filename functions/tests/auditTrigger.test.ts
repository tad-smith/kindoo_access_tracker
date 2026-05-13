// Integration tests for the audit trigger. The trigger is exercised
// directly via `.run(event)` for the per-collection wrappers, AND via
// `emitAuditRow` for the rows that don't need a Change snapshot
// constructed (the helper accepts plain `before`/`after` objects).
//
// These cases mirror the §4.10 audit-row contract: the trigger emits
// one row per write, populates the right `entity_type` /
// `entity_id` / `member_canonical` / `actor_*` fields, derives the
// right action enum, and skips no-op updates.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  auditAccessWrites,
  auditBuildingWrites,
  auditManagerWrites,
  auditRequestWrites,
  auditSeatWrites,
  auditStakeWrites,
  auditWardWrites,
  emitAuditRow,
} from '../src/triggers/auditTrigger.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'csnorth';

/**
 * Build an event payload that satisfies the v2 onDocumentWritten
 * signature. The trigger only consults `event.params`, `event.time`,
 * and `event.data.before/after.exists/data()`, so we forge a
 * structurally-sufficient stub and cast through `unknown` — matching
 * the existing `makeEvent` pattern in the other trigger tests.
 */
function makeEvent<P extends Record<string, string>>(opts: {
  params: P;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  time?: string;
}): never {
  const time = opts.time ?? new Date().toISOString();
  const beforeSnap = {
    exists: opts.before != null,
    data: () => opts.before ?? undefined,
  };
  const afterSnap = {
    exists: opts.after != null,
    data: () => opts.after ?? undefined,
  };
  return {
    params: opts.params,
    time,
    data: { before: beforeSnap, after: afterSnap },
  } as unknown as never;
}

const lastActor = (canonical: string) => ({ email: canonical, canonical });

describe.skipIf(!hasEmulators())('audit trigger', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  // -------- Wards (template for the stake-bucketed entity types) --------

  it('create on a ward emits an audit row with action=update_stake, before=null, after=ward data', async () => {
    const time = '2026-04-28T12:00:00.000Z';
    const after = {
      ward_code: 'GE',
      ward_name: 'Greenwood Ward',
      building_name: 'Greenwood',
      seat_cap: 20,
      lastActor: lastActor('alice@gmail.com'),
    };
    await auditWardWrites.run(
      makeEvent({ params: { stakeId: STAKE_ID, wardId: 'GE' }, before: null, after, time }),
    );
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.action).toBe('update_stake');
    expect(r.entity_type).toBe('stake');
    expect(r.entity_id).toBe('ward:GE');
    expect(r.before).toBeNull();
    expect(r.after).toMatchObject({ ward_code: 'GE', ward_name: 'Greenwood Ward' });
    expect(r.actor_canonical).toBe('alice@gmail.com');
    expect(r.audit_id).toBe(r.audit_id_doc); // round-trip: doc id matches audit_id
    expect(r.member_canonical).toBeUndefined();
  });

  it('update on a ward emits an audit row with action=update_stake', async () => {
    const before = {
      ward_code: 'GE',
      ward_name: 'Greenwood Ward',
      building_name: 'Greenwood',
      seat_cap: 20,
      lastActor: lastActor('alice@gmail.com'),
    };
    const after = { ...before, seat_cap: 25, lastActor: lastActor('bob@gmail.com') };
    await auditWardWrites.run(
      makeEvent({ params: { stakeId: STAKE_ID, wardId: 'GE' }, before, after }),
    );
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('update_stake');
    expect(rows[0]!.actor_canonical).toBe('bob@gmail.com');
  });

  it('delete on a ward pulls actor from the BEFORE snapshot', async () => {
    const before = {
      ward_code: 'GE',
      ward_name: 'Greenwood Ward',
      lastActor: lastActor('alice@gmail.com'),
    };
    await auditWardWrites.run(
      makeEvent({ params: { stakeId: STAKE_ID, wardId: 'GE' }, before, after: null }),
    );
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('update_stake');
    expect(rows[0]!.before).toMatchObject({ ward_code: 'GE' });
    expect(rows[0]!.after).toBeNull();
    expect(rows[0]!.actor_canonical).toBe('alice@gmail.com');
  });

  // -------- Buildings --------

  it('create on a building emits a row with entity_id=building:<slug>', async () => {
    const after = {
      building_id: 'cordera',
      building_name: 'Cordera',
      address: '123 Cordera Way',
      lastActor: lastActor('alice@gmail.com'),
    };
    await auditBuildingWrites.run(
      makeEvent({
        params: { stakeId: STAKE_ID, buildingId: 'cordera' },
        before: null,
        after,
      }),
    );
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity_id).toBe('building:cordera');
    expect(rows[0]!.action).toBe('update_stake');
  });

  // -------- KindooManagers --------

  it('create on a manager emits create_manager + member_canonical', async () => {
    const after = {
      member_canonical: 'mgr@gmail.com',
      member_email: 'mgr@gmail.com',
      name: 'Mgr',
      active: true,
      lastActor: lastActor('alice@gmail.com'),
    };
    await auditManagerWrites.run(
      makeEvent({
        params: { stakeId: STAKE_ID, memberCanonical: 'mgr@gmail.com' },
        before: null,
        after,
      }),
    );
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('create_manager');
    expect(rows[0]!.entity_type).toBe('kindooManager');
    expect(rows[0]!.entity_id).toBe('mgr@gmail.com');
    expect(rows[0]!.member_canonical).toBe('mgr@gmail.com');
  });

  it('update on a manager emits update_manager', async () => {
    const before = {
      member_canonical: 'mgr@gmail.com',
      active: true,
      lastActor: lastActor('alice@gmail.com'),
    };
    const after = { ...before, active: false, lastActor: lastActor('bob@gmail.com') };
    await auditManagerWrites.run(
      makeEvent({
        params: { stakeId: STAKE_ID, memberCanonical: 'mgr@gmail.com' },
        before,
        after,
      }),
    );
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('update_manager');
  });

  it('delete on a manager emits delete_manager with actor from before', async () => {
    const before = {
      member_canonical: 'mgr@gmail.com',
      active: true,
      lastActor: lastActor('carol@gmail.com'),
    };
    await auditManagerWrites.run(
      makeEvent({
        params: { stakeId: STAKE_ID, memberCanonical: 'mgr@gmail.com' },
        before,
        after: null,
      }),
    );
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('delete_manager');
    expect(rows[0]!.actor_canonical).toBe('carol@gmail.com');
  });

  // -------- Access --------

  it('create / update / delete on access map to the access actions', async () => {
    const baseAfter = {
      member_canonical: 'a@gmail.com',
      member_email: 'a@gmail.com',
      member_name: 'Alice',
      importer_callings: { stake: ['Stake President'] },
      manual_grants: {},
      lastActor: lastActor('alice@gmail.com'),
    };
    await auditAccessWrites.run(
      makeEvent({
        params: { stakeId: STAKE_ID, memberCanonical: 'a@gmail.com' },
        before: null,
        after: baseAfter,
      }),
    );
    const rows1 = await readAuditRows();
    expect(rows1).toHaveLength(1);
    expect(rows1[0]!.action).toBe('create_access');
    expect(rows1[0]!.entity_type).toBe('access');
    expect(rows1[0]!.member_canonical).toBe('a@gmail.com');

    await clearAuditRows();

    const updated = {
      ...baseAfter,
      manual_grants: { GE: [{ grant_id: 'g1' }] },
      lastActor: lastActor('mgr@gmail.com'),
    };
    await auditAccessWrites.run(
      makeEvent({
        params: { stakeId: STAKE_ID, memberCanonical: 'a@gmail.com' },
        before: baseAfter,
        after: updated,
      }),
    );
    const rows2 = await readAuditRows();
    expect(rows2).toHaveLength(1);
    expect(rows2[0]!.action).toBe('update_access');

    await clearAuditRows();

    await auditAccessWrites.run(
      makeEvent({
        params: { stakeId: STAKE_ID, memberCanonical: 'a@gmail.com' },
        before: updated,
        after: null,
      }),
    );
    const rows3 = await readAuditRows();
    expect(rows3).toHaveLength(1);
    expect(rows3[0]!.action).toBe('delete_access');
  });

  // -------- Seats --------

  it('seat delete with lastActor=ExpiryTrigger emits auto_expire', async () => {
    const before = {
      member_canonical: 's@gmail.com',
      member_email: 's@gmail.com',
      member_name: 'Sam',
      scope: 'GE',
      type: 'temp',
      callings: [],
      building_names: ['Greenwood'],
      duplicate_grants: [],
      end_date: '2026-04-25',
      lastActor: { email: 'ExpiryTrigger', canonical: 'ExpiryTrigger' },
    };
    await auditSeatWrites.run(
      makeEvent({
        params: { stakeId: STAKE_ID, memberCanonical: 's@gmail.com' },
        before,
        after: null,
      }),
    );
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('auto_expire');
    expect(rows[0]!.actor_canonical).toBe('ExpiryTrigger');
  });

  it('seat writes map to create/update/delete seat with member_canonical', async () => {
    const after = {
      member_canonical: 's@gmail.com',
      member_email: 's@gmail.com',
      member_name: 'Sam',
      scope: 'GE',
      type: 'manual',
      callings: [],
      building_names: ['Greenwood'],
      duplicate_grants: [],
      lastActor: lastActor('mgr@gmail.com'),
    };
    await auditSeatWrites.run(
      makeEvent({
        params: { stakeId: STAKE_ID, memberCanonical: 's@gmail.com' },
        before: null,
        after,
      }),
    );
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('create_seat');
    expect(rows[0]!.entity_type).toBe('seat');
    expect(rows[0]!.member_canonical).toBe('s@gmail.com');
  });

  // -------- Requests (status-driven) --------

  it('request creation emits create_request', async () => {
    const after = {
      request_id: 'r1',
      type: 'add_manual',
      scope: 'GE',
      status: 'pending',
      member_canonical: 'sub@gmail.com',
      member_email: 'sub@gmail.com',
      requester_canonical: 'mgr@gmail.com',
      requester_email: 'mgr@gmail.com',
      lastActor: lastActor('mgr@gmail.com'),
    };
    await auditRequestWrites.run(
      makeEvent({
        params: { stakeId: STAKE_ID, requestId: 'r1' },
        before: null,
        after,
      }),
    );
    const rows = await readAuditRows();
    expect(rows[0]!.action).toBe('create_request');
    expect(rows[0]!.entity_type).toBe('request');
    expect(rows[0]!.entity_id).toBe('r1');
    expect(rows[0]!.member_canonical).toBe('sub@gmail.com');
  });

  it('request status flips emit complete/reject/cancel actions', async () => {
    const base = {
      request_id: 'r2',
      type: 'add_manual',
      scope: 'GE',
      member_canonical: 'sub@gmail.com',
      requester_canonical: 'mgr@gmail.com',
      lastActor: lastActor('mgr@gmail.com'),
    };
    // pending → complete
    await auditRequestWrites.run(
      makeEvent({
        params: { stakeId: STAKE_ID, requestId: 'r2' },
        before: { ...base, status: 'pending' },
        after: { ...base, status: 'complete', completer_canonical: 'mgr@gmail.com' },
      }),
    );
    let rows = await readAuditRows();
    expect(rows[0]!.action).toBe('complete_request');
    await clearAuditRows();

    // pending → rejected
    await auditRequestWrites.run(
      makeEvent({
        params: { stakeId: STAKE_ID, requestId: 'r2' },
        before: { ...base, status: 'pending' },
        after: { ...base, status: 'rejected', rejection_reason: 'no' },
      }),
    );
    rows = await readAuditRows();
    expect(rows[0]!.action).toBe('reject_request');
    await clearAuditRows();

    // pending → cancelled
    await auditRequestWrites.run(
      makeEvent({
        params: { stakeId: STAKE_ID, requestId: 'r2' },
        before: { ...base, status: 'pending' },
        after: { ...base, status: 'cancelled' },
      }),
    );
    rows = await readAuditRows();
    expect(rows[0]!.action).toBe('cancel_request');
  });

  // -------- Stake parent doc --------

  it('stake update emits update_stake; setup_complete flip emits setup_complete', async () => {
    const before = {
      stake_id: STAKE_ID,
      setup_complete: false,
      stake_name: 'Stake A',
      lastActor: lastActor('admin@gmail.com'),
    };
    const after = {
      ...before,
      stake_name: 'Stake A renamed',
      lastActor: lastActor('admin@gmail.com'),
    };
    await auditStakeWrites.run(makeEvent({ params: { stakeId: STAKE_ID }, before, after }));
    let rows = await readAuditRows();
    expect(rows[0]!.action).toBe('update_stake');
    await clearAuditRows();

    const completed = { ...before, setup_complete: true };
    await auditStakeWrites.run(
      makeEvent({ params: { stakeId: STAKE_ID }, before, after: completed }),
    );
    rows = await readAuditRows();
    expect(rows[0]!.action).toBe('setup_complete');
  });

  // -------- Extension v2.1 — kindoo_config diff --------

  it('stake.kindoo_config write produces an audit row with the new field in the diff', async () => {
    const before = {
      stake_id: STAKE_ID,
      setup_complete: true,
      stake_name: 'CS North Stake',
      lastActor: lastActor('mgr@gmail.com'),
    };
    const kindooConfig = {
      site_id: 27994,
      site_name: 'CS North Stake',
      configured_at: '2026-05-12T12:00:00.000Z',
      configured_by: { email: 'mgr@gmail.com', canonical: 'mgr@gmail.com' },
    };
    const after = { ...before, kindoo_config: kindooConfig };
    await auditStakeWrites.run(makeEvent({ params: { stakeId: STAKE_ID }, before, after }));
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('update_stake');
    expect(rows[0]!.entity_type).toBe('stake');
    expect(rows[0]!.entity_id).toBe(STAKE_ID);
    expect(rows[0]!.actor_canonical).toBe('mgr@gmail.com');
    // Before snapshot does not carry the new field; after snapshot does.
    expect((rows[0]!.before as Record<string, unknown>)['kindoo_config']).toBeUndefined();
    expect((rows[0]!.after as Record<string, unknown>)['kindoo_config']).toMatchObject({
      site_id: 27994,
      site_name: 'CS North Stake',
    });
  });

  // -------- No-op skip --------

  it('no-op updates (only bookkeeping changes) do NOT emit a row', async () => {
    const before = {
      ward_code: 'GE',
      ward_name: 'Greenwood Ward',
      seat_cap: 20,
      lastActor: lastActor('alice@gmail.com'),
      last_modified_at: 't1',
    };
    const after = {
      ...before,
      lastActor: lastActor('bob@gmail.com'),
      last_modified_at: 't2',
    };
    await auditWardWrites.run(
      makeEvent({ params: { stakeId: STAKE_ID, wardId: 'GE' }, before, after }),
    );
    const rows = await readAuditRows();
    expect(rows).toHaveLength(0);
  });

  // -------- Idempotency --------

  it('a retried trigger writes the same audit doc id (idempotent)', async () => {
    const time = '2026-04-28T12:34:56.000Z';
    const after = {
      ward_code: 'GE',
      ward_name: 'Greenwood Ward',
      seat_cap: 20,
      lastActor: lastActor('alice@gmail.com'),
    };
    const ev = makeEvent({
      params: { stakeId: STAKE_ID, wardId: 'GE' },
      before: null,
      after,
      time,
    });
    await auditWardWrites.run(ev);
    await auditWardWrites.run(ev);
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
  });

  // -------- audit_id matches doc id --------

  it('audit_id field equals the doc id', async () => {
    const time = '2026-04-28T13:00:00.000Z';
    const after = {
      ward_code: 'GE',
      ward_name: 'Greenwood Ward',
      lastActor: lastActor('alice@gmail.com'),
    };
    await auditWardWrites.run(
      makeEvent({ params: { stakeId: STAKE_ID, wardId: 'GE' }, before: null, after, time }),
    );
    const { db } = requireEmulators();
    const snap = await db.collection(`stakes/${STAKE_ID}/auditLog`).get();
    expect(snap.size).toBe(1);
    const doc = snap.docs[0]!;
    expect(doc.id).toBe(doc.data()['audit_id']);
    expect(doc.id.startsWith(time)).toBe(true);
  });

  // -------- emitAuditRow direct: covers the helper without a wrapper --------

  it('emitAuditRow handles missing lastActor with actor=unknown', async () => {
    await emitAuditRow({
      stakeId: STAKE_ID,
      collection: 'wards',
      docId: 'GE',
      entityType: 'stake',
      entityIdOverride: 'ward:GE',
      before: null,
      after: { ward_code: 'GE', ward_name: 'Greenwood Ward' },
      eventTime: '2026-04-28T14:00:00.000Z',
    });
    const rows = await readAuditRows();
    expect(rows[0]!.actor_email).toBe('unknown');
    expect(rows[0]!.actor_canonical).toBe('unknown');
  });

  it('access-doc write with lastActor=Importer produces actor_canonical=Importer', async () => {
    const after = {
      member_canonical: 'a@gmail.com',
      member_email: 'a@gmail.com',
      member_name: 'Alice',
      importer_callings: { CO: ['Bishop'] },
      manual_grants: {},
      lastActor: { email: 'Importer', canonical: 'Importer' },
    };
    await auditAccessWrites.run(
      makeEvent({
        params: { stakeId: STAKE_ID, memberCanonical: 'a@gmail.com' },
        before: null,
        after,
      }),
    );
    const rows = await readAuditRows();
    expect(rows[0]!.actor_canonical).toBe('Importer');
    expect(rows[0]!.action).toBe('create_access');
  });

  it('emitAuditRow stamps a ttl ~365 days after the event time', async () => {
    const eventTime = '2026-04-28T15:00:00.000Z';
    await emitAuditRow({
      stakeId: STAKE_ID,
      collection: 'wards',
      docId: 'GE',
      entityType: 'stake',
      entityIdOverride: 'ward:GE',
      before: null,
      after: { ward_code: 'GE', lastActor: lastActor('a@gmail.com') },
      eventTime,
    });
    const rows = await readAuditRows();
    const ttl = rows[0]!.ttl as { toMillis: () => number };
    const expected = new Date(eventTime).getTime() + 365 * 24 * 60 * 60 * 1000;
    expect(ttl.toMillis()).toBe(expected);
  });
});

// ---------- helpers ----------

type AuditRow = Record<string, unknown> & {
  audit_id: string;
  /** Sentinel — `audit_id` is on the row; `audit_id_doc` is the doc id we read back. */
  audit_id_doc: string;
  action: string;
  entity_type: string;
  entity_id: string;
  member_canonical?: string;
  before: unknown;
  after: unknown;
  actor_email: string;
  actor_canonical: string;
};

async function readAuditRows(): Promise<AuditRow[]> {
  const { db } = requireEmulators();
  const snap = await db.collection(`stakes/${STAKE_ID}/auditLog`).orderBy('audit_id').get();
  return snap.docs.map((d) => ({
    ...(d.data() as Record<string, unknown>),
    audit_id_doc: d.id,
  })) as AuditRow[];
}

async function clearAuditRows(): Promise<void> {
  const { db } = requireEmulators();
  await db.recursiveDelete(db.collection(`stakes/${STAKE_ID}/auditLog`));
}
