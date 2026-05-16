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

function pendingEditAutoByBishopric(
  wardCode: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    request_id: REQUEST_ID,
    type: 'edit_auto',
    scope: wardCode,
    member_email: 'Subject@gmail.com',
    member_canonical: 'subject@gmail.com',
    member_name: 'Subject Person',
    reason: '',
    comment: '',
    building_names: ['Cordera Building', 'Briargate Building'],
    status: 'pending',
    requester_email: personas.bishopric.email,
    requester_canonical: personas.bishopric.canonical,
    requested_at: SERVER_TIMESTAMP(),
    lastActor: lastActorOf(personas.bishopric),
    ...overrides,
  };
}

function pendingEditManualByStakeMember(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    request_id: REQUEST_ID,
    type: 'edit_manual',
    scope: 'stake',
    member_email: 'Subject@gmail.com',
    member_canonical: 'subject@gmail.com',
    member_name: 'Subject Person',
    reason: 'Visiting authority (extended)',
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

function pendingEditTempByBishopric(
  wardCode: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    request_id: REQUEST_ID,
    type: 'edit_temp',
    scope: wardCode,
    member_email: 'Subject@gmail.com',
    member_canonical: 'subject@gmail.com',
    member_name: 'Subject Person',
    reason: 'Visiting speaker (extended)',
    comment: '',
    start_date: '2026-05-01',
    end_date: '2026-05-15',
    building_names: ['Cordera Building'],
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

    // Stake-level access grants oversight of every ward roster / request
    // — a stake user clicking any ward on the Ward Rosters page must
    // succeed (the page surfaces per-ward pending requests too) even for
    // wards outside any bishopric claim they may also hold.
    it("stake-scope member can read a ward-scope request they didn't submit", async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(pendingAddTempByBishopric('01'));
      });
      await assertSucceeds(stakeMemberContext(env, STAKE_ID).firestore().doc(PATH).get());
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

    // Role-for-scope gate (B-3 / T-36). Manager status alone does NOT
    // grant creation rights — a pure-manager user with no stake / no
    // ward claim has no submit surface, server-side. The mirror of the
    // SPA's `allowedScopesFor` filter on `firestore.rules`. A manager
    // who also holds `stake: true` or a bishopric ward inherits creation
    // rights through those branches, like any other user.
    it('stake-scope submit by a pure manager → denied (no stake claim)', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(
          pendingAddManualByStakeMember({
            requester_email: personas.manager.email,
            requester_canonical: personas.manager.canonical,
            lastActor: lastActorOf(personas.manager),
          }),
        ),
      );
    });

    it('ward-scope submit by a pure manager → denied (no bishopric claim for that ward)', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(
          pendingAddTempByBishopric('01', {
            requester_email: personas.manager.email,
            requester_canonical: personas.manager.canonical,
            lastActor: lastActorOf(personas.manager),
          }),
        ),
      );
    });

    it('remove submit by a pure manager → denied (no role for the scope)', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(
          pendingRemoveByBishopric('01', {
            requester_email: personas.manager.email,
            requester_canonical: personas.manager.canonical,
            lastActor: lastActorOf(personas.manager),
          }),
        ),
      );
    });

    // Manager + stake claim → stake-scope submit allowed (inherits
    // through the stake branch).
    it('stake-scope submit by manager+stake user → ok', async () => {
      const db = contextFor(env, personas.manager, STAKE_ID, {
        manager: true,
        stake: true,
      }).firestore();
      await assertSucceeds(
        db.doc(PATH).set(
          pendingAddManualByStakeMember({
            requester_email: personas.manager.email,
            requester_canonical: personas.manager.canonical,
            lastActor: lastActorOf(personas.manager),
          }),
        ),
      );
    });

    // Manager + bishopric claim → ward-scope submit for that ward
    // allowed (inherits through the ward branch).
    it('ward-scope submit by manager+bishopric user for their own ward → ok', async () => {
      const db = contextFor(env, personas.manager, STAKE_ID, {
        manager: true,
        wards: ['01'],
      }).firestore();
      await assertSucceeds(
        db.doc(PATH).set(
          pendingAddTempByBishopric('01', {
            requester_email: personas.manager.email,
            requester_canonical: personas.manager.canonical,
            lastActor: lastActorOf(personas.manager),
          }),
        ),
      );
    });

    // Manager + bishopric claim for ward A → ward B submit denied.
    // Manager status does not extend the ward list.
    it('ward-scope submit by manager+bishopric user for a ward they do not hold → denied', async () => {
      const db = contextFor(env, personas.manager, STAKE_ID, {
        manager: true,
        wards: ['02'],
      }).firestore();
      await assertFails(
        db.doc(PATH).set(
          pendingAddTempByBishopric('01', {
            requester_email: personas.manager.email,
            requester_canonical: personas.manager.canonical,
            lastActor: lastActorOf(personas.manager),
          }),
        ),
      );
    });

    // Stake+ward user submitting against a different ward → denied.
    // Holding `stake: true` does not extend the ward list.
    it('stake-scope user with one bishopric ward submitting against a different ward → denied', async () => {
      const db = contextFor(env, personas.stakeMember, STAKE_ID, {
        stake: true,
        wards: ['01'],
      }).firestore();
      await assertFails(
        db.doc(PATH).set(
          pendingAddTempByBishopric('02', {
            requester_email: personas.stakeMember.email,
            requester_canonical: personas.stakeMember.canonical,
            lastActor: lastActorOf(personas.stakeMember),
          }),
        ),
      );
    });

    // Mirror of the SPA's `useSubmitRequest` payload — a manager+stake
    // user submitting a stake-scope add_manual against the production
    // staging shape. Each field is what the form actually sends; the
    // tests above use a slimmer fixture that doesn't catch shape
    // regressions in the form-driven path.
    it('manager+stake submits the exact stake-scope add_manual payload the form sends → ok', async () => {
      const db = contextFor(env, personas.manager, STAKE_ID, {
        manager: true,
        stake: true,
      }).firestore();
      const formPayload: Record<string, unknown> = {
        request_id: REQUEST_ID,
        type: 'add_manual',
        scope: 'stake',
        member_email: 'New.Member@gmail.com',
        member_canonical: 'newmember@gmail.com',
        member_name: 'New Member',
        reason: 'Visiting authority',
        comment: 'Some context',
        building_names: ['Cordera Building'],
        status: 'pending',
        requester_email: personas.manager.email,
        requester_canonical: personas.manager.canonical,
        requested_at: SERVER_TIMESTAMP(),
        lastActor: lastActorOf(personas.manager),
      };
      await assertSucceeds(db.doc(PATH).set(formPayload));
    });

    // urgent: bool validation. Field is requester-set on submit and
    // missing → treated as false on read.
    describe('urgent field', () => {
      it('urgent: true → ok', async () => {
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingAddManualByStakeMember({ urgent: true })));
      });

      it('urgent: false → ok', async () => {
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingAddManualByStakeMember({ urgent: false })));
      });

      it('urgent missing → ok (treated as false on read)', async () => {
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingAddManualByStakeMember()));
      });

      it('urgent: "yes" (string) → denied', async () => {
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        await assertFails(db.doc(PATH).set(pendingAddManualByStakeMember({ urgent: 'yes' })));
      });

      it('urgent: 1 (number) → denied', async () => {
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        await assertFails(db.doc(PATH).set(pendingAddManualByStakeMember({ urgent: 1 })));
      });
    });

    // add_temp date enforcement — start_date / end_date must be ISO
    // YYYY-MM-DD strings and start <= end. Other request types are
    // unaffected (preserve existing behavior).
    describe('add_temp date enforcement', () => {
      it('add_temp with both ISO dates and end >= start → ok', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingAddTempByBishopric('01')));
      });

      it('add_temp with no start_date → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        const payload = pendingAddTempByBishopric('01');
        delete payload['start_date'];
        await assertFails(db.doc(PATH).set(payload));
      });

      it('add_temp with no end_date → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        const payload = pendingAddTempByBishopric('01');
        delete payload['end_date'];
        await assertFails(db.doc(PATH).set(payload));
      });

      it('add_temp with start_date "not-a-date" → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        await assertFails(
          db.doc(PATH).set(pendingAddTempByBishopric('01', { start_date: 'not-a-date' })),
        );
      });

      it('add_temp with start > end → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingAddTempByBishopric('01', {
              start_date: '2026-06-10',
              end_date: '2026-06-01',
            }),
          ),
        );
      });

      it('add_manual with no dates → ok (preserve existing behavior)', async () => {
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingAddManualByStakeMember()));
      });

      it('remove with no dates → ok (preserve existing behavior)', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingRemoveByBishopric('01')));
      });
    });

    // Edit types — `edit_auto`, `edit_manual`, `edit_temp` — flow
    // through the same submit path as add / remove. Same role-for-scope
    // gating; same `lastActor` integrity; `edit_auto` adds the
    // stake-scope rejection (Policy 1); `edit_temp` adds the same
    // start/end date shape check as `add_temp`.
    describe('edit_auto', () => {
      it('ward-scope by bishopric → ok', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingEditAutoByBishopric('01')));
      });

      it('ward-scope by manager+bishopric for their own ward → ok', async () => {
        const db = contextFor(env, personas.manager, STAKE_ID, {
          manager: true,
          wards: ['01'],
        }).firestore();
        await assertSucceeds(
          db.doc(PATH).set(
            pendingEditAutoByBishopric('01', {
              requester_email: personas.manager.email,
              requester_canonical: personas.manager.canonical,
              lastActor: lastActorOf(personas.manager),
            }),
          ),
        );
      });

      it('ward-scope by bishopric for another ward → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['02']).firestore();
        await assertFails(db.doc(PATH).set(pendingEditAutoByBishopric('01')));
      });

      it('ward-scope by pure manager (no role for scope) → denied', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingEditAutoByBishopric('01', {
              requester_email: personas.manager.email,
              requester_canonical: personas.manager.canonical,
              lastActor: lastActorOf(personas.manager),
            }),
          ),
        );
      });

      it('ward-scope by stake-only user (no bishopric claim for that ward) → denied', async () => {
        // The role-for-scope gate mirrors add / remove. `stake: true`
        // alone does not extend the ward list; cross-ward submit
        // requires a bishopric claim for the target ward.
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingEditAutoByBishopric('01', {
              requester_email: personas.stakeMember.email,
              requester_canonical: personas.stakeMember.canonical,
              lastActor: lastActorOf(personas.stakeMember),
            }),
          ),
        );
      });

      it('unauthenticated → denied', async () => {
        const db = unauthedContext(env).firestore();
        await assertFails(db.doc(PATH).set(pendingEditAutoByBishopric('01')));
      });

      // Policy 1 — stake auto seats are non-editable. All roles denied,
      // even a manager+stake-scope user (who would otherwise inherit
      // submit rights through the stake branch). Mirrors the
      // `markRequestComplete` callable check and the web UI hide-Edit
      // behavior on the All Seats page.
      it('stake-scope by manager+stake → denied (Policy 1)', async () => {
        const db = contextFor(env, personas.manager, STAKE_ID, {
          manager: true,
          stake: true,
        }).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingEditAutoByBishopric('01', {
              scope: 'stake',
              requester_email: personas.manager.email,
              requester_canonical: personas.manager.canonical,
              lastActor: lastActorOf(personas.manager),
            }),
          ),
        );
      });

      it('stake-scope by stake-scope member → denied (Policy 1)', async () => {
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingEditAutoByBishopric('01', {
              scope: 'stake',
              requester_email: personas.stakeMember.email,
              requester_canonical: personas.stakeMember.canonical,
              lastActor: lastActorOf(personas.stakeMember),
            }),
          ),
        );
      });
    });

    describe('edit_manual', () => {
      it('stake-scope by stake-scope member → ok', async () => {
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingEditManualByStakeMember()));
      });

      it('ward-scope by bishopric → ok', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        await assertSucceeds(
          db.doc(PATH).set(
            pendingEditManualByStakeMember({
              scope: '01',
              building_names: [],
              requester_email: personas.bishopric.email,
              requester_canonical: personas.bishopric.canonical,
              lastActor: lastActorOf(personas.bishopric),
            }),
          ),
        );
      });

      it('stake-scope by bishopric (no stake claim) → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingEditManualByStakeMember({
              requester_email: personas.bishopric.email,
              requester_canonical: personas.bishopric.canonical,
              lastActor: lastActorOf(personas.bishopric),
            }),
          ),
        );
      });

      it('ward-scope by bishopric for another ward → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['02']).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingEditManualByStakeMember({
              scope: '01',
              building_names: [],
              requester_email: personas.bishopric.email,
              requester_canonical: personas.bishopric.canonical,
              lastActor: lastActorOf(personas.bishopric),
            }),
          ),
        );
      });

      it('ward-scope by pure manager → denied', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingEditManualByStakeMember({
              scope: '01',
              building_names: [],
              requester_email: personas.manager.email,
              requester_canonical: personas.manager.canonical,
              lastActor: lastActorOf(personas.manager),
            }),
          ),
        );
      });

      it('stake-scope with empty building_names → denied', async () => {
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        await assertFails(db.doc(PATH).set(pendingEditManualByStakeMember({ building_names: [] })));
      });

      it('unauthenticated → denied', async () => {
        const db = unauthedContext(env).firestore();
        await assertFails(db.doc(PATH).set(pendingEditManualByStakeMember()));
      });
    });

    describe('edit_temp', () => {
      it('ward-scope by bishopric → ok', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingEditTempByBishopric('01')));
      });

      it('stake-scope by stake-scope member → ok', async () => {
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        await assertSucceeds(
          db.doc(PATH).set(
            pendingEditTempByBishopric('01', {
              scope: 'stake',
              requester_email: personas.stakeMember.email,
              requester_canonical: personas.stakeMember.canonical,
              lastActor: lastActorOf(personas.stakeMember),
            }),
          ),
        );
      });

      it('stake-scope by bishopric → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingEditTempByBishopric('01', {
              scope: 'stake',
            }),
          ),
        );
      });

      it('ward-scope by bishopric for another ward → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['02']).firestore();
        await assertFails(db.doc(PATH).set(pendingEditTempByBishopric('01')));
      });

      it('edit_temp without start_date → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        const payload = pendingEditTempByBishopric('01');
        delete payload['start_date'];
        await assertFails(db.doc(PATH).set(payload));
      });

      it('edit_temp with malformed start_date → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        await assertFails(
          db.doc(PATH).set(pendingEditTempByBishopric('01', { start_date: 'not-a-date' })),
        );
      });

      it('edit_temp with start > end → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingEditTempByBishopric('01', {
              start_date: '2026-06-10',
              end_date: '2026-06-01',
            }),
          ),
        );
      });
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

    it('manager attempts to flip urgent post-submit during complete → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(PATH)
          .set(pendingAddManualByStakeMember({ urgent: false }));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).update({
          status: 'complete',
          completer_email: personas.manager.email,
          completer_canonical: personas.manager.canonical,
          completed_at: new Date(),
          urgent: true,
          lastActor: lastActorOf(personas.manager),
        }),
      );
    });

    it('requester attempts to flip urgent during cancel → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(PATH)
          .set(pendingAddManualByStakeMember({ urgent: false }));
      });
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).update({
          status: 'cancelled',
          urgent: true,
          lastActor: lastActorOf(personas.stakeMember),
        }),
      );
    });

    // Extension v2.2 — Provision & Complete adds two optional fields
    // to the complete-arm: `kindoo_uid` and `provisioning_note`. Both
    // must be strings when present; provisioning_note is bounded to
    // 500 chars by the rule. Outside of `complete`, the affected-keys
    // allowlist on cancel / reject excludes both so they cannot leak
    // through those transitions.
    describe('complete with v2.2 provisioning metadata', () => {
      it('manager completes with kindoo_uid + provisioning_note → ok', async () => {
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
            kindoo_uid: 'kindoo-user-12345',
            provisioning_note: 'Added Subject Person to Kindoo with access to Cordera Building.',
            lastActor: lastActorOf(personas.manager),
          }),
        );
      });

      it('manager completes with kindoo_uid only → ok (provisioning_note absent)', async () => {
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
            kindoo_uid: 'kindoo-user-12345',
            lastActor: lastActorOf(personas.manager),
          }),
        );
      });

      it('non-manager cannot write kindoo_uid via complete (caller is stake-scope) → denied', async () => {
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
            kindoo_uid: 'kindoo-user-12345',
            provisioning_note: 'attempted',
            lastActor: lastActorOf(personas.stakeMember),
          }),
        );
      });

      it('manager completes with non-string kindoo_uid → denied', async () => {
        await seedAsAdmin(env, async (ctx) => {
          await ctx.firestore().doc(PATH).set(pendingAddManualByStakeMember());
        });
        const db = managerContext(env, STAKE_ID).firestore();
        await assertFails(
          db.doc(PATH).update({
            status: 'complete',
            completer_email: personas.manager.email,
            completer_canonical: personas.manager.canonical,
            completed_at: new Date(),
            kindoo_uid: 42,
            lastActor: lastActorOf(personas.manager),
          }),
        );
      });

      it('manager completes with non-string provisioning_note → denied', async () => {
        await seedAsAdmin(env, async (ctx) => {
          await ctx.firestore().doc(PATH).set(pendingAddManualByStakeMember());
        });
        const db = managerContext(env, STAKE_ID).firestore();
        await assertFails(
          db.doc(PATH).update({
            status: 'complete',
            completer_email: personas.manager.email,
            completer_canonical: personas.manager.canonical,
            completed_at: new Date(),
            provisioning_note: { foo: 'bar' },
            lastActor: lastActorOf(personas.manager),
          }),
        );
      });

      it('manager completes with oversized provisioning_note (>500 chars) → denied', async () => {
        await seedAsAdmin(env, async (ctx) => {
          await ctx.firestore().doc(PATH).set(pendingAddManualByStakeMember());
        });
        const db = managerContext(env, STAKE_ID).firestore();
        await assertFails(
          db.doc(PATH).update({
            status: 'complete',
            completer_email: personas.manager.email,
            completer_canonical: personas.manager.canonical,
            completed_at: new Date(),
            provisioning_note: 'x'.repeat(501),
            lastActor: lastActorOf(personas.manager),
          }),
        );
      });

      it('manager completes with provisioning_note at boundary (500 chars) → ok', async () => {
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
            provisioning_note: 'x'.repeat(500),
            lastActor: lastActorOf(personas.manager),
          }),
        );
      });

      // The affected-keys allowlist on cancel / reject excludes
      // kindoo_uid + provisioning_note so neither field can leak
      // through a non-complete transition.
      it('requester cannot smuggle kindoo_uid through cancel → denied', async () => {
        await seedAsAdmin(env, async (ctx) => {
          await ctx.firestore().doc(PATH).set(pendingAddManualByStakeMember());
        });
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        await assertFails(
          db.doc(PATH).update({
            status: 'cancelled',
            kindoo_uid: 'kindoo-user-12345',
            lastActor: lastActorOf(personas.stakeMember),
          }),
        );
      });

      it('manager cannot smuggle provisioning_note through reject → denied', async () => {
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
            rejection_reason: 'No.',
            provisioning_note: 'sneaky',
            lastActor: lastActorOf(personas.manager),
          }),
        );
      });
    });

    it('self-approval allowed (manager+stake submits + completes their own request)', async () => {
      // Invariant 7 (self-approval) — a manager who holds the role for
      // the scope can submit a request and then complete it. Post
      // T-36 the submitter must hold the role for the scope (manager
      // status alone does not grant submit), so we test with the
      // manager+stake combination on a stake-scope request.
      const mgr = contextFor(env, personas.manager, STAKE_ID, {
        manager: true,
        stake: true,
      });
      await assertSucceeds(
        mgr
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
      await assertSucceeds(
        mgr
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
