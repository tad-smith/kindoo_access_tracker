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
  limitedBishopricContext,
  limitedStakeMemberContext,
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
    building_names: ['Maple Building'],
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
    // Every `add_*` / `edit_*` request must carry ≥ 1 building
    // (operator decision 2026-05-16, spec §5.1 / §6).
    building_names: ['Maple Building'],
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
    // Edit types require a non-empty comment on creation. Fixture
    // defaults provide one; tests below assert the rule fires when the
    // field is empty or missing.
    comment: 'Adding stake center for choir practice',
    building_names: ['Maple Building', 'Briargate Building'],
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
    comment: 'Extending visiting-authority assignment',
    building_names: ['Maple Building'],
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
    comment: 'Visit extended through May 15',
    start_date: '2026-05-01',
    end_date: '2026-05-15',
    building_names: ['Maple Building'],
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

    // Universal `building_names ≥ 1` gate (operator decision 2026-05-16,
    // spec §5.1 / §6). Ward-scope `add_manual` / `add_temp` must also
    // carry ≥ 1 building — pre-decision the rule exempted ward scope and
    // relied on a Mark Complete default. The new contract is "every
    // request carries the buildings the requester chose."
    it('ward-scope add_manual with empty building_names → denied', async () => {
      const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
      await assertFails(
        db.doc(PATH).set(
          pendingAddManualByStakeMember({
            scope: '01',
            building_names: [],
            requester_email: personas.bishopric.email,
            requester_canonical: personas.bishopric.canonical,
            lastActor: lastActorOf(personas.bishopric),
          }),
        ),
      );
    });

    it('ward-scope add_temp with empty building_names → denied', async () => {
      const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
      await assertFails(db.doc(PATH).set(pendingAddTempByBishopric('01', { building_names: [] })));
    });

    it('ward-scope add_manual with ≥ 1 building → ok', async () => {
      const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
      await assertSucceeds(
        db.doc(PATH).set(
          pendingAddManualByStakeMember({
            scope: '01',
            building_names: ['Maple Building'],
            requester_email: personas.bishopric.email,
            requester_canonical: personas.bishopric.canonical,
            lastActor: lastActorOf(personas.bishopric),
          }),
        ),
      );
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

    // Kindoo Managers hold full request-creation authority: every scope
    // (stake + any ward) and every type, with no `access` row and no
    // stake / bishopric claim of their own. `managerContext` is exactly
    // that principal — `manager: true`, `stake: false`, `wards: []`.
    describe('manager-only principal — creation authority in every scope', () => {
      /** Stamp a fixture as submitted by the manager-only persona. */
      const byManager = (overrides: Record<string, unknown> = {}) => ({
        requester_email: personas.manager.email,
        requester_canonical: personas.manager.canonical,
        lastActor: lastActorOf(personas.manager),
        ...overrides,
      });

      it('stake-scope add_manual → ok', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingAddManualByStakeMember(byManager())));
      });

      it('stake-scope add_temp → ok', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
        await assertSucceeds(
          db.doc(PATH).set(pendingAddTempByBishopric('01', byManager({ scope: 'stake' }))),
        );
      });

      it('stake-scope edit_manual → ok', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingEditManualByStakeMember(byManager())));
      });

      it('stake-scope edit_temp → ok', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
        await assertSucceeds(
          db.doc(PATH).set(pendingEditTempByBishopric('01', byManager({ scope: 'stake' }))),
        );
      });

      it('stake-scope remove → ok', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
        await assertSucceeds(
          db.doc(PATH).set(pendingRemoveByBishopric('01', byManager({ scope: 'stake' }))),
        );
      });

      // No bishopric claim for ward '01' — the manager branch alone
      // carries these.
      it('ward-scope add_manual for a ward they hold no bishopric claim for → ok', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
        await assertSucceeds(
          db.doc(PATH).set(pendingAddManualByStakeMember(byManager({ scope: '01' }))),
        );
      });

      it('ward-scope add_temp for a ward they hold no bishopric claim for → ok', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingAddTempByBishopric('01', byManager())));
      });

      it('ward-scope remove for a ward they hold no bishopric claim for → ok', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingRemoveByBishopric('01', byManager())));
      });

      it('ward-scope edit_auto → ok', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingEditAutoByBishopric('01', byManager())));
      });

      // Policy 1 is a separate conjunct and binds managers too.
      it('stake-scope edit_auto → denied (Policy 1)', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
        await assertFails(
          db.doc(PATH).set(pendingEditAutoByBishopric('01', byManager({ scope: 'stake' }))),
        );
      });

      // The manager branch widens WHO may create, not WHAT the request
      // must carry. Every other create constraint still applies.
      it('stake-scope add_manual with empty member_name → denied', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
        await assertFails(
          db.doc(PATH).set(pendingAddManualByStakeMember(byManager({ member_name: '' }))),
        );
      });

      it('stake-scope add_manual with empty building_names → denied', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
        await assertFails(
          db.doc(PATH).set(pendingAddManualByStakeMember(byManager({ building_names: [] }))),
        );
      });

      // Regression guards — the manager branch is manager-gated and does
      // not leak into the stake / bishopric branches.
      it('outsider (no manager/stake/bishopric role) stake-scope add_manual → denied', async () => {
        const db = outsiderContext(env, STAKE_ID).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingAddManualByStakeMember({
              requester_email: personas.outsider.email,
              requester_canonical: personas.outsider.canonical,
              lastActor: lastActorOf(personas.outsider),
            }),
          ),
        );
      });

      it('outsider ward-scope add_temp → denied', async () => {
        const db = outsiderContext(env, STAKE_ID).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingAddTempByBishopric('01', {
              requester_email: personas.outsider.email,
              requester_canonical: personas.outsider.canonical,
              lastActor: lastActorOf(personas.outsider),
            }),
          ),
        );
      });

      // The bishopric-only guards ("stake-scope submit by a
      // non-stake-member" and "ward-scope submit for a ward the user has
      // no claim for") live above this block, stamped with the bishopric
      // persona so they fail on the role gate rather than on
      // `requester_canonical` / `lastActor`.

      // Existing behavior unbroken: a stake-scope member still creates a
      // stake-scope add_manual through the stake-claim branch.
      it('stake-scope member still creates stake-scope add_manual → ok', async () => {
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingAddManualByStakeMember()));
      });
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

    // Manager + bishopric claim for ward A → ward B submit still allowed:
    // the manager branch covers every ward, so the ward list is not the
    // binding constraint for a manager. The equivalent denial for a
    // non-manager is asserted below.
    it('ward-scope submit by manager+bishopric user for a ward they do not hold → ok', async () => {
      const db = contextFor(env, personas.manager, STAKE_ID, {
        manager: true,
        wards: ['02'],
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
        building_names: ['Maple Building'],
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

      it('ward-scope by manager-only principal (no bishopric claim) → ok', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
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

      // Universal `building_names ≥ 1` gate (operator decision
      // 2026-05-16, spec §5.1 / §6). edit_auto is ward-scope only
      // (Policy 1); empty buildings is denied even though pre-decision
      // ward-scope edit_auto was permitted to ship with `building_names:
      // []` at the rule level.
      it('ward-scope with empty building_names → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        await assertFails(
          db.doc(PATH).set(pendingEditAutoByBishopric('01', { building_names: [] })),
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
              requester_email: personas.bishopric.email,
              requester_canonical: personas.bishopric.canonical,
              lastActor: lastActorOf(personas.bishopric),
            }),
          ),
        );
      });

      it('ward-scope by manager-only principal (no bishopric claim) → ok', async () => {
        const db = managerContext(env, STAKE_ID).firestore();
        await assertSucceeds(
          db.doc(PATH).set(
            pendingEditManualByStakeMember({
              scope: '01',
              requester_email: personas.manager.email,
              requester_canonical: personas.manager.canonical,
              lastActor: lastActorOf(personas.manager),
            }),
          ),
        );
      });

      // Universal `building_names ≥ 1` gate (operator decision
      // 2026-05-16, spec §5.1 / §6). Applies to every `add_*` / `edit_*`
      // regardless of scope — including ward-scope, which used to be
      // allowed at the rule level pre-decision.
      it('stake-scope with empty building_names → denied', async () => {
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        await assertFails(db.doc(PATH).set(pendingEditManualByStakeMember({ building_names: [] })));
      });

      it('ward-scope with empty building_names → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
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

      // Universal `building_names ≥ 1` gate (operator decision
      // 2026-05-16, spec §5.1 / §6).
      it('ward-scope with empty building_names → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        await assertFails(
          db.doc(PATH).set(pendingEditTempByBishopric('01', { building_names: [] })),
        );
      });

      it('stake-scope with empty building_names → denied', async () => {
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingEditTempByBishopric('01', {
              scope: 'stake',
              building_names: [],
              requester_email: personas.stakeMember.email,
              requester_canonical: personas.stakeMember.canonical,
              lastActor: lastActorOf(personas.stakeMember),
            }),
          ),
        );
      });
    });

    // Edit types require a non-empty `comment` on creation. Rules
    // check the simpler "is a non-empty string" predicate; the shared
    // `accessRequestSchema` zod refinement enforces the stricter
    // trim-then-check at the SDK boundary. The rule's job is to keep
    // a hand-crafted POST from creating an edit-type request with
    // no rationale captured.
    describe('edit-type comment requirement', () => {
      it('edit_auto with empty comment → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        await assertFails(db.doc(PATH).set(pendingEditAutoByBishopric('01', { comment: '' })));
      });

      it('edit_auto with no comment field → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        const payload = pendingEditAutoByBishopric('01');
        delete payload['comment'];
        await assertFails(db.doc(PATH).set(payload));
      });

      it('edit_manual with empty comment → denied', async () => {
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        await assertFails(db.doc(PATH).set(pendingEditManualByStakeMember({ comment: '' })));
      });

      it('edit_manual with no comment field → denied', async () => {
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        const payload = pendingEditManualByStakeMember();
        delete payload['comment'];
        await assertFails(db.doc(PATH).set(payload));
      });

      it('edit_temp with empty comment → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        await assertFails(db.doc(PATH).set(pendingEditTempByBishopric('01', { comment: '' })));
      });

      it('edit_temp with no comment field → denied', async () => {
        const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
        const payload = pendingEditTempByBishopric('01');
        delete payload['comment'];
        await assertFails(db.doc(PATH).set(payload));
      });
    });
  });

  // Limited app access (D24). `stakes[stakeId].limited == true` narrows
  // the submit surface to `add_temp` / `edit_temp` / `remove`, caps temp
  // windows at 90 days, locks ward-scope temp requests to the ward's own
  // building, and restricts `remove` to seats of `type == 'temp'`. Full
  // users (no `limited` key on the claim) are unaffected — the last
  // group in this block pins that.
  describe('limited app access (D24)', () => {
    const WARD = '01';
    const WARD_BUILDING = 'Maple Building';
    const OTHER_BUILDING = 'Briargate Building';
    // Ward with `building_name: ''`, ward with the field absent, and a
    // ward code with no doc at all — the three fail-closed inputs to
    // `limitedWardBuildingOk`.
    const WARD_EMPTY_BUILDING = '02';
    const WARD_NO_BUILDING_FIELD = '03';
    const WARD_MISSING_DOC = '04';

    // Id-first resolution fixtures. `building_id` is the preferred FK
    // (and IS the building's doc ID); `building_name` is the legacy
    // display-name snapshot that can go stale when a building is renamed
    // while no seat / pending request pins the old name.
    const WARD_BUILDING_SLUG = 'maple-building';
    // Ward whose `building_id` resolves to a live building but whose
    // `building_name` snapshot is stale — the drifted state that used to
    // lock limited users out entirely.
    const WARD_STALE_NAME = '05';
    const STALE_NAME = 'Maple Building (Old Name)';
    // Ward whose `building_id` points at a building doc that does not
    // exist. Must fall back to `building_name` rather than erroring.
    const WARD_DANGLING_ID = '06';
    const DANGLING_SLUG = 'no-such-building';
    // Dangling id AND an empty name — nothing resolvable either way.
    const WARD_DANGLING_ID_NO_NAME = '07';

    const ALL_WARDS = [
      WARD,
      WARD_EMPTY_BUILDING,
      WARD_NO_BUILDING_FIELD,
      WARD_MISSING_DOC,
      WARD_STALE_NAME,
      WARD_DANGLING_ID,
      WARD_DANGLING_ID_NO_NAME,
    ];

    const SEAT_CANONICAL = 'subject@gmail.com';
    const SEAT_PATH = `stakes/${STAKE_ID}/seats/${SEAT_CANONICAL}`;

    // Exactly 90 days apart — the inclusive cap boundary.
    const CAP_START = '2026-10-11';
    const CAP_END = '2027-01-09';
    // One day over.
    const OVER_CAP_END = '2027-01-10';
    // Same boundary expressed with leading-zero month AND day on both
    // sides. Firestore rules' `int()` parses '03' / '05' correctly; these
    // two cases are the permanent regression guard for that (the feature's
    // whole 90-day check rests on it).
    const ZERO_PAD_START = '2026-03-05';
    const ZERO_PAD_CAP_END = '2026-06-03';
    const ZERO_PAD_OVER_CAP_END = '2026-06-04';

    async function seedWards(): Promise<void> {
      await seedAsAdmin(env, async (ctx) => {
        const db = ctx.firestore();
        await db.doc(`stakes/${STAKE_ID}/wards/${WARD}`).set({
          ward_code: WARD,
          ward_name: '1st Ward',
          building_name: WARD_BUILDING,
          seat_cap: 30,
        });
        await db.doc(`stakes/${STAKE_ID}/wards/${WARD_EMPTY_BUILDING}`).set({
          ward_code: WARD_EMPTY_BUILDING,
          ward_name: '2nd Ward',
          building_name: '',
          seat_cap: 30,
        });
        await db.doc(`stakes/${STAKE_ID}/wards/${WARD_NO_BUILDING_FIELD}`).set({
          ward_code: WARD_NO_BUILDING_FIELD,
          ward_name: '3rd Ward',
          seat_cap: 30,
        });
        // WARD_MISSING_DOC deliberately unseeded.

        // The live building the slug FKs below point at. Its
        // `building_name` is the CURRENT name; `WARD_STALE_NAME`'s
        // snapshot deliberately disagrees.
        await db.doc(`stakes/${STAKE_ID}/buildings/${WARD_BUILDING_SLUG}`).set({
          building_id: WARD_BUILDING_SLUG,
          building_name: WARD_BUILDING,
        });
        await db.doc(`stakes/${STAKE_ID}/wards/${WARD_STALE_NAME}`).set({
          ward_code: WARD_STALE_NAME,
          ward_name: '5th Ward',
          building_id: WARD_BUILDING_SLUG,
          building_name: STALE_NAME,
          seat_cap: 30,
        });
        await db.doc(`stakes/${STAKE_ID}/wards/${WARD_DANGLING_ID}`).set({
          ward_code: WARD_DANGLING_ID,
          ward_name: '6th Ward',
          building_id: DANGLING_SLUG,
          building_name: OTHER_BUILDING,
          seat_cap: 30,
        });
        await db.doc(`stakes/${STAKE_ID}/wards/${WARD_DANGLING_ID_NO_NAME}`).set({
          ward_code: WARD_DANGLING_ID_NO_NAME,
          ward_name: '7th Ward',
          building_id: DANGLING_SLUG,
          building_name: '',
          seat_cap: 30,
        });
      });
    }

    async function seedSeat(type: 'temp' | 'manual' | 'auto'): Promise<void> {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(SEAT_PATH)
          .set({
            member_canonical: SEAT_CANONICAL,
            member_email: 'Subject@gmail.com',
            member_name: 'Subject Person',
            scope: WARD,
            type,
            callings: type === 'auto' ? ['Ward Clerk'] : [],
            reason: 'Seeded',
            building_names: [WARD_BUILDING],
            duplicate_grants: [],
            duplicate_scopes: [],
            created_at: new Date(),
            last_modified_at: new Date(),
          });
      });
    }

    describe('allowed types', () => {
      it('ward-scope add_temp at exactly the 90-day cap with the ward building → ok', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertSucceeds(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD, {
              start_date: CAP_START,
              end_date: CAP_END,
              building_names: [WARD_BUILDING],
            }),
          ),
        );
      });

      // Regression guard for `int()` on leading-zero ISO segments —
      // '2026-03-05' → '2026-06-03' is exactly 90 days. If `int('03')`
      // ever stopped parsing, this flips red while the non-padded case
      // above stays green.
      it('ward-scope add_temp at the cap with leading-zero month AND day → ok', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertSucceeds(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD, {
              start_date: ZERO_PAD_START,
              end_date: ZERO_PAD_CAP_END,
              building_names: [WARD_BUILDING],
            }),
          ),
        );
      });

      it('ward-scope edit_temp within the cap with the ward building + comment → ok', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertSucceeds(
          db.doc(PATH).set(
            pendingEditTempByBishopric(WARD, {
              start_date: CAP_START,
              end_date: CAP_END,
              building_names: [WARD_BUILDING],
              comment: 'Extending the visiting-speaker window',
            }),
          ),
        );
      });

      it('ward-scope remove against a temp seat → ok', async () => {
        await seedSeat('temp');
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingRemoveByBishopric(WARD)));
      });

      // Stake scope has no single ward to lock to, so the building
      // restriction does not apply — only the 90-day cap does.
      it('stake-scope add_temp within the cap with arbitrary buildings → ok', async () => {
        await seedWards();
        const db = limitedStakeMemberContext(env, STAKE_ID).firestore();
        await assertSucceeds(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD, {
              scope: 'stake',
              start_date: CAP_START,
              end_date: CAP_END,
              building_names: [WARD_BUILDING, OTHER_BUILDING],
              requester_email: personas.stakeMember.email,
              requester_canonical: personas.stakeMember.canonical,
              lastActor: lastActorOf(personas.stakeMember),
            }),
          ),
        );
      });
    });

    describe('forbidden types', () => {
      it('add_manual → denied', async () => {
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingAddManualByStakeMember({
              scope: WARD,
              building_names: [WARD_BUILDING],
              requester_email: personas.bishopric.email,
              requester_canonical: personas.bishopric.canonical,
              lastActor: lastActorOf(personas.bishopric),
            }),
          ),
        );
      });

      it('edit_manual → denied', async () => {
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingEditManualByStakeMember({
              scope: WARD,
              building_names: [WARD_BUILDING],
              requester_email: personas.bishopric.email,
              requester_canonical: personas.bishopric.canonical,
              lastActor: lastActorOf(personas.bishopric),
            }),
          ),
        );
      });

      it('edit_auto → denied', async () => {
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(
          db.doc(PATH).set(pendingEditAutoByBishopric(WARD, { building_names: [WARD_BUILDING] })),
        );
      });
    });

    describe('90-day temp window cap', () => {
      it('add_temp one day over the cap → denied', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD, {
              start_date: CAP_START,
              end_date: OVER_CAP_END,
              building_names: [WARD_BUILDING],
            }),
          ),
        );
      });

      it('add_temp one day over the cap with leading-zero month AND day → denied', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD, {
              start_date: ZERO_PAD_START,
              end_date: ZERO_PAD_OVER_CAP_END,
              building_names: [WARD_BUILDING],
            }),
          ),
        );
      });

      it('edit_temp one day over the cap → denied', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingEditTempByBishopric(WARD, {
              start_date: CAP_START,
              end_date: OVER_CAP_END,
              building_names: [WARD_BUILDING],
            }),
          ),
        );
      });

      it('stake-scope add_temp over the cap → denied (cap is scope-independent)', async () => {
        const db = limitedStakeMemberContext(env, STAKE_ID).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD, {
              scope: 'stake',
              start_date: CAP_START,
              end_date: OVER_CAP_END,
              requester_email: personas.stakeMember.email,
              requester_canonical: personas.stakeMember.canonical,
              lastActor: lastActorOf(personas.stakeMember),
            }),
          ),
        );
      });
    });

    describe('ward-scope building lock', () => {
      it('a building other than the ward building → denied', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(
          db.doc(PATH).set(pendingAddTempByBishopric(WARD, { building_names: [OTHER_BUILDING] })),
        );
      });

      it('the ward building plus an extra building (superset) → denied', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD, {
              building_names: [WARD_BUILDING, OTHER_BUILDING],
            }),
          ),
        );
      });

      it('ward whose building_name is empty → denied (fails closed)', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD_EMPTY_BUILDING, {
              building_names: [WARD_BUILDING],
            }),
          ),
        );
      });

      it('ward with no building_name field → denied (fails closed)', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD_NO_BUILDING_FIELD, {
              building_names: [WARD_BUILDING],
            }),
          ),
        );
      });

      it('ward with no doc at all → denied (fails closed)', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD_MISSING_DOC, {
              building_names: [WARD_BUILDING],
            }),
          ),
        );
      });

      it('edit_temp against a different building → denied', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(
          db.doc(PATH).set(pendingEditTempByBishopric(WARD, { building_names: [OTHER_BUILDING] })),
        );
      });
    });

    // The rules resolve the ward's building ID-FIRST with a raw-name
    // fallback, mirroring `resolveWardBuilding` in `packages/shared`.
    // The invariant these pin: the client must always be stricter than
    // or equal to the rules, so the UI can never offer a submit the
    // rules would reject.
    describe('ward building resolution is id-first (mirrors resolveWardBuilding)', () => {
      // THE REGRESSION TEST. Before the fix the rules read the ward's
      // `building_name` directly, so a ward whose snapshot had gone
      // stale (building renamed while no seat / pending request pinned
      // the old name) demanded the stale name while the client sent the
      // current one — the limited user could not submit at all.
      it('id resolves + stale building_name → the CURRENT building name is allowed', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertSucceeds(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD_STALE_NAME, {
              building_names: [WARD_BUILDING],
            }),
          ),
        );
      });

      it('id resolves + stale building_name → the STALE name is denied', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD_STALE_NAME, {
              building_names: [STALE_NAME],
            }),
          ),
        );
      });

      it('id resolves + stale building_name → edit_temp with the CURRENT name is allowed', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertSucceeds(
          db.doc(PATH).set(
            pendingEditTempByBishopric(WARD_STALE_NAME, {
              building_names: [WARD_BUILDING],
              comment: 'Extending after the building was renamed',
            }),
          ),
        );
      });

      // Proves the ternary short-circuits: the building `get()` is not
      // evaluated when `exists()` is false, so a dangling slug falls
      // through to the name path instead of erroring the predicate. If
      // rules ever started evaluating both ternary branches eagerly,
      // this flips red.
      it('dangling building_id + valid building_name → the name is allowed (fallback works)', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertSucceeds(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD_DANGLING_ID, {
              building_names: [OTHER_BUILDING],
            }),
          ),
        );
      });

      it('dangling building_id → a building other than the fallback name is denied', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD_DANGLING_ID, {
              building_names: [WARD_BUILDING],
            }),
          ),
        );
      });

      it('dangling building_id + empty building_name → denied (fails closed)', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD_DANGLING_ID_NO_NAME, {
              building_names: [OTHER_BUILDING],
            }),
          ),
        );
      });

      // A ward with no `building_id` at all (the un-migrated shape) keeps
      // resolving through the raw-name path exactly as before the fix.
      it('no building_id at all → still resolves via building_name', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertSucceeds(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD, {
              building_names: [WARD_BUILDING],
            }),
          ),
        );
      });

      // The superset guard survives id-first resolution — resolving to
      // the current name must not relax "exactly one building".
      it('resolved current name plus an extra building (superset) → denied', async () => {
        await seedWards();
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD_STALE_NAME, {
              building_names: [WARD_BUILDING, OTHER_BUILDING],
            }),
          ),
        );
      });
    });

    describe('remove restricted to temp seats', () => {
      it('remove against a manual seat → denied', async () => {
        await seedSeat('manual');
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(db.doc(PATH).set(pendingRemoveByBishopric(WARD)));
      });

      it('remove against an auto seat → denied', async () => {
        await seedSeat('auto');
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(db.doc(PATH).set(pendingRemoveByBishopric(WARD)));
      });

      it('remove against a missing seat doc → denied (fails closed)', async () => {
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(db.doc(PATH).set(pendingRemoveByBishopric(WARD)));
      });

      it('remove with no seat_member_canonical field → denied', async () => {
        await seedSeat('temp');
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        const payload = pendingRemoveByBishopric(WARD);
        delete payload['seat_member_canonical'];
        await assertFails(db.doc(PATH).set(payload));
      });

      it('remove with an empty seat_member_canonical → denied', async () => {
        await seedSeat('temp');
        const db = limitedBishopricContext(env, STAKE_ID, ALL_WARDS).firestore();
        await assertFails(
          db.doc(PATH).set(pendingRemoveByBishopric(WARD, { seat_member_canonical: '' })),
        );
      });
    });

    // Full users carry no `limited` key on their claim block, so
    // `!isLimited(stakeId)` short-circuits the whole D24 clause. These
    // pin that the new rule is invisible to them.
    describe('full users are unaffected', () => {
      it('non-limited bishopric add_manual → still ok', async () => {
        const db = bishopricContext(env, STAKE_ID, [WARD]).firestore();
        await assertSucceeds(
          db.doc(PATH).set(
            pendingAddManualByStakeMember({
              scope: WARD,
              building_names: [WARD_BUILDING],
              requester_email: personas.bishopric.email,
              requester_canonical: personas.bishopric.canonical,
              lastActor: lastActorOf(personas.bishopric),
            }),
          ),
        );
      });

      it('non-limited bishopric add_temp over 200 days → still ok', async () => {
        await seedWards();
        const db = bishopricContext(env, STAKE_ID, [WARD]).firestore();
        await assertSucceeds(
          db.doc(PATH).set(
            pendingAddTempByBishopric(WARD, {
              start_date: '2026-01-01',
              end_date: '2026-07-20',
              // Deliberately NOT the ward's own building — the ward lock
              // is limited-only too.
              building_names: [OTHER_BUILDING],
            }),
          ),
        );
      });

      it('non-limited bishopric remove of a manual seat → still ok', async () => {
        await seedSeat('manual');
        const db = bishopricContext(env, STAKE_ID, [WARD]).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingRemoveByBishopric(WARD)));
      });

      it('non-limited stake member add_manual → still ok', async () => {
        const db = stakeMemberContext(env, STAKE_ID).firestore();
        await assertSucceeds(db.doc(PATH).set(pendingAddManualByStakeMember()));
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

    // T-43 reviewer fix: typed `completion_status` discriminator is
    // in the manager complete-request allowlist so the SPA's
    // `useCompleteRemoveRequest` can stamp it on the R-1 race path.
    it('manager completes with completion_status="noop_already_removed" → ok', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(PATH)
          .set(pendingAddManualByStakeMember({ type: 'remove' }));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(PATH).update({
          status: 'complete',
          completer_email: personas.manager.email,
          completer_canonical: personas.manager.canonical,
          completed_at: new Date(),
          completion_note: 'Seat already removed at completion time (no-op).',
          completion_status: 'noop_already_removed',
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
            provisioning_note: 'Added Subject Person to Kindoo with access to Maple Building.',
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
