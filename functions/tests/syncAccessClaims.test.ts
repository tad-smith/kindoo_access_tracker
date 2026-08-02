// Integration tests for `syncAccessClaims`. Skipped if the emulators
// aren't advertised. Cases mirror the migration plan's enumeration:
// stake scope → stake claim, multi-ward → wards array, deletion →
// claim cleared, no userIndex → graceful no-op.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { syncAccessClaims } from '../src/triggers/syncAccessClaims.js';
import { computeStakeClaims, scopesFromAccessDoc } from '../src/lib/seedClaims.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

// Minimal event payload shape — the trigger only consults
// `event.params`; the doc body is reread from Firestore by
// `computeStakeClaims`. The cast through `unknown` is the cleanest way
// to feed `.run()` a structurally-sufficient event without
// constructing the full `Change<DocumentSnapshot>` (which requires
// reaching into firebase-admin internals).
const makeEvent = (stakeId: string, memberCanonical: string) =>
  ({
    params: { stakeId, memberCanonical },
    data: undefined,
  }) as unknown as Parameters<typeof syncAccessClaims.run>[0];

async function runSync(stakeId: string, memberCanonical: string): Promise<void> {
  await syncAccessClaims.run(makeEvent(stakeId, memberCanonical));
}

/** Manual grant carrying the D25 limited marker. */
const limitedGrant = (id: string) => ({ grant_id: id, reason: 'r', level: 'limited' });
/** Manual grant with no `level` — the ordinary full-tier shape. */
const fullGrant = (id: string) => ({ grant_id: id, reason: 'r' });

describe.skipIf(!hasEmulators())('syncAccessClaims', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  it('writes stake claim when access doc exists with stake-scope grant', async () => {
    const { auth, db } = requireEmulators();
    const user = await auth.createUser({ email: 'a@gmail.com' });
    await db
      .doc('userIndex/a@gmail.com')
      .set({ uid: user.uid, typedEmail: 'a@gmail.com', lastSignIn: new Date() });

    await db.doc('stakes/csnorth/access/a@gmail.com').set({
      importer_callings: { stake: ['Stake President'] },
      manual_grants: {},
    });
    await runSync('csnorth', 'a@gmail.com');

    const refreshed = await auth.getUser(user.uid);
    expect(refreshed.customClaims).toMatchObject({
      stakes: { csnorth: { stake: true, manager: false, wards: [] } },
    });
  });

  it('writes ward claims for multi-ward access (deduped, sorted)', async () => {
    const { auth, db } = requireEmulators();
    const user = await auth.createUser({ email: 'b@gmail.com' });
    await db
      .doc('userIndex/b@gmail.com')
      .set({ uid: user.uid, typedEmail: 'b@gmail.com', lastSignIn: new Date() });

    await db.doc('stakes/csnorth/access/b@gmail.com').set({
      importer_callings: { GE: ['Bishop'] },
      manual_grants: { CO: [{ grant_id: 'g1' }], GE: [{ grant_id: 'g2' }] },
    });
    await runSync('csnorth', 'b@gmail.com');

    const refreshed = await auth.getUser(user.uid);
    const claims = refreshed.customClaims as {
      stakes: { csnorth: { wards: string[] } };
    };
    expect(claims.stakes.csnorth.wards).toEqual(['CO', 'GE']);
  });

  it('clears the stake block when the access doc goes away', async () => {
    const { auth, db } = requireEmulators();
    const user = await auth.createUser({ email: 'c@gmail.com' });
    await db
      .doc('userIndex/c@gmail.com')
      .set({ uid: user.uid, typedEmail: 'c@gmail.com', lastSignIn: new Date() });
    // Stake-scope grant first; stake claim flips on.
    await db
      .doc('stakes/csnorth/access/c@gmail.com')
      .set({ importer_callings: { stake: ['Counselor'] } });
    await runSync('csnorth', 'c@gmail.com');
    expect(
      ((await auth.getUser(user.uid)).customClaims as { stakes?: Record<string, unknown> })?.stakes,
    ).toBeDefined();

    // Delete + re-fire trigger. Stake block goes away.
    await db.doc('stakes/csnorth/access/c@gmail.com').delete();
    await runSync('csnorth', 'c@gmail.com');
    const refreshed = await auth.getUser(user.uid);
    expect((refreshed.customClaims as { stakes?: unknown }).stakes).toBeUndefined();
  });

  it('preserves the manager bit when access changes (stake block recomputed in full)', async () => {
    // A user can be both a manager AND a stake-scope grant holder. A
    // write to access shouldn't clobber the manager flag (which lives
    // in a different collection). `computeStakeClaims` reads both so
    // the merged block is always self-consistent.
    const { auth, db } = requireEmulators();
    const user = await auth.createUser({ email: 'mix@gmail.com' });
    await db
      .doc('userIndex/mix@gmail.com')
      .set({ uid: user.uid, typedEmail: 'mix@gmail.com', lastSignIn: new Date() });
    await db.doc('stakes/csnorth/kindooManagers/mix@gmail.com').set({ active: true });
    // Now an access write fires. The trigger recomputes from both;
    // manager flag survives.
    await db
      .doc('stakes/csnorth/access/mix@gmail.com')
      .set({ importer_callings: { stake: ['HC'] } });
    await runSync('csnorth', 'mix@gmail.com');

    const refreshed = await auth.getUser(user.uid);
    expect(refreshed.customClaims).toMatchObject({
      stakes: { csnorth: { manager: true, stake: true, wards: [] } },
    });
  });

  it('no-ops gracefully when the user has not signed in (no userIndex)', async () => {
    // The access doc is written for a canonical that has no
    // userIndex entry yet (e.g., importer ran before the user signed
    // in for the first time). The trigger must NOT throw — when the
    // user signs in later, onAuthUserCreate seeds claims from the
    // existing role data.
    const { db } = requireEmulators();
    await db
      .doc('stakes/csnorth/access/ghost@gmail.com')
      .set({ importer_callings: { stake: ['Counselor'] } });
    await expect(runSync('csnorth', 'ghost@gmail.com')).resolves.toBeUndefined();
  });

  it('mints limited: true end-to-end for an all-limited access doc', async () => {
    const { auth, db } = requireEmulators();
    const user = await auth.createUser({ email: 'ltd@gmail.com' });
    await db
      .doc('userIndex/ltd@gmail.com')
      .set({ uid: user.uid, typedEmail: 'ltd@gmail.com', lastSignIn: new Date() });

    await db.doc('stakes/csnorth/access/ltd@gmail.com').set({
      importer_callings: {},
      manual_grants: { GE: [limitedGrant('g1')] },
    });
    await runSync('csnorth', 'ltd@gmail.com');

    const refreshed = await auth.getUser(user.uid);
    expect(refreshed.customClaims).toMatchObject({
      stakes: { csnorth: { manager: false, stake: false, wards: ['GE'], limited: true } },
    });
  });
});

// --- D25 limited access -----------------------------------------------
//
// `limited` is true iff the user holds >=1 grant and EVERY grant across
// every scope is limited. The failure direction is toward FULL: a
// malformed grant entry must never be read as a restriction.
//
// Pure function — no emulator needed, so this block runs everywhere.
describe('scopesFromAccessDoc — limited tier', () => {
  it('all-limited manual grants in one scope => limited', () => {
    expect(
      scopesFromAccessDoc({
        importer_callings: {},
        manual_grants: { GE: [limitedGrant('g1'), limitedGrant('g2')] },
      }),
    ).toEqual({ hasStake: false, wards: ['GE'], limited: true });
  });

  it('all-limited manual grants across stake + ward scopes => limited', () => {
    expect(
      scopesFromAccessDoc({
        manual_grants: {
          stake: [limitedGrant('g1')],
          GE: [limitedGrant('g2')],
          CO: [limitedGrant('g3')],
        },
      }),
    ).toEqual({ hasStake: true, wards: ['CO', 'GE'], limited: true });
  });

  it('any importer calling is full tier under the shipped (empty) set', () => {
    expect(
      scopesFromAccessDoc({
        importer_callings: { GE: ['Bishop'] },
        manual_grants: {},
      }),
    ).toEqual({ hasStake: false, wards: ['GE'], limited: false });
  });

  it('importer calling present in an INJECTED limited set => limited', () => {
    // Proves the Elders-Quorum-President follow-up path before the
    // shipped `LIMITED_ACCESS_CALLINGS` set is populated. Match is on
    // the trim+lowercase key, so display casing on either side is fine.
    const injected = new Set(['Elders Quorum President']);
    expect(
      scopesFromAccessDoc(
        { importer_callings: { GE: ['  elders quorum PRESIDENT '] }, manual_grants: {} },
        injected,
      ),
    ).toEqual({ hasStake: false, wards: ['GE'], limited: true });
  });

  it('importer calling outside the injected limited set => full', () => {
    const injected = new Set(['Elders Quorum President']);
    expect(scopesFromAccessDoc({ importer_callings: { GE: ['Bishop'] } }, injected).limited).toBe(
      false,
    );
  });

  it('limited grant in one scope + full grant in another => full', () => {
    expect(
      scopesFromAccessDoc({
        manual_grants: { GE: [limitedGrant('g1')], CO: [fullGrant('g2')] },
      }),
    ).toEqual({ hasStake: false, wards: ['CO', 'GE'], limited: false });
  });

  it('mixed limited + full within a single scope array => full', () => {
    expect(
      scopesFromAccessDoc({
        manual_grants: { GE: [limitedGrant('g1'), fullGrant('g2')] },
      }).limited,
    ).toBe(false);
  });

  it('limited manual grant + full importer calling => full', () => {
    expect(
      scopesFromAccessDoc({
        importer_callings: { GE: ['Bishop'] },
        manual_grants: { GE: [limitedGrant('g1')] },
      }).limited,
    ).toBe(false);
  });

  it.each([
    ['null entry', null],
    ['string entry', 'limited'],
    ['array entry', ['limited']],
    ['missing level', { grant_id: 'g' }],
    ["level: 'full'", { grant_id: 'g', level: 'full' }],
    ["level: 'LIMITED' (wrong case)", { grant_id: 'g', level: 'LIMITED' }],
    ['level: true', { grant_id: 'g', level: true }],
  ])('malformed manual grant (%s) counts as full', (_label, entry) => {
    expect(scopesFromAccessDoc({ manual_grants: { GE: [entry] } }).limited).toBe(false);
    // ...and it still counts as a grant for scope purposes.
    expect(scopesFromAccessDoc({ manual_grants: { GE: [entry] } }).wards).toEqual(['GE']);
  });

  it('non-string importer entries count as full', () => {
    const injected = new Set(['Elders Quorum President']);
    expect(
      scopesFromAccessDoc(
        { importer_callings: { GE: [null, 'Elders Quorum President'] } },
        injected,
      ).limited,
    ).toBe(false);
  });

  it('empty and absent docs report no grant, hence not limited', () => {
    expect(scopesFromAccessDoc(undefined)).toEqual({ hasStake: false, wards: [], limited: false });
    expect(scopesFromAccessDoc({})).toEqual({ hasStake: false, wards: [], limited: false });
    expect(
      scopesFromAccessDoc({ importer_callings: { GE: [] }, manual_grants: { stake: [] } }),
    ).toEqual({ hasStake: false, wards: [], limited: false });
    // Non-object maps are still tolerated.
    expect(scopesFromAccessDoc({ importer_callings: 'nope', manual_grants: 42 })).toEqual({
      hasStake: false,
      wards: [],
      limited: false,
    });
  });
});

describe.skipIf(!hasEmulators())('computeStakeClaims — limited tier', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  it('omits limited when the user is an ACTIVE manager', async () => {
    // A manager row is a full-trust role and the rules' manager
    // `add_manual` carve-out depends on it, so an active manager is
    // never limited no matter what their access doc says.
    const { db } = requireEmulators();
    await db.doc('stakes/csnorth/kindooManagers/m@gmail.com').set({ active: true });
    await db
      .doc('stakes/csnorth/access/m@gmail.com')
      .set({ importer_callings: {}, manual_grants: { GE: [limitedGrant('g1')] } });

    const block = await computeStakeClaims('csnorth', 'm@gmail.com');
    expect(block).toEqual({ manager: true, stake: false, wards: ['GE'] });
    expect('limited' in block).toBe(false);
  });

  it('sets limited when the manager row exists but is INACTIVE', async () => {
    const { db } = requireEmulators();
    await db.doc('stakes/csnorth/kindooManagers/x@gmail.com').set({ active: false });
    await db
      .doc('stakes/csnorth/access/x@gmail.com')
      .set({ importer_callings: {}, manual_grants: { GE: [limitedGrant('g1')] } });

    const block = await computeStakeClaims('csnorth', 'x@gmail.com');
    expect(block).toEqual({ manager: false, stake: false, wards: ['GE'], limited: true });
  });

  it('leaves an ordinary full user block byte-identical to today', async () => {
    // Token-churn guard: `applyClaims.claimsEqual` is a canonical-JSON
    // compare, so a `limited: false` key here would read as a claim
    // change and revoke every existing user's refresh token on deploy.
    const { db } = requireEmulators();
    await db
      .doc('stakes/csnorth/access/full@gmail.com')
      .set({ importer_callings: { stake: ['Stake President'] }, manual_grants: {} });

    const block = await computeStakeClaims('csnorth', 'full@gmail.com');
    expect(block).toEqual({ manager: false, stake: true, wards: [] });
    expect('limited' in block).toBe(false);
    expect(Object.keys(block).sort()).toEqual(['manager', 'stake', 'wards']);
  });
});
