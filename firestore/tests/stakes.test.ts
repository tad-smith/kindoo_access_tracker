// Rules tests for the parent `stakes/{stakeId}` doc per
// `firebase-schema.md` §4.1.
//
// Read: any member of the stake.
// Update: managers, with `lastActor` integrity check.
// Create: platform superadmins (the `createStake` callable; not
//         meaningful via client tx but tested for completeness).
// Delete: never.
//
// Cross-stake denial: a manager whose claims are for stake A trying
// to read stake B's parent doc is denied.
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
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
  superadminContext,
  unauthedContext,
} from './lib/rules.js';

const STAKE_ID = 'csnorth';
const OTHER_STAKE_ID = 'someother';
const PATH = `stakes/${STAKE_ID}`;
const OTHER_PATH = `stakes/${OTHER_STAKE_ID}`;

function freshStakeDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    stake_id: STAKE_ID,
    stake_name: 'CS North Stake',
    created_at: new Date(),
    created_by: 'admin@kindoo.example',
    callings_sheet_id: '1abcXYZ',
    bootstrap_admin_email: 'Bishop@example.org',
    setup_complete: true,
    stake_seat_cap: 250,
    expiry_hour: 4,
    import_day: 'MONDAY',
    import_hour: 6,
    timezone: 'America/Denver',
    notifications_enabled: true,
    last_over_caps_json: [],
    last_modified_at: new Date(),
    last_modified_by: lastActorOf(personas.manager),
    lastActor: lastActorOf(personas.manager),
    ...overrides,
  };
}

describe('firestore.rules — stakes/{stakeId} parent doc', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('stakes');
  });

  afterEach(async () => {
    await clearAll(env);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  describe('read', () => {
    it('manager can read', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshStakeDoc());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(PATH).get());
    });

    it('stake-scope member can read', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshStakeDoc());
      });
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(PATH).get());
    });

    it('bishopric member (any ward visibility) can read', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshStakeDoc());
      });
      const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
      await assertSucceeds(db.doc(PATH).get());
    });

    it('outsider (no claims under this stake) is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshStakeDoc());
      });
      const db = outsiderContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(PATH).get());
    });

    it('anonymous read is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshStakeDoc());
      });
      const db = unauthedContext(env).firestore();
      await assertFails(db.doc(PATH).get());
    });

    it('cross-stake: manager of stake A is denied reading stake B', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(OTHER_PATH)
          .set(freshStakeDoc({ stake_id: OTHER_STAKE_ID }));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(OTHER_PATH).get());
    });

    // Setup-in-progress read gate: per the SPA's setup-complete gate
    // (`docs/firebase-migration.md` §Phase 7 + `docs/spec.md` §10), any
    // signed-in user must be able to read the parent stake doc while
    // `setup_complete == false` so the gate can route them to
    // SetupInProgress.
    it('outsider can read the parent stake doc when setup_complete=false', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(PATH)
          .set(freshStakeDoc({ setup_complete: false }));
      });
      const db = outsiderContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(PATH).get());
    });

    // Once setup completes, the gate goes silent — outsiders are
    // denied again (the standard `isAnyMember` rule is the only path).
    it('outsider is re-denied once setup_complete=true', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(PATH)
          .set(freshStakeDoc({ setup_complete: true }));
      });
      const db = outsiderContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(PATH).get());
    });

    it('anonymous read still denied during setup_complete=false', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(PATH)
          .set(freshStakeDoc({ setup_complete: false }));
      });
      const db = unauthedContext(env).firestore();
      await assertFails(db.doc(PATH).get());
    });
  });

  describe('update', () => {
    it('manager update with matching lastActor → ok', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshStakeDoc());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(PATH).set(freshStakeDoc({ stake_name: 'CS North Stake (renamed)' })),
      );
    });

    it('manager update with mismatched lastActor.email → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshStakeDoc());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      // The auth token has email='Mgr@gmail.com'; lastActor.email
      // here is 'Other@gmail.com' — should fail.
      await assertFails(
        db.doc(PATH).set(
          freshStakeDoc({
            lastActor: { email: 'Other@gmail.com', canonical: 'mgr@gmail.com' },
          }),
        ),
      );
    });

    it('manager update with mismatched lastActor.canonical → denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshStakeDoc());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(
          freshStakeDoc({
            lastActor: { email: 'Mgr@gmail.com', canonical: 'someone-else@gmail.com' },
          }),
        ),
      );
    });

    it('non-manager update is denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshStakeDoc());
      });
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(freshStakeDoc({ lastActor: lastActorOf(personas.stakeMember) })),
      );
    });

    it('cross-stake: manager of stake A is denied updating stake B', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(OTHER_PATH)
          .set(freshStakeDoc({ stake_id: OTHER_STAKE_ID }));
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(OTHER_PATH).set(freshStakeDoc({ stake_id: OTHER_STAKE_ID, stake_name: 'evil' })),
      );
    });
  });

  describe('create', () => {
    it('superadmin can create', async () => {
      const db = superadminContext(env).firestore();
      // Use create-only path; lastActor matching is not required by
      // the create rule (create allows superadmin only — lastActor
      // matching is enforced on `update`).
      await assertSucceeds(db.doc(PATH).set(freshStakeDoc()));
    });

    it('manager cannot create a stake doc', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      // Manager has manager claim on STAKE_ID, but per the create
      // rule, only superadmin may create — even a stake's existing
      // manager claim is irrelevant pre-doc-existence.
      await assertFails(db.doc('stakes/brand-new-stake').set(freshStakeDoc()));
    });

    it('outsider cannot create', async () => {
      const db = contextFor(env, personas.outsider, STAKE_ID, {}).firestore();
      await assertFails(db.doc('stakes/another-new').set(freshStakeDoc()));
    });
  });

  describe('delete', () => {
    it('nobody — not even superadmin — can delete', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshStakeDoc());
      });
      const db = superadminContext(env).firestore();
      await assertFails(db.doc(PATH).delete());
    });
  });
});
