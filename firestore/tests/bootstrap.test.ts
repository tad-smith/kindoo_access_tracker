// Rules tests for the bootstrap-admin escape hatch in
// `firestore.rules` — the `isBootstrapAdmin(stakeId)` predicate that
// unblocks the Phase 7 wizard's chicken-and-egg first writes. See
// `firebase-schema.md` §6 and the file-header comment in
// `firestore.rules`.
//
// Invariants under test:
//
//   1. While `setup_complete=false` AND the auth token's email matches
//      `stake.bootstrap_admin_email`, the bootstrap admin can:
//      - read + write `stakes/{sid}/kindooManagers/{canonical}` (the
//        wizard's auto-self-add — the chicken-and-egg case).
//      - read + write `stakes/{sid}/wards/{wardCode}`.
//      - read + write `stakes/{sid}/buildings/{buildingId}`.
//      - read + update `stakes/{sid}` (Step 1 fields + the final
//        `setup_complete=true` flip).
//
//   2. Once `setup_complete=true`, the bootstrap-admin gate goes silent —
//      every wizard-shaped write is denied (one-shot wizard).
//
//   3. A signed-in user whose email does NOT match the stake's
//      `bootstrap_admin_email` cannot use the gate, even when
//      `setup_complete=false`.
//
//   4. The gate is strictly time-bounded by the stake doc's
//      `setup_complete` field — bootstrap admin can't flip it back to
//      `false` after it's true (because their gate already failed by
//      that point; only a manager could).
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  bootstrapAdminContext,
  clearAll,
  lastActorOf,
  personas,
  seedAsAdmin,
  setupTestEnv,
} from './lib/rules.js';

const STAKE_ID = 'csnorth';
const STAKE_PATH = `stakes/${STAKE_ID}`;
const WARD_CODE = '01';
const WARD_PATH = `${STAKE_PATH}/wards/${WARD_CODE}`;
const BUILDING_ID = 'cordera-building';
const BUILDING_PATH = `${STAKE_PATH}/buildings/${BUILDING_ID}`;
const BOOTSTRAP_CANONICAL = personas.bootstrapAdmin.canonical;
const BOOTSTRAP_KM_PATH = `${STAKE_PATH}/kindooManagers/${BOOTSTRAP_CANONICAL}`;

function freshStakeDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    stake_id: STAKE_ID,
    stake_name: 'CS North Stake',
    created_at: new Date(),
    created_by: 'admin@kindoo.example',
    callings_sheet_id: '1abcXYZ',
    bootstrap_admin_email: personas.bootstrapAdmin.email,
    setup_complete: false,
    stake_seat_cap: 250,
    expiry_hour: 4,
    import_day: 'MONDAY',
    import_hour: 6,
    timezone: 'America/Denver',
    notifications_enabled: true,
    last_over_caps_json: [],
    last_modified_at: new Date(),
    last_modified_by: lastActorOf(personas.bootstrapAdmin),
    lastActor: lastActorOf(personas.bootstrapAdmin),
    ...overrides,
  };
}

function freshKindooManagerDoc(
  canonical: string,
  email: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    member_canonical: canonical,
    member_email: email,
    name: email,
    active: true,
    added_at: new Date(),
    added_by: lastActorOf(personas.bootstrapAdmin),
    lastActor: lastActorOf(personas.bootstrapAdmin),
    ...overrides,
  };
}

function freshWardDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ward_code: WARD_CODE,
    ward_name: '1st Ward',
    building_name: 'Cordera Building',
    seat_cap: 30,
    created_at: new Date(),
    last_modified_at: new Date(),
    lastActor: lastActorOf(personas.bootstrapAdmin),
    ...overrides,
  };
}

function freshBuildingDoc(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    building_id: BUILDING_ID,
    building_name: 'Cordera Building',
    address: '1234 Cordera Cir',
    created_at: new Date(),
    last_modified_at: new Date(),
    lastActor: lastActorOf(personas.bootstrapAdmin),
    ...overrides,
  };
}

describe('firestore.rules — bootstrap-admin gate', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('bootstrap');
  });

  afterEach(async () => {
    await clearAll(env);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  // -----------------------------------------------------------------
  // 1. Happy path — bootstrap admin works end-to-end while
  //    setup_complete=false.
  // -----------------------------------------------------------------
  describe('while setup_complete=false', () => {
    it('bootstrap admin can read the stake doc', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(STAKE_PATH).set(freshStakeDoc());
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertSucceeds(db.doc(STAKE_PATH).get());
    });

    it('bootstrap admin can update the stake doc (Step 1 fields)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(STAKE_PATH).set(freshStakeDoc());
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertSucceeds(
        db.doc(STAKE_PATH).set(
          freshStakeDoc({
            stake_name: 'CS North Stake (renamed during bootstrap)',
            stake_seat_cap: 300,
          }),
        ),
      );
    });

    it('bootstrap admin can flip setup_complete=true (the wizard finale)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(STAKE_PATH).set(freshStakeDoc());
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertSucceeds(db.doc(STAKE_PATH).set(freshStakeDoc({ setup_complete: true })));
    });

    it('bootstrap admin can write their own kindooManagers doc (the chicken-and-egg case)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(STAKE_PATH).set(freshStakeDoc());
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertSucceeds(
        db
          .doc(BOOTSTRAP_KM_PATH)
          .set(freshKindooManagerDoc(BOOTSTRAP_CANONICAL, personas.bootstrapAdmin.email)),
      );
    });

    it('bootstrap admin can read kindooManagers list', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(STAKE_PATH).set(freshStakeDoc());
        await ctx
          .firestore()
          .doc(BOOTSTRAP_KM_PATH)
          .set(freshKindooManagerDoc(BOOTSTRAP_CANONICAL, personas.bootstrapAdmin.email));
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertSucceeds(db.doc(BOOTSTRAP_KM_PATH).get());
    });

    it('bootstrap admin can add additional managers (Step 4)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(STAKE_PATH).set(freshStakeDoc());
      });
      const db = bootstrapAdminContext(env).firestore();
      const otherCanonical = 'second-mgr@gmail.com';
      const otherPath = `${STAKE_PATH}/kindooManagers/${otherCanonical}`;
      await assertSucceeds(
        db.doc(otherPath).set(freshKindooManagerDoc(otherCanonical, 'Second-Mgr@gmail.com')),
      );
    });

    it('bootstrap admin can create a building (Step 2)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(STAKE_PATH).set(freshStakeDoc());
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertSucceeds(db.doc(BUILDING_PATH).set(freshBuildingDoc()));
    });

    it('bootstrap admin can read the buildings collection', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(STAKE_PATH).set(freshStakeDoc());
        await ctx.firestore().doc(BUILDING_PATH).set(freshBuildingDoc());
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertSucceeds(db.doc(BUILDING_PATH).get());
    });

    it('bootstrap admin can create a ward (Step 3)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(STAKE_PATH).set(freshStakeDoc());
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertSucceeds(db.doc(WARD_PATH).set(freshWardDoc()));
    });

    it('bootstrap admin can read the wards collection', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(STAKE_PATH).set(freshStakeDoc());
        await ctx.firestore().doc(WARD_PATH).set(freshWardDoc());
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertSucceeds(db.doc(WARD_PATH).get());
    });

    it('bootstrap admin write with mismatched lastActor → denied (integrity check still applies)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(STAKE_PATH).set(freshStakeDoc());
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertFails(
        db.doc(BOOTSTRAP_KM_PATH).set(
          freshKindooManagerDoc(BOOTSTRAP_CANONICAL, personas.bootstrapAdmin.email, {
            lastActor: { email: 'Forged@gmail.com', canonical: 'forged@gmail.com' },
          }),
        ),
      );
    });
  });

  // -----------------------------------------------------------------
  // 2. One-shot — once setup_complete=true the gate goes silent.
  // -----------------------------------------------------------------
  describe('once setup_complete=true (one-shot enforcement)', () => {
    it('bootstrap admin alone (no manager claim) cannot update stake doc', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(STAKE_PATH)
          .set(freshStakeDoc({ setup_complete: true }));
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertFails(
        db.doc(STAKE_PATH).set(freshStakeDoc({ setup_complete: true, stake_seat_cap: 999 })),
      );
    });

    it('bootstrap admin alone cannot flip setup_complete back to false', async () => {
      // Post-setup, only a real manager can edit the stake doc. The
      // bootstrap admin holds no manager claim in this test (they
      // would in production via syncManagersClaims, but that's the
      // manager-path, not the bootstrap-admin gate).
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(STAKE_PATH)
          .set(freshStakeDoc({ setup_complete: true }));
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertFails(db.doc(STAKE_PATH).set(freshStakeDoc({ setup_complete: false })));
    });

    it('bootstrap admin alone cannot write to kindooManagers post-setup', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(STAKE_PATH)
          .set(freshStakeDoc({ setup_complete: true }));
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertFails(
        db
          .doc(BOOTSTRAP_KM_PATH)
          .set(freshKindooManagerDoc(BOOTSTRAP_CANONICAL, personas.bootstrapAdmin.email)),
      );
    });

    it('bootstrap admin alone cannot write to wards post-setup', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(STAKE_PATH)
          .set(freshStakeDoc({ setup_complete: true }));
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertFails(db.doc(WARD_PATH).set(freshWardDoc()));
    });

    it('bootstrap admin alone cannot write to buildings post-setup', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(STAKE_PATH)
          .set(freshStakeDoc({ setup_complete: true }));
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertFails(db.doc(BUILDING_PATH).set(freshBuildingDoc()));
    });
  });

  // -----------------------------------------------------------------
  // 3. Identity check — only the email recorded on the stake doc
  //    activates the gate.
  // -----------------------------------------------------------------
  describe('identity check', () => {
    it('signed-in user whose email does NOT match bootstrap_admin_email is denied (kindooManagers)', async () => {
      // Stake says some other email is the bootstrap admin. Our
      // bootstrapAdminContext signs in as personas.bootstrapAdmin
      // (Bootstrap@gmail.com), so the gate should not engage.
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(STAKE_PATH)
          .set(freshStakeDoc({ bootstrap_admin_email: 'Someone-Else@gmail.com' }));
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertFails(
        db
          .doc(BOOTSTRAP_KM_PATH)
          .set(freshKindooManagerDoc(BOOTSTRAP_CANONICAL, personas.bootstrapAdmin.email)),
      );
    });

    it('signed-in user whose email does NOT match bootstrap_admin_email is denied (stake update)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(STAKE_PATH)
          .set(freshStakeDoc({ bootstrap_admin_email: 'Someone-Else@gmail.com' }));
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertFails(
        db.doc(STAKE_PATH).set(
          freshStakeDoc({
            bootstrap_admin_email: 'Someone-Else@gmail.com',
            setup_complete: true,
          }),
        ),
      );
    });

    it('signed-in user whose email does NOT match bootstrap_admin_email is denied reading stake doc', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(STAKE_PATH)
          .set(freshStakeDoc({ bootstrap_admin_email: 'Someone-Else@gmail.com' }));
      });
      const db = bootstrapAdminContext(env).firestore();
      // No stake claims, no manager claim, and email doesn't match —
      // the only path through (`isAnyMember`) is also closed.
      await assertFails(db.doc(STAKE_PATH).get());
    });
  });

  // -----------------------------------------------------------------
  // 4. Defense-in-depth — the gate doesn't open up other doors.
  // -----------------------------------------------------------------
  describe('scope of the gate', () => {
    it('bootstrap admin cannot write to access (not a wizard collection)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(STAKE_PATH).set(freshStakeDoc());
      });
      const db = bootstrapAdminContext(env).firestore();
      const accessPath = `${STAKE_PATH}/access/${BOOTSTRAP_CANONICAL}`;
      await assertFails(
        db.doc(accessPath).set({
          member_canonical: BOOTSTRAP_CANONICAL,
          importer_callings: {},
          manual_grants: { stake: [{ reason: 'test', granted_at: new Date() }] },
          last_modified_at: new Date(),
          last_modified_by: lastActorOf(personas.bootstrapAdmin),
          lastActor: lastActorOf(personas.bootstrapAdmin),
        }),
      );
    });

    it('bootstrap admin cannot write to seats (not a wizard collection)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(STAKE_PATH).set(freshStakeDoc());
      });
      const db = bootstrapAdminContext(env).firestore();
      const seatsPath = `${STAKE_PATH}/seats/${BOOTSTRAP_CANONICAL}`;
      await assertFails(
        db.doc(seatsPath).set({
          member_canonical: BOOTSTRAP_CANONICAL,
          member_name: 'Bootstrap Admin',
          scope: 'stake',
          type: 'manual',
          callings: [],
          duplicate_grants: [],
          building_names: ['Cordera Building'],
          granted_by_request: 'fake-req',
          created_at: new Date(),
          created_by: lastActorOf(personas.bootstrapAdmin),
          lastActor: lastActorOf(personas.bootstrapAdmin),
        }),
      );
    });

    it('bootstrap admin cannot delete the stake doc', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(STAKE_PATH).set(freshStakeDoc());
      });
      const db = bootstrapAdminContext(env).firestore();
      await assertFails(db.doc(STAKE_PATH).delete());
    });

    it('bootstrap admin cannot create a fresh stake doc (only superadmin can)', async () => {
      // The stake doc is the rule-engine's only key into the gate;
      // creating a fresh stake doc would be self-authorising. Create
      // is locked to superadmin so the operator's pre-seed remains
      // the single source of truth for `bootstrap_admin_email`.
      const db = bootstrapAdminContext(env).firestore();
      await assertFails(
        db.doc('stakes/brand-new-stake').set(freshStakeDoc({ stake_id: 'brand-new-stake' })),
      );
    });
  });
});
