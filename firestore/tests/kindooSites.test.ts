// Rules tests for `stakes/{stakeId}/kindooSites/{kindooSiteId}` per
// `firebase-schema.md` §4.11 (Kindoo Sites).
//
// Read: any stake member (manager, stake-scope, or bishopric).
// Write: managers only, with `lastActor` integrity check.
//
// This file also covers the per-doc `kindoo_site_id` field additions
// on `wards/{wardCode}` and `buildings/{buildingId}` — the write path
// is unchanged (manager-only with `lastActorMatchesAuth`), but a
// dedicated test pins that a manager can set / clear the new field
// and a non-manager cannot.
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
const SITE_ID = 'east-stake';
const PATH = `stakes/${STAKE_ID}/kindooSites/${SITE_ID}`;
const OTHER_PATH = `stakes/someother/kindooSites/${SITE_ID}`;

function freshSiteDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: SITE_ID,
    display_name: 'East Stake (Foothills Building)',
    kindoo_expected_site_name: 'East Stake',
    kindoo_eid: 4321,
    created_at: new Date(),
    last_modified_at: new Date(),
    lastActor: lastActorOf(personas.manager),
    ...overrides,
  };
}

describe('firestore.rules — stakes/{sid}/kindooSites/{kindooSiteId}', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('kindoo-sites');
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
        await ctx.firestore().doc(PATH).set(freshSiteDoc());
      });
      await assertSucceeds(managerContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('stake member can read', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshSiteDoc());
      });
      await assertSucceeds(stakeMemberContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('bishopric member can read', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshSiteDoc());
      });
      await assertSucceeds(bishopricContext(env, STAKE_ID, ['01']).firestore().doc(PATH).get());
    });

    it('outsider denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshSiteDoc());
      });
      await assertFails(outsiderContext(env, STAKE_ID).firestore().doc(PATH).get());
    });

    it('anonymous denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshSiteDoc());
      });
      await assertFails(unauthedContext(env).firestore().doc(PATH).get());
    });

    it('cross-stake denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(OTHER_PATH).set(freshSiteDoc());
      });
      await assertFails(managerContext(env, STAKE_ID).firestore().doc(OTHER_PATH).get());
    });
  });

  describe('write', () => {
    it('manager create with matching lastActor → ok', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(PATH).set(freshSiteDoc()));
    });

    it('manager update an existing site → ok', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshSiteDoc());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db
          .doc(PATH)
          .set(freshSiteDoc({ display_name: 'East Stake (Foothills Building, renamed)' })),
      );
    });

    it('manager delete → ok', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshSiteDoc());
      });
      await assertSucceeds(managerContext(env, STAKE_ID).firestore().doc(PATH).delete());
    });

    it('manager write with bad lastActor → denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db
          .doc(PATH)
          .set(
            freshSiteDoc({ lastActor: { email: 'Wrong@gmail.com', canonical: 'wrong@gmail.com' } }),
          ),
      );
    });

    it('stake-scope member cannot write', async () => {
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(freshSiteDoc({ lastActor: lastActorOf(personas.stakeMember) })),
      );
    });

    it('stake-scope member cannot delete', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PATH).set(freshSiteDoc());
      });
      await assertFails(stakeMemberContext(env, STAKE_ID).firestore().doc(PATH).delete());
    });

    it('bishopric member cannot write', async () => {
      const db = bishopricContext(env, STAKE_ID, ['01']).firestore();
      await assertFails(
        db.doc(PATH).set(freshSiteDoc({ lastActor: lastActorOf(personas.bishopric) })),
      );
    });

    it('outsider cannot write', async () => {
      const db = outsiderContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PATH).set(freshSiteDoc({ lastActor: lastActorOf(personas.outsider) })),
      );
    });

    it('anonymous cannot write', async () => {
      const db = unauthedContext(env).firestore();
      await assertFails(db.doc(PATH).set(freshSiteDoc()));
    });

    it('cross-stake manager cannot write', async () => {
      const db = managerContext(env, 'demo-other-stake').firestore();
      await assertFails(db.doc(PATH).set(freshSiteDoc()));
    });
  });

  // ----- `kindoo_site_id` on wards / buildings -----
  // The new optional field rides on the existing wards / buildings
  // write predicate. Tests pin that the field passes through cleanly
  // (manager can set, manager can clear via null, non-managers
  // denied).
  describe('wards.kindoo_site_id', () => {
    const WARD_PATH = `stakes/${STAKE_ID}/wards/07`;

    function wardDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
      return {
        ward_code: '07',
        ward_name: '7th Ward',
        building_name: 'Foothills Building',
        seat_cap: 30,
        created_at: new Date(),
        last_modified_at: new Date(),
        lastActor: lastActorOf(personas.manager),
        ...overrides,
      };
    }

    it('manager can set kindoo_site_id to a foreign-site id', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(WARD_PATH).set(wardDoc({ kindoo_site_id: SITE_ID })));
    });

    it('manager can set kindoo_site_id to null (home site)', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(WARD_PATH).set(wardDoc({ kindoo_site_id: null })));
    });

    it('stake-scope member cannot update kindoo_site_id', async () => {
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(WARD_PATH).set(
          wardDoc({
            kindoo_site_id: SITE_ID,
            lastActor: lastActorOf(personas.stakeMember),
          }),
        ),
      );
    });
  });

  describe('buildings.kindoo_site_id', () => {
    const BUILDING_PATH = `stakes/${STAKE_ID}/buildings/foothills-building`;

    function buildingDoc(
      overrides: Partial<Record<string, unknown>> = {},
    ): Record<string, unknown> {
      return {
        building_id: 'foothills-building',
        building_name: 'Foothills Building',
        address: '4321 Foothills Pkwy',
        created_at: new Date(),
        last_modified_at: new Date(),
        lastActor: lastActorOf(personas.manager),
        ...overrides,
      };
    }

    it('manager can set kindoo_site_id to a foreign-site id', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(BUILDING_PATH).set(buildingDoc({ kindoo_site_id: SITE_ID })));
    });

    it('manager can set kindoo_site_id to null (home site)', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(BUILDING_PATH).set(buildingDoc({ kindoo_site_id: null })));
    });

    it('bishopric member cannot update kindoo_site_id', async () => {
      const db = bishopricContext(env, STAKE_ID, ['07']).firestore();
      await assertFails(
        db.doc(BUILDING_PATH).set(
          buildingDoc({
            kindoo_site_id: SITE_ID,
            lastActor: lastActorOf(personas.bishopric),
          }),
        ),
      );
    });
  });
});
