// Integration tests for the remove-seat-on-request-complete trigger.
// This is the Admin SDK seat-reconciliation that the client tx cannot
// do cleanly because Firestore rules' `delete` operations do not have
// access to incoming data.
//
// Scope-aware behaviour (B-10): the trigger walks the seat's grants
// and either deletes the seat (primary-only), promotes a duplicate to
// primary (primary remove with duplicates), or splices out a single
// duplicate entry (duplicate remove). The trigger also recomputes
// `stake.last_over_caps_json` inside the same transaction so a
// shrink that resolves an over-cap clears it (and `notifyOnOverCap`
// stays in sync).

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { DuplicateGrant, OverCapEntry, Seat } from '@kindoo/shared';
import { removeSeatOnRequestComplete } from '../src/triggers/removeSeatOnRequestComplete.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const STAKE_ID = 'csnorth';

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

async function seedSeat(opts: {
  canonical?: string;
  scope?: string;
  type?: Seat['type'];
  reason?: string;
  building_names?: string[];
  duplicate_grants?: DuplicateGrant[];
  start_date?: string;
  end_date?: string;
  granted_by_request?: string;
}): Promise<void> {
  const { db } = requireEmulators();
  const canonical = opts.canonical ?? 'alice@gmail.com';
  const body: Record<string, unknown> = {
    member_canonical: canonical,
    member_email: canonical,
    member_name: 'Alice',
    scope: opts.scope ?? 'CO',
    type: opts.type ?? 'manual',
    callings: [],
    reason: opts.reason ?? 'helper',
    building_names: opts.building_names ?? ['Cordera Building'],
    duplicate_grants: opts.duplicate_grants ?? [],
    granted_by_request: opts.granted_by_request ?? 'r-original',
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    last_modified_by: { email: 'mgr@gmail.com', canonical: 'mgr@gmail.com' },
    lastActor: { email: 'mgr@gmail.com', canonical: 'mgr@gmail.com' },
  };
  if (opts.start_date) body.start_date = opts.start_date;
  if (opts.end_date) body.end_date = opts.end_date;
  await db.doc(`stakes/${STAKE_ID}/seats/${canonical}`).set(body);
}

async function seedStake(
  opts: { overCaps?: OverCapEntry[]; stake_seat_cap?: number } = {},
): Promise<void> {
  const { db } = requireEmulators();
  const body: Record<string, unknown> = {
    last_over_caps_json: opts.overCaps ?? [],
  };
  if (opts.stake_seat_cap !== undefined) body.stake_seat_cap = opts.stake_seat_cap;
  await db.doc(`stakes/${STAKE_ID}`).set(body, { merge: true });
}

async function seedWard(opts: {
  ward_code: string;
  building_name?: string;
  seat_cap?: number;
  kindoo_site_id?: string | null;
}): Promise<void> {
  const { db } = requireEmulators();
  const doc: Record<string, unknown> = {
    ward_code: opts.ward_code,
    ward_name: `${opts.ward_code} Ward`,
    building_name: opts.building_name ?? `${opts.ward_code} Building`,
    seat_cap: opts.seat_cap ?? 0,
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    lastActor: { email: 'admin@gmail.com', canonical: 'admin@gmail.com' },
  };
  if (opts.kindoo_site_id !== undefined) doc.kindoo_site_id = opts.kindoo_site_id;
  await db.doc(`stakes/${STAKE_ID}/wards/${opts.ward_code}`).set(doc);
}

function removeEvent(opts: {
  requestId?: string;
  scope: string;
  member?: string;
}): ReturnType<typeof makeEvent> {
  const requestId = opts.requestId ?? 'r1';
  const member = opts.member ?? 'alice@gmail.com';
  return makeEvent({
    params: { stakeId: STAKE_ID, requestId },
    before: {
      status: 'pending',
      type: 'remove',
      scope: opts.scope,
      member_canonical: member,
      seat_member_canonical: member,
      request_id: requestId,
    },
    after: {
      status: 'complete',
      type: 'remove',
      scope: opts.scope,
      member_canonical: member,
      seat_member_canonical: member,
      request_id: requestId,
    },
  });
}

describe.skipIf(!hasEmulators())('removeSeatOnRequestComplete', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  it('deletes the seat when a primary-only remove fires (legacy)', async () => {
    await seedStake();
    await seedSeat({ scope: 'CO', duplicate_grants: [] });
    await removeSeatOnRequestComplete.run(removeEvent({ scope: 'CO' }));
    const { db } = requireEmulators();
    const seat = await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get();
    expect(seat.exists).toBe(false);
  });

  it('no-op when seat is already gone (R-1 race)', async () => {
    await seedStake();
    await removeSeatOnRequestComplete.run(removeEvent({ scope: 'CO' }));
    // Should not throw; nothing else to assert.
  });

  it('skips non-remove types', async () => {
    await seedSeat({});
    await removeSeatOnRequestComplete.run(
      makeEvent({
        params: { stakeId: STAKE_ID, requestId: 'r1' },
        before: { status: 'pending', type: 'add_manual', member_canonical: 'alice@gmail.com' },
        after: { status: 'complete', type: 'add_manual', member_canonical: 'alice@gmail.com' },
      }),
    );
    const { db } = requireEmulators();
    const seat = await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get();
    expect(seat.exists).toBe(true);
  });

  it('skips when request was already complete (re-fire)', async () => {
    await seedSeat({});
    await removeSeatOnRequestComplete.run(
      makeEvent({
        params: { stakeId: STAKE_ID, requestId: 'r1' },
        before: {
          status: 'complete',
          type: 'remove',
          scope: 'CO',
          member_canonical: 'alice@gmail.com',
          seat_member_canonical: 'alice@gmail.com',
        },
        after: {
          status: 'complete',
          type: 'remove',
          scope: 'CO',
          member_canonical: 'alice@gmail.com',
          seat_member_canonical: 'alice@gmail.com',
        },
      }),
    );
    const { db } = requireEmulators();
    const seat = await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get();
    expect(seat.exists).toBe(true);
  });

  describe('scope-aware multi-grant handling (B-10)', () => {
    it('primary remove with one duplicate: promotes the duplicate to primary', async () => {
      await seedStake();
      await seedSeat({
        scope: 'PC',
        type: 'manual',
        building_names: ['PC Building'],
        reason: 'pc-helper',
        duplicate_grants: [
          {
            scope: 'MO',
            type: 'manual',
            reason: 'mo-helper',
            building_names: ['MO Building'],
            detected_at: Timestamp.now(),
          },
        ],
      });
      await removeSeatOnRequestComplete.run(removeEvent({ scope: 'PC' }));

      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(seat.scope).toBe('MO');
      expect(seat.type).toBe('manual');
      expect(seat.building_names).toEqual(['MO Building']);
      expect(seat.reason).toBe('mo-helper');
      expect(seat.duplicate_grants).toEqual([]);
      // granted_by_request cleared on promotion.
      expect(seat.granted_by_request ?? null).toBeNull();
      // RemoveTrigger stamped.
      expect(seat.lastActor).toEqual({ email: 'RemoveTrigger', canonical: 'RemoveTrigger' });
    });

    it('primary remove with multiple duplicates: first duplicate promotes; remaining stay', async () => {
      await seedStake();
      await seedSeat({
        scope: 'PC',
        type: 'manual',
        duplicate_grants: [
          {
            scope: 'MO',
            type: 'manual',
            reason: 'mo-helper',
            building_names: ['MO Building'],
            detected_at: Timestamp.now(),
          },
          {
            scope: 'ST',
            type: 'temp',
            reason: 'st-helper',
            building_names: ['ST Building'],
            start_date: '2026-06-01',
            end_date: '2026-06-30',
            detected_at: Timestamp.now(),
          },
        ],
      });
      await removeSeatOnRequestComplete.run(removeEvent({ scope: 'PC' }));

      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(seat.scope).toBe('MO');
      expect(seat.type).toBe('manual');
      expect(seat.duplicate_grants).toHaveLength(1);
      expect(seat.duplicate_grants[0]!.scope).toBe('ST');
      expect(seat.duplicate_grants[0]!.type).toBe('temp');
    });

    it('duplicate remove: splices that entry out; primary unchanged', async () => {
      await seedStake();
      await seedSeat({
        scope: 'PC',
        type: 'manual',
        building_names: ['PC Building'],
        reason: 'pc-helper',
        duplicate_grants: [
          {
            scope: 'MO',
            type: 'manual',
            building_names: ['MO Building'],
            detected_at: Timestamp.now(),
          },
          {
            scope: 'ST',
            type: 'temp',
            building_names: ['ST Building'],
            detected_at: Timestamp.now(),
          },
        ],
      });
      await removeSeatOnRequestComplete.run(removeEvent({ scope: 'MO' }));

      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(seat.scope).toBe('PC');
      expect(seat.type).toBe('manual');
      expect(seat.building_names).toEqual(['PC Building']);
      expect(seat.duplicate_grants).toHaveLength(1);
      expect(seat.duplicate_grants[0]!.scope).toBe('ST');
    });

    it('duplicate remove (last duplicate): primary stays, duplicates empty; seat NOT deleted', async () => {
      await seedStake();
      await seedSeat({
        scope: 'PC',
        type: 'manual',
        duplicate_grants: [
          {
            scope: 'MO',
            type: 'manual',
            building_names: ['MO Building'],
            detected_at: Timestamp.now(),
          },
        ],
      });
      await removeSeatOnRequestComplete.run(removeEvent({ scope: 'MO' }));

      const { db } = requireEmulators();
      const seatSnap = await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get();
      expect(seatSnap.exists).toBe(true);
      const seat = seatSnap.data() as Seat;
      expect(seat.scope).toBe('PC');
      expect(seat.duplicate_grants).toEqual([]);
    });

    it('T-42 / T-43: promote write keeps duplicate_scopes in sync with the post-write duplicate_grants', async () => {
      await seedStake();
      await seedSeat({
        scope: 'PC',
        type: 'manual',
        duplicate_grants: [
          {
            scope: 'MO',
            type: 'manual',
            reason: 'mo-helper',
            building_names: ['MO Building'],
            detected_at: Timestamp.now(),
          },
          {
            scope: 'ST',
            type: 'temp',
            reason: 'st-helper',
            building_names: ['ST Building'],
            detected_at: Timestamp.now(),
          },
        ],
      });
      await removeSeatOnRequestComplete.run(removeEvent({ scope: 'PC' }));

      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      // Primary promoted from MO; one duplicate (ST) survives.
      expect(seat.scope).toBe('MO');
      expect(seat.duplicate_grants.map((d) => d.scope)).toEqual(['ST']);
      // Mirror lands on the same value.
      expect(seat.duplicate_scopes).toEqual(['ST']);
    });

    it('T-42 / T-43: drop_duplicate write keeps duplicate_scopes in sync', async () => {
      await seedStake();
      await seedSeat({
        scope: 'PC',
        type: 'manual',
        duplicate_grants: [
          {
            scope: 'MO',
            type: 'manual',
            building_names: ['MO Building'],
            detected_at: Timestamp.now(),
          },
          {
            scope: 'ST',
            type: 'temp',
            building_names: ['ST Building'],
            detected_at: Timestamp.now(),
          },
        ],
      });
      await removeSeatOnRequestComplete.run(removeEvent({ scope: 'MO' }));

      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      // Primary still PC; only ST duplicate remains.
      expect(seat.scope).toBe('PC');
      expect(seat.duplicate_grants.map((d) => d.scope)).toEqual(['ST']);
      expect(seat.duplicate_scopes).toEqual(['ST']);
    });

    it('stale request mismatch (scope on neither primary nor any duplicate): seat unchanged', async () => {
      await seedStake();
      await seedSeat({ scope: 'PC', type: 'manual', duplicate_grants: [] });
      await removeSeatOnRequestComplete.run(removeEvent({ scope: 'MO' }));

      const { db } = requireEmulators();
      const seatSnap = await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get();
      expect(seatSnap.exists).toBe(true);
      const seat = seatSnap.data() as Seat;
      expect(seat.scope).toBe('PC');
      // No write happened — lastActor remains the seed value.
      expect(seat.lastActor).toEqual({ email: 'mgr@gmail.com', canonical: 'mgr@gmail.com' });
    });

    it('type promotion: temp duplicate promotes onto manual primary → seat type becomes temp', async () => {
      await seedStake();
      await seedSeat({
        scope: 'stake',
        type: 'manual',
        reason: 'pc-helper',
        building_names: ['Cordera Building'],
        duplicate_grants: [
          {
            scope: 'stake',
            type: 'temp',
            reason: 'temp-helper',
            building_names: ['Briargate Building'],
            start_date: '2026-06-01',
            end_date: '2026-06-30',
            detected_at: Timestamp.now(),
          },
        ],
      });
      await removeSeatOnRequestComplete.run(removeEvent({ scope: 'stake' }));

      const { db } = requireEmulators();
      const seat = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(seat.scope).toBe('stake');
      expect(seat.type).toBe('temp');
      expect(seat.reason).toBe('temp-helper');
      expect(seat.building_names).toEqual(['Briargate Building']);
      expect(seat.start_date).toBe('2026-06-01');
      expect(seat.end_date).toBe('2026-06-30');
      expect(seat.duplicate_grants).toEqual([]);
    });
  });

  describe('cap recompute', () => {
    it('clears an over-cap pool when the removed seat takes it back under cap', async () => {
      // Seed: PC ward has seat_cap=1 and 2 PC seats → over-cap by 1.
      // Remove one PC seat → post-write seat set has 1 PC seat → cap
      // cleared. last_over_caps_json should write to [].
      await seedStake({
        overCaps: [{ pool: 'PC', count: 2, cap: 1, over_by: 1 }],
        stake_seat_cap: 0,
      });
      await seedWard({ ward_code: 'PC', seat_cap: 1 });
      await seedSeat({ canonical: 'alice@gmail.com', scope: 'PC' });
      await seedSeat({ canonical: 'bob@gmail.com', scope: 'PC' });

      await removeSeatOnRequestComplete.run(
        removeEvent({ scope: 'PC', member: 'alice@gmail.com' }),
      );

      const { db } = requireEmulators();
      const stake = (await db.doc(`stakes/${STAKE_ID}`).get()).data() ?? {};
      expect((stake as { last_over_caps_json: OverCapEntry[] }).last_over_caps_json).toEqual([]);
      // alice's seat deleted; bob remains.
      const alice = await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get();
      expect(alice.exists).toBe(false);
      const bob = await db.doc(`stakes/${STAKE_ID}/seats/bob@gmail.com`).get();
      expect(bob.exists).toBe(true);
    });

    it('foreign-site ward seats are excluded from the home stake portion on remove recompute', async () => {
      // stake_seat_cap=2 with 1 stake-scope seat and 5 foreign FN seats.
      // Pre-state: portion-cap = 2 (FN excluded); stake count = 1 →
      // under cap. Removing a foreign seat must NOT inflate the home
      // portion-cap or otherwise touch the home stake calc.
      await seedStake({ overCaps: [], stake_seat_cap: 2 });
      await seedWard({
        ward_code: 'FN',
        seat_cap: 50,
        kindoo_site_id: 'east-stake',
        building_name: 'Foreign Building',
      });
      await seedSeat({ canonical: 'sally@gmail.com', scope: 'stake' });
      for (let i = 0; i < 5; i++) {
        await seedSeat({ canonical: `f${i}@gmail.com`, scope: 'FN' });
      }

      await removeSeatOnRequestComplete.run(removeEvent({ scope: 'FN', member: 'f0@gmail.com' }));

      const { db } = requireEmulators();
      const stake = (await db.doc(`stakes/${STAKE_ID}`).get()).data() ?? {};
      // No over-cap on home stake portion (FN seats excluded from
      // both sides) and FN at 4 < cap 50 → empty.
      expect((stake as { last_over_caps_json: OverCapEntry[] }).last_over_caps_json).toEqual([]);
    });

    it('shifts pool counts on a primary-promotion remove (PC → MO)', async () => {
      // Seed: PC cap=2 with 2 seats (alice's PC primary + bob's PC),
      // MO cap=1 with 0 MO seats. Alice also has an MO duplicate.
      // Remove alice's PC primary → MO duplicate promotes. Post-write:
      // PC has 1 seat (bob); MO has 1 seat (alice promoted). Neither
      // pool exceeds cap; over-caps array empty.
      await seedStake({ overCaps: [], stake_seat_cap: 0 });
      await seedWard({ ward_code: 'PC', seat_cap: 2 });
      await seedWard({ ward_code: 'MO', seat_cap: 1 });
      await seedSeat({
        canonical: 'alice@gmail.com',
        scope: 'PC',
        type: 'manual',
        building_names: ['PC Building'],
        duplicate_grants: [
          {
            scope: 'MO',
            type: 'manual',
            building_names: ['MO Building'],
            detected_at: Timestamp.now(),
          },
        ],
      });
      await seedSeat({ canonical: 'bob@gmail.com', scope: 'PC' });

      await removeSeatOnRequestComplete.run(
        removeEvent({ scope: 'PC', member: 'alice@gmail.com' }),
      );

      const { db } = requireEmulators();
      const alice = (await db.doc(`stakes/${STAKE_ID}/seats/alice@gmail.com`).get()).data() as Seat;
      expect(alice.scope).toBe('MO');
      const stake = (await db.doc(`stakes/${STAKE_ID}`).get()).data() ?? {};
      expect((stake as { last_over_caps_json: OverCapEntry[] }).last_over_caps_json).toEqual([]);
    });
  });
});
