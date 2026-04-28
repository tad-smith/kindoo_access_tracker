// Rules tests for `stakes/{stakeId}/requests/{requestId}` per
// `firebase-schema.md` §4.7. The request lifecycle is the busiest
// rule block in the file, with separate paths for submit, cancel,
// complete, and reject.
//
// `requested_at == request.time` invariant: tests use `serverTimestamp()`
// so the field's value is the same `request.time` the rules see.
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import {
  bishopricContext,
  clearAll,
  contextFor,
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
const REQUEST_ID = 'req-1';
const PATH = `stakes/${STAKE_ID}/requests/${REQUEST_ID}`;

/**
 * `serverTimestamp()` lets the rules' `request.time == requested_at`
 * check pass — both reduce to the same timestamp when the rules
 * engine evaluates the write.
 */
const SERVER_TIMESTAMP = () => firebase.firestore.FieldValue.serverTimestamp();

function pendingAddManualByStakeMember(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    request_id: REQUEST_ID,
    type: 'add_manual',
    scope: 'stake',
    member_email: 'Subject@gmail.com',
    member_canonical: 'subject@gmail.com',
    member_name: 'Subject Person',
    reason: 'Visiting authority',
    comment: '',
    building_names: ['Cordera Building'],
    status: 'pending',
    requester_email: personas.stakeMember.email,
    requester_canonical: personas.stakeMember.canonical,
    requested_at: SERVER_TIMESTAMP(),
    lastActor: lastActorOf(personas.stakeMember),
    ...overrides,
  };
}

function pendingAddTempByBishopric(
  wardCode: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    request_id: REQUEST_ID,
    type: 'add_temp',
    scope: wardCode,
    member_email: 'Subject@gmail.com',
    member_canonical: 'subject@gmail.com',
    member_name: 'Subject Person',
    reason: 'Visiting speaker',
    comment: '',
    start_date: '2026-05-01',
    end_date: '2026-05-08',
    building_names: [],
    status: 'pending',
    requester_email: personas.bishopric.email,
    requester_canonical: personas.bishopric.canonical,
    requested_at: SERVER_TIMESTAMP(),
    lastActor: lastActorOf(personas.bishopric),
    ...overrides,
  };
}

function pendingRemoveByBishopric(
  wardCode: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    request_id: REQUEST_ID,
    type: 'remove',
    scope: wardCode,
    member_email: 'Subject@gmail.com',
    member_canonical: 'subject@gmail.com',
    member_name: '',
    reason: 'No longer needed',
    comment: '',
    building_names: [],
    status: 'pending',
    requester_email: personas.bishopric.email,
    requester_canonical: personas.bishopric.canonical,
    requested_at: SERVER_TIMESTAMP(),
    seat_member_canonical: 'subject@gmail.com',
    lastActor: lastActorOf(personas.bishopric),
    ...overrides,
  };
}

describe('firestore.rules — stakes/{sid}/requests/{requestId}', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('requests');
  });

  afterEach(async () => {
    await clearAll(env);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  describe('read', () => {
    it('manager reads any request', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(pendingAddManualByStakeMember());
      });
      await assertSucceeds(managerContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('original requester reads own request', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(pendingAddManualByStakeMember());
      });
      await assertSucceeds(stakeMemberContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('stake-scope member reads any stake-scope request', async () => {
      // Different requester, but the request is stake-scope and the
      // reader is a stake-scope member — they can see it.
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(PATH)
          .set(
            pendingAddManualByStakeMember({
              requester_canonical: 'someoneelse@gmail.com',
              requester_email: 'SomeoneElse@gmail.com',
            }),
          );
      });
      await assertSucceeds(stakeMemberContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('bishopric reads ward-scope request for their ward', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(pendingAddTempByBishopric('01'));
      });
      await assertSucceeds(bishopricContext(env, STAKE_ID, ['01']).firestore().doc(PATH).get());
    });

    it("bishopric is denied another ward's request", async () => {
      // Override requester so the "requester reads own" branch
      // doesn't apply — we want to test the ward-scope branch alone.
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(PATH)
          .set(
            pendingAddTempByBishopric('02', {
              requester_email: 'OtherSubmitter@gmail.com',
              requester_canonical: 'othersubmitter@gmail.com',
            }),
          );
      });
      await assertFails(bishopricContext(env, STAKE_ID, ['01']).firestore().doc(PATH).get());
    });

    it("stake-scope member is denied a ward-scope request they didn't submit", async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(pendingAddTempByBishopric('01'));
      });
      await assertFails(stakeMemberContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('outsider denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(pendingAddManualByStakeMember());
      });
      await assertFails(outsiderContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('anonymous denied', async () => {
      await assertFails(unauthedContext(env).firestore().doc(PATH).get());
    });
  });

  describe('create — submit', () => {
    it('stake-scope add by stake-scope member with all fields → ok', async () => {
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(PATH).set(pendingAddManualByStakeMember()));
    });

    it('ward-scope add_temp by bishopric → ok', async () => {
      const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
      await assertSucceeds(db.doc(PATH).set(pendingAddTempByBishopric('01')));
    });

    it('ward-scope remove by bishopric → ok (member_name may be empty for remove)', async () => {
      const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
      await assertSucceeds(db.doc(PATH).set(pendingRemoveByBishopric('01')));
    });

    it('initial status not pending → denied', async () => {
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(PATH).set(pendingAddManualByStakeMember({ status: 'complete' })));
    });

    it('requester_canonical does not match auth canonical → denied', async () => {
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(
          pendingAddManualByStakeMember({
            requester_canonical: 'someoneelse@gmail.com',
          }),
        ),
      );
    });

    it('add type with empty member_name → denied', async () => {
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(PATH).set(pendingAddManualByStakeMember({ member_name: '' })));
    });

    it('stake-scope add with empty building_names → denied', async () => {
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(PATH).set(pendingAddManualByStakeMember({ building_names: [] })));
    });

    it('stake-scope submit by a non-stake-member → denied', async () => {
      // Bishopric only — not a stake-scope member — submitting stake-scope.
      const persona = personas.bishopric;
      const db = contextFor(env, persona, STAKE_ID, { wards: ['01'] }).firestore();
      await assertFails(
        db.doc(PATH).set(
          pendingAddManualByStakeMember({
            requester_email: persona.email,
            requester_canonical: persona.canonical,
            lastActor: lastActorOf(persona),
          }),
        ),
      );
    });

    it('ward-scope submit for a ward the user has no claim for → denied', async () => {
      const db = bishopricContext(env, STAKE_ID, ['02']).firestore();
      await assertFails(db.doc(PATH).set(pendingAddTempByBishopric('01')));
    });

    it('lastActor mismatch → denied', async () => {
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(
          pendingAddManualByStakeMember({
            lastActor: { email: 'X@x.com', canonical: 'y@x.com' },
          }),
        ),
      );
    });
  });

  describe('update — terminal state transitions', () => {
    it('original requester cancels their own pending request → ok', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(pendingAddManualByStakeMember());
      });
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(PATH).update({
          status: 'cancelled',
          lastActor: lastActorOf(personas.stakeMember),
        }),
      );
    });

    it('different user tries to cancel → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(pendingAddManualByStakeMember());
      });
      const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
      await assertFails(
        db.doc(PATH).update({
          status: 'cancelled',
          lastActor: lastActorOf(personas.bishopric),
        }),
      );
    });

    it('manager completes → ok', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(pendingAddManualByStakeMember());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(PATH).update({
          status: 'complete',
          completer_email: personas.manager.email,
          completer_canonical: personas.manager.canonical,
          completed_at: new Date(),
          lastActor: lastActorOf(personas.manager),
        }),
      );
    });

    it('completer_canonical does not match auth → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(pendingAddManualByStakeMember());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).update({
          status: 'complete',
          completer_email: personas.manager.email,
          completer_canonical: 'spoof@gmail.com',
          completed_at: new Date(),
          lastActor: lastActorOf(personas.manager),
        }),
      );
    });

    it('non-manager attempts complete → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(pendingAddManualByStakeMember());
      });
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).update({
          status: 'complete',
          completer_email: personas.stakeMember.email,
          completer_canonical: personas.stakeMember.canonical,
          completed_at: new Date(),
          lastActor: lastActorOf(personas.stakeMember),
        }),
      );
    });

    it('manager rejects with non-empty rejection_reason → ok', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(pendingAddManualByStakeMember());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(PATH).update({
          status: 'rejected',
          completer_email: personas.manager.email,
          completer_canonical: personas.manager.canonical,
          completed_at: new Date(),
          rejection_reason: 'Insufficient justification',
          lastActor: lastActorOf(personas.manager),
        }),
      );
    });

    it('manager rejects without rejection_reason → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(pendingAddManualByStakeMember());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).update({
          status: 'rejected',
          completer_email: personas.manager.email,
          completer_canonical: personas.manager.canonical,
          completed_at: new Date(),
          rejection_reason: '',
          lastActor: lastActorOf(personas.manager),
        }),
      );
    });

    it('terminal-status request cannot be re-mutated', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(PATH)
          .set(
            pendingAddManualByStakeMember({
              status: 'complete',
              completer_email: personas.manager.email,
              completer_canonical: personas.manager.canonical,
              completed_at: new Date(),
            }),
          );
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).update({
          status: 'rejected',
          completer_email: personas.manager.email,
          completer_canonical: personas.manager.canonical,
          rejection_reason: 'rethought',
          lastActor: lastActorOf(personas.manager),
        }),
      );
    });

    it('self-approval allowed (manager completing their own request)', async () => {
      // Manager submitted a stake-scope add (managers also have
      // stake-scope claim in real data; here we set both flags on
      // the same persona for the test).
      const dual = contextFor(env, personas.manager, STAKE_ID, {
        manager: true,
        stake: true,
      });
      await assertSucceeds(
        dual
          .firestore()
          .doc(PATH)
          .set(
            pendingAddManualByStakeMember({
              requester_email: personas.manager.email,
              requester_canonical: personas.manager.canonical,
              lastActor: lastActorOf(personas.manager),
            }),
          ),
      );
      // Same manager completes — invariant 7 says this is allowed.
      await assertSucceeds(
        dual
          .firestore()
          .doc(PATH)
          .update({
            status: 'complete',
            completer_email: personas.manager.email,
            completer_canonical: personas.manager.canonical,
            completed_at: new Date(),
            lastActor: lastActorOf(personas.manager),
          }),
      );
    });
  });

  describe('delete', () => {
    it('manager cannot delete', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(pendingAddManualByStakeMember());
      });
      await assertFails(managerContext(env, STAKE_ID).firestore().doc(PATH).delete());
    });

    it('original requester cannot delete', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(pendingAddManualByStakeMember());
      });
      await assertFails(stakeMemberContext(env, STAKE_ID).firestore().doc(PATH).delete());
    });
  });
});
