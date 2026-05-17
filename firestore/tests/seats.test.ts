// Rules tests for `stakes/{stakeId}/seats/{memberCanonical}` per
// `firebase-schema.md` §4.6.
//
// This file exercises the most architecturally interesting rule in
// the schema: the `tiedToRequestCompletion` cross-doc invariant
// (uses `getAfter()`). A seat may only be created when the request
// that justifies it transitions pending → complete in the same
// write — proven via a `WriteBatch` that updates the request doc
// AND creates the seat doc atomically.
//
// Reads cover the per-scope visibility split (managers see all;
// stake members see stake-scope only; bishopric sees their wards).
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  bishopricContext,
  clearAll,
  lastActorOf,
  managerContext,
  outsiderContext,
  personas,
  seedAsAdmin,
  setupTestEnv,
  stakeMemberContext,
  unauthedContext,
} from './lib/rules.js';

const STAKE_ID = 'csnorth';
const TARGET_CANONICAL = 'alice@gmail.com';
const SEAT_PATH = `stakes/${STAKE_ID}/seats/${TARGET_CANONICAL}`;

const REQUEST_ID_MANUAL = 'req-manual-1';
const REQUEST_ID_TEMP = 'req-temp-1';
const REQUEST_PATH_MANUAL = `stakes/${STAKE_ID}/requests/${REQUEST_ID_MANUAL}`;
const REQUEST_PATH_TEMP = `stakes/${STAKE_ID}/requests/${REQUEST_ID_TEMP}`;

function manualSeatDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    member_canonical: TARGET_CANONICAL,
    member_email: 'Alice@gmail.com',
    member_name: 'Alice Smith',
    scope: 'stake',
    type: 'manual',
    callings: [],
    reason: 'Visiting authority',
    building_names: ['Cordera Building'],
    granted_by_request: REQUEST_ID_MANUAL,
    duplicate_grants: [],
    created_at: new Date(),
    last_modified_at: new Date(),
    last_modified_by: lastActorOf(personas.manager),
    lastActor: lastActorOf(personas.manager),
    ...overrides,
  };
}

function tempSeatDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return manualSeatDoc({
    type: 'temp',
    reason: 'Visiting speaker',
    start_date: '2026-05-01',
    end_date: '2026-05-08',
    granted_by_request: REQUEST_ID_TEMP,
    ...overrides,
  });
}

function pendingRequestDoc(
  type: 'add_manual' | 'add_temp',
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    request_id: type === 'add_manual' ? REQUEST_ID_MANUAL : REQUEST_ID_TEMP,
    type,
    scope: 'stake',
    member_email: 'Alice@gmail.com',
    member_canonical: TARGET_CANONICAL,
    member_name: 'Alice Smith',
    reason: type === 'add_temp' ? 'Visiting speaker' : 'Visiting authority',
    comment: '',
    building_names: ['Cordera Building'],
    status: 'pending',
    requester_email: 'StakeUser@gmail.com',
    requester_canonical: 'stakeuser@gmail.com',
    requested_at: new Date(),
    lastActor: lastActorOf(personas.stakeMember),
    ...(type === 'add_temp' ? { start_date: '2026-05-01', end_date: '2026-05-08' } : {}),
    ...overrides,
  };
}

describe('firestore.rules — stakes/{sid}/seats/{canonical}', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('seats');
  });

  afterEach(async () => {
    await clearAll(env);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  describe('read', () => {
    it('manager can read any seat', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(SEAT_PATH)
          .set(manualSeatDoc({ scope: '01' }));
      });
      await assertSucceeds(managerContext(env, STAKE_ID).firestore().doc(SEAT_PATH).get());
    });

    it('stake-scope member can read stake-scope seat', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(SEAT_PATH)
          .set(manualSeatDoc({ scope: 'stake' }));
      });
      await assertSucceeds(stakeMemberContext(env, STAKE_ID).firestore().doc(SEAT_PATH).get());
    });

    // Stake-level access grants oversight of every ward roster — a stake
    // user clicking any ward on the Ward Rosters page must succeed even
    // for wards outside any bishopric claim they may also hold.
    it('stake-scope member can read a ward-scope seat (any ward)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(SEAT_PATH)
          .set(manualSeatDoc({ scope: '01' }));
      });
      await assertSucceeds(stakeMemberContext(env, STAKE_ID).firestore().doc(SEAT_PATH).get());
    });

    it("bishopric reads own ward's seats", async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(SEAT_PATH)
          .set(manualSeatDoc({ scope: '01' }));
      });
      await assertSucceeds(
        bishopricContext(env, STAKE_ID, ['01']).firestore().doc(SEAT_PATH).get(),
      );
    });

    it("bishopric is denied another ward's seats", async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(SEAT_PATH)
          .set(manualSeatDoc({ scope: '02' }));
      });
      await assertFails(bishopricContext(env, STAKE_ID, ['01']).firestore().doc(SEAT_PATH).get());
    });

    it('outsider denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(SEAT_PATH)
          .set(manualSeatDoc({ scope: 'stake' }));
      });
      await assertFails(outsiderContext(env, STAKE_ID).firestore().doc(SEAT_PATH).get());
    });

    it('anonymous denied', async () => {
      await assertFails(unauthedContext(env).firestore().doc(SEAT_PATH).get());
    });

    it('cross-stake reads denied', async () => {
      const otherPath = `stakes/someother/seats/${TARGET_CANONICAL}`;
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(otherPath)
          .set(manualSeatDoc({ scope: 'stake' }));
      });
      await assertFails(managerContext(env, STAKE_ID).firestore().doc(otherPath).get());
    });

    // T-43 Phase B AC #10 — bishopric reads widen to cover seats whose
    // any-grant scope matches their ward via `duplicate_scopes`.
    it('bishopric reads a seat whose primary is in another scope but duplicate_scopes includes their ward (Phase B)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(SEAT_PATH)
          .set(
            manualSeatDoc({
              scope: 'stake',
              duplicate_grants: [
                {
                  scope: '01',
                  type: 'manual',
                  detected_at: new Date(),
                },
              ],
              duplicate_scopes: ['01'],
            }),
          );
      });
      await assertSucceeds(
        bishopricContext(env, STAKE_ID, ['01']).firestore().doc(SEAT_PATH).get(),
      );
    });

    it('bishopric is denied a seat whose primary AND duplicate_scopes are outside their ward (Phase B negative)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(SEAT_PATH)
          .set(
            manualSeatDoc({
              scope: 'stake',
              duplicate_grants: [
                {
                  scope: '02',
                  type: 'manual',
                  detected_at: new Date(),
                },
              ],
              duplicate_scopes: ['02'],
            }),
          );
      });
      await assertFails(bishopricContext(env, STAKE_ID, ['01']).firestore().doc(SEAT_PATH).get());
    });

    it("outsider still denied even when duplicate_scopes overlaps the outsider's (non-)wards (Phase B negative)", async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(SEAT_PATH)
          .set(
            manualSeatDoc({
              scope: 'stake',
              duplicate_grants: [
                {
                  scope: '01',
                  type: 'manual',
                  detected_at: new Date(),
                },
              ],
              duplicate_scopes: ['01'],
            }),
          );
      });
      await assertFails(outsiderContext(env, STAKE_ID).firestore().doc(SEAT_PATH).get());
    });

    it('legacy seats without duplicate_scopes do not break bishopric reads (presence guard)', async () => {
      // Legacy seat written before the T-42 migration: no
      // `duplicate_scopes` field. The presence guard
      // (`'duplicate_scopes' in resource.data`) prevents the
      // `hasAny(...)` clause from throwing on the missing field.
      // A bishopric whose ward matches the primary still succeeds;
      // a bishopric whose ward doesn't match still fails (rather than
      // erroring out the entire read).
      await seedAsAdmin(env, async (ctx) => {
        // Explicit absence of `duplicate_scopes` (the default fixture
        // includes it; build a doc without it).
        const doc = manualSeatDoc({ scope: '01' });
        delete (doc as Record<string, unknown>)['duplicate_scopes'];
        await ctx.firestore().doc(SEAT_PATH).set(doc);
      });
      await assertSucceeds(
        bishopricContext(env, STAKE_ID, ['01']).firestore().doc(SEAT_PATH).get(),
      );
      await assertFails(bishopricContext(env, STAKE_ID, ['02']).firestore().doc(SEAT_PATH).get());
    });
  });

  describe('create — `tiedToRequestCompletion` cross-doc invariant', () => {
    it('manager creates manual seat in same batch as request flipping pending → complete → ok', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(REQUEST_PATH_MANUAL).set(pendingRequestDoc('add_manual'));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      const batch = db.batch();
      batch.set(db.doc(SEAT_PATH), manualSeatDoc());
      batch.update(db.doc(REQUEST_PATH_MANUAL), {
        status: 'complete',
        completer_email: personas.manager.email,
        completer_canonical: personas.manager.canonical,
        completed_at: new Date(),
        lastActor: lastActorOf(personas.manager),
      });
      await assertSucceeds(batch.commit());
    });

    it('manager creates temp seat in same batch as request flipping pending → complete → ok', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(REQUEST_PATH_TEMP).set(pendingRequestDoc('add_temp'));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      const batch = db.batch();
      batch.set(db.doc(SEAT_PATH), tempSeatDoc());
      batch.update(db.doc(REQUEST_PATH_TEMP), {
        status: 'complete',
        completer_email: personas.manager.email,
        completer_canonical: personas.manager.canonical,
        completed_at: new Date(),
        lastActor: lastActorOf(personas.manager),
      });
      await assertSucceeds(batch.commit());
    });

    it('seat-only create (no request transition) → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(REQUEST_PATH_MANUAL).set(pendingRequestDoc('add_manual'));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(SEAT_PATH).set(manualSeatDoc()));
    });

    it('seat scope does not match request scope → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(REQUEST_PATH_MANUAL)
          .set(pendingRequestDoc('add_manual', { scope: '01' }));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      const batch = db.batch();
      batch.set(db.doc(SEAT_PATH), manualSeatDoc({ scope: 'stake' }));
      batch.update(db.doc(REQUEST_PATH_MANUAL), {
        status: 'complete',
        completer_email: personas.manager.email,
        completer_canonical: personas.manager.canonical,
        completed_at: new Date(),
        lastActor: lastActorOf(personas.manager),
      });
      await assertFails(batch.commit());
    });

    it('seat type does not match request type (add_manual but type=temp) → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(REQUEST_PATH_MANUAL).set(pendingRequestDoc('add_manual'));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      const batch = db.batch();
      batch.set(db.doc(SEAT_PATH), tempSeatDoc({ granted_by_request: REQUEST_ID_MANUAL }));
      batch.update(db.doc(REQUEST_PATH_MANUAL), {
        status: 'complete',
        completer_email: personas.manager.email,
        completer_canonical: personas.manager.canonical,
        completed_at: new Date(),
        lastActor: lastActorOf(personas.manager),
      });
      await assertFails(batch.commit());
    });

    it('seat type=auto → denied (auto seats are server-only)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(REQUEST_PATH_MANUAL).set(pendingRequestDoc('add_manual'));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      const batch = db.batch();
      batch.set(db.doc(SEAT_PATH), manualSeatDoc({ type: 'auto', callings: ['Bishop'] }));
      batch.update(db.doc(REQUEST_PATH_MANUAL), {
        status: 'complete',
        completer_email: personas.manager.email,
        completer_canonical: personas.manager.canonical,
        completed_at: new Date(),
        lastActor: lastActorOf(personas.manager),
      });
      await assertFails(batch.commit());
    });

    it('seat with non-empty callings (manual/temp must have callings=[]) → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(REQUEST_PATH_MANUAL).set(pendingRequestDoc('add_manual'));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      const batch = db.batch();
      batch.set(db.doc(SEAT_PATH), manualSeatDoc({ callings: ['Bishop'] }));
      batch.update(db.doc(REQUEST_PATH_MANUAL), {
        status: 'complete',
        completer_email: personas.manager.email,
        completer_canonical: personas.manager.canonical,
        completed_at: new Date(),
        lastActor: lastActorOf(personas.manager),
      });
      await assertFails(batch.commit());
    });

    it('seat doc-id ≠ member_canonical → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(REQUEST_PATH_MANUAL)
          .set(pendingRequestDoc('add_manual', { member_canonical: 'bob@gmail.com' }));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      const batch = db.batch();
      // Seat at alice path but doc data says member_canonical=bob.
      batch.set(db.doc(SEAT_PATH), manualSeatDoc({ member_canonical: 'bob@gmail.com' }));
      batch.update(db.doc(REQUEST_PATH_MANUAL), {
        status: 'complete',
        completer_email: personas.manager.email,
        completer_canonical: personas.manager.canonical,
        completed_at: new Date(),
        lastActor: lastActorOf(personas.manager),
      });
      await assertFails(batch.commit());
    });

    it('non-manager cannot create even via batch', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(REQUEST_PATH_MANUAL).set(pendingRequestDoc('add_manual'));
      });
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      const batch = db.batch();
      batch.set(db.doc(SEAT_PATH), manualSeatDoc({ lastActor: lastActorOf(personas.stakeMember) }));
      batch.update(db.doc(REQUEST_PATH_MANUAL), {
        status: 'complete',
        completer_email: personas.stakeMember.email,
        completer_canonical: personas.stakeMember.canonical,
        completed_at: new Date(),
        lastActor: lastActorOf(personas.stakeMember),
      });
      await assertFails(batch.commit());
    });

    // T-42 / T-43: `duplicate_scopes` is a server-maintained primitive
    // mirror of `duplicate_grants[].scope`. Clients may only create a
    // seat with the field empty (consistent with `duplicate_grants ==
    // []`). A non-empty client-set value is rejected.
    it('client-create with empty duplicate_scopes is allowed', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(REQUEST_PATH_MANUAL).set(pendingRequestDoc('add_manual'));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      const batch = db.batch();
      batch.set(db.doc(SEAT_PATH), manualSeatDoc({ duplicate_scopes: [] }));
      batch.update(db.doc(REQUEST_PATH_MANUAL), {
        status: 'complete',
        completer_email: personas.manager.email,
        completer_canonical: personas.manager.canonical,
        completed_at: new Date(),
        lastActor: lastActorOf(personas.manager),
      });
      await assertSucceeds(batch.commit());
    });

    it('client-create with non-empty duplicate_scopes is rejected (server-maintained field)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(REQUEST_PATH_MANUAL).set(pendingRequestDoc('add_manual'));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      const batch = db.batch();
      batch.set(db.doc(SEAT_PATH), manualSeatDoc({ duplicate_scopes: ['CO'] }));
      batch.update(db.doc(REQUEST_PATH_MANUAL), {
        status: 'complete',
        completer_email: personas.manager.email,
        completer_canonical: personas.manager.canonical,
        completed_at: new Date(),
        lastActor: lastActorOf(personas.manager),
      });
      await assertFails(batch.commit());
    });

    it('admin SDK seat write with non-empty duplicate_scopes is accepted (server-only path)', async () => {
      // The Admin SDK bypasses rules entirely; this is a positive
      // assertion of the contract that server writers populate the
      // mirror. The rules-tests `seedAsAdmin` helper uses the same
      // bypass, so the assertion is the operation succeeds with the
      // field set non-empty.
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(REQUEST_PATH_MANUAL).set(pendingRequestDoc('add_manual'));
        await ctx
          .firestore()
          .doc(SEAT_PATH)
          .set(
            manualSeatDoc({
              duplicate_grants: [
                {
                  scope: 'CO',
                  type: 'manual',
                  callings: [],
                  building_names: ['Cordera Building'],
                  detected_at: new Date(),
                },
              ],
              duplicate_scopes: ['CO'],
            }),
          );
      });
      // No assertFails here — admin writes bypass rules. The test
      // exists to document the contract and catch a regression where
      // the rules accidentally start applying to admin writes (which
      // would be the catastrophic case).
    });
  });

  describe('update', () => {
    it('manager updates allowlisted fields → ok', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(SEAT_PATH).set(manualSeatDoc());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(SEAT_PATH).update({
          member_name: 'Alice Updated',
          reason: 'Updated reason',
          building_names: ['Pikes Peak Building'],
          last_modified_at: new Date(),
          last_modified_by: lastActorOf(personas.manager),
          lastActor: lastActorOf(personas.manager),
        }),
      );
    });

    it('manager mutates immutable scope → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(SEAT_PATH).set(manualSeatDoc());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(SEAT_PATH).update({
          scope: '01',
          last_modified_at: new Date(),
          lastActor: lastActorOf(personas.manager),
        }),
      );
    });

    it('manager mutates immutable type → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(SEAT_PATH).set(manualSeatDoc());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(SEAT_PATH).update({
          type: 'temp',
          last_modified_at: new Date(),
          lastActor: lastActorOf(personas.manager),
        }),
      );
    });

    it('manager mutates immutable member_canonical → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(SEAT_PATH).set(manualSeatDoc());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(SEAT_PATH).update({
          member_canonical: 'bob@gmail.com',
          last_modified_at: new Date(),
          lastActor: lastActorOf(personas.manager),
        }),
      );
    });

    it('manager update with bad lastActor → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(SEAT_PATH).set(manualSeatDoc());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(SEAT_PATH).update({
          member_name: 'X',
          last_modified_at: new Date(),
          lastActor: { email: 'X@x.com', canonical: 'y@x.com' },
        }),
      );
    });

    it('manager updates an auto seat → denied (only manual/temp updatable)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(SEAT_PATH)
          .set(manualSeatDoc({ type: 'auto', callings: ['Bishop'] }));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(SEAT_PATH).update({
          member_name: 'X',
          last_modified_at: new Date(),
          lastActor: lastActorOf(personas.manager),
        }),
      );
    });

    it('non-manager update is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(SEAT_PATH).set(manualSeatDoc());
      });
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(SEAT_PATH).update({
          member_name: 'X',
          lastActor: lastActorOf(personas.stakeMember),
        }),
      );
    });

    // T-43 reviewer fix: a client write that touches
    // `duplicate_grants` must also touch `duplicate_scopes` so the
    // server-maintained primitive mirror stays in lockstep. The rule
    // allows the coordinated pair (server writers do this); rejects
    // either field alone.
    it('client update mutating duplicate_grants without duplicate_scopes is denied (mirror coupling)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(SEAT_PATH)
          .set(manualSeatDoc({ duplicate_grants: [], duplicate_scopes: [] }));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(SEAT_PATH).update({
          duplicate_grants: [
            { scope: 'CO', type: 'manual', callings: [], detected_at: new Date() },
          ],
          last_modified_at: new Date(),
          last_modified_by: lastActorOf(personas.manager),
          lastActor: lastActorOf(personas.manager),
        }),
      );
    });

    it('client update mutating duplicate_scopes without duplicate_grants is denied (mirror coupling)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(SEAT_PATH)
          .set(manualSeatDoc({ duplicate_grants: [], duplicate_scopes: [] }));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(SEAT_PATH).update({
          duplicate_scopes: ['CO'],
          last_modified_at: new Date(),
          last_modified_by: lastActorOf(personas.manager),
          lastActor: lastActorOf(personas.manager),
        }),
      );
    });
  });

  describe('delete', () => {
    it('manager deletes a manual seat with no duplicates → ok', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(SEAT_PATH).set(manualSeatDoc());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(SEAT_PATH).delete());
    });

    it('manager cannot delete a seat with non-empty duplicate_grants', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(SEAT_PATH)
          .set(
            manualSeatDoc({
              duplicate_grants: [
                { scope: '01', type: 'auto', callings: ['Bishop'], detected_at: new Date() },
              ],
            }),
          );
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(SEAT_PATH).delete());
    });

    it('manager cannot delete an auto seat (auto seats deleted by importer/expiry only)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(SEAT_PATH)
          .set(manualSeatDoc({ type: 'auto', callings: ['Bishop'] }));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(SEAT_PATH).delete());
    });

    it('non-manager delete is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(SEAT_PATH).set(manualSeatDoc());
      });
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(SEAT_PATH).delete());
    });
  });
});
