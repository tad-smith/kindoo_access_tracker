// The platform-superadmin per-stake READ surface, in one place (T-91).
//
// A superadmin holding no role on a stake can reach that stake's
// Configuration page (`spec.md` §15 "Home Kindoo Site surface"), and
// every tab there reads a sub-collection. The grant is deliberately
// partial: five collections yes, seats and requests no — those carry
// member names and emails, and widening them would hand every
// superadmin the roster of every stake.
//
// The negatives are the point of this file as much as the positives.
// The natural next step when a tab renders blank is to widen one more
// collection; these pin the two that must stay shut.

import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  clearAll,
  lastActorOf,
  personas,
  seedAsAdmin,
  setupTestEnv,
  superadminContext,
} from './lib/rules.js';

const STAKE_ID = 'csnorth';

/** Collections the superadmin MAY read, with a minimal seed doc each. */
const ALLOWED: Array<{ label: string; path: string; doc: Record<string, unknown> }> = [
  {
    label: 'wards',
    path: `stakes/${STAKE_ID}/wards/maple`,
    doc: { ward_code: 'maple', ward_name: 'Maple', building_name: 'Maple Building', seat_cap: 30 },
  },
  {
    label: 'buildings',
    path: `stakes/${STAKE_ID}/buildings/maple-building`,
    doc: { building_id: 'maple-building', building_name: 'Maple Building', address: '1 Main' },
  },
  {
    label: 'kindooManagers',
    path: `stakes/${STAKE_ID}/kindooManagers/mgr@gmail.com`,
    doc: { member_canonical: 'mgr@gmail.com', name: 'A Manager', active: true },
  },
  {
    label: 'kindooSites',
    path: `stakes/${STAKE_ID}/kindooSites/east-stake`,
    doc: { id: 'east-stake', display_name: 'East Stake', kindoo_expected_site_name: 'East' },
  },
  {
    label: 'organizations',
    path: `stakes/${STAKE_ID}/organizations/scouts`,
    doc: { organization_id: 'scouts', name: 'Scouts', seat_cap: 10 },
  },
];

/** Collections the superadmin must NOT read — member PII. */
const DENIED: Array<{ label: string; path: string; doc: Record<string, unknown> }> = [
  {
    label: 'seats',
    path: `stakes/${STAKE_ID}/seats/member@example.com`,
    doc: {
      member_canonical: 'member@example.com',
      member_email: 'member@example.com',
      member_name: 'A Member',
      scope: 'maple',
      type: 'manual',
    },
  },
  {
    label: 'requests',
    path: `stakes/${STAKE_ID}/requests/req1`,
    doc: {
      member_email: 'member@example.com',
      member_name: 'A Member',
      status: 'pending',
      scope: 'maple',
    },
  },
];

describe('firestore.rules — platform-superadmin per-stake read surface', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('superadmin-reads');
  });
  afterEach(async () => {
    await clearAll(env);
  });
  afterAll(async () => {
    await env.cleanup();
  });

  for (const { label, path, doc } of ALLOWED) {
    it(`superadmin with no per-stake role can read ${label}`, async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(path)
          .set({ ...doc, lastActor: lastActorOf(personas.manager) });
      });
      const db = superadminContext(env).firestore();
      await assertSucceeds(db.doc(path).get());
    });
  }

  for (const { label, path, doc } of DENIED) {
    it(`superadmin with no per-stake role is DENIED ${label} (member PII)`, async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(path)
          .set({ ...doc, lastActor: lastActorOf(personas.manager) });
      });
      const db = superadminContext(env).firestore();
      await assertFails(db.doc(path).get());
    });
  }

  // Reads widened; writes did not. Asserted on EVERY collection, not a
  // sample — `kindooManagers` especially: a widened read sits next to
  // the one write path that mints a manager claim
  // (`syncManagersClaims`), so "can read it now" must not drift into
  // "can write it now".
  for (const { label, path, doc } of ALLOWED) {
    it(`the read grant on ${label} does not carry a write grant`, async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx
          .firestore()
          .doc(path)
          .set({ ...doc, lastActor: lastActorOf(personas.manager) });
      });
      const db = superadminContext(env).firestore();
      await assertFails(db.doc(path).set({ ...doc, lastActor: lastActorOf(personas.superadmin) }));
    });
  }
});
