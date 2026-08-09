// End-to-end test for `syncSuperadminClaims`. Companion to
// `syncSuperadminClaims.test.ts`, which exercises the handler via
// `.run(event)` invocation. This file proves the wiring all the way
// through: write a real Firestore doc against the emulator, let the
// Functions emulator's Eventarc plumbing route the write to the
// deployed-shape trigger, and assert the matching auth user's claim
// flipped via Admin SDK token refresh.
//
// 12.1 — Phase 12 (multi-stake) sub-deliverable. The trigger has been
// in the codebase since Phase 2 but had no production caller — the
// `platformSuperadmins` collection was empty by design. Phase 12's
// Stake List page (12.2) is the first reader of the
// `isPlatformSuperadmin` claim; before that lands, we lock in the
// trigger's actual deployed behaviour with an emulator-driven check.
//
// CI runs this under `firebase emulators:exec --only firestore,auth,functions`
// with `functions/lib/` built first (see `.github/workflows/test.yml`
// "Build functions for emulator" step, which is sequenced before
// "Integration tests" specifically so this and any future trigger-
// firing tests have a registered trigger to react to).
//
// Local invocation: `test:integration:local` boots only firestore +
// auth, so this suite skips locally. To run it locally, invoke
// `firebase emulators:exec --only firestore,auth,functions
// --project demo-kindoo-tests 'pnpm exec vitest run tests/'` from
// `functions/`.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import {
  clearEmulators,
  hasFunctionsEmulator,
  requireEmulators,
  waitForDelivery,
} from './lib/emulator.js';

// `await hasFunctionsEmulator()` would be ideal but `describe.skipIf`
// takes a synchronous predicate. We snapshot the result once at module
// load. The emulator either is or is not up for the lifetime of the
// suite — there's no in-flight transition we care about.
const functionsEmulatorReachable = await hasFunctionsEmulator();

describe.skipIf(!functionsEmulatorReachable)('syncSuperadminClaims (e2e)', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  // Vitest's default cap is 5s; an observed CI run on PR #153 measured
  // ~14.7s for Eventarc delete-event delivery alone, which makes a 25s
  // budget (~60% used) flake-prone if a runner regresses or emulator
  // delivery slows. Hence `DELIVERY_WAIT_MS` (40s) per wait — and a
  // per-test cap sized to the SUM of that test's waits, since these tests
  // make two and three of them. Each poll exits as soon as the claim
  // flips, so happy-path runtime is still typically <2s.

  it(
    'mints isPlatformSuperadmin=true when a platformSuperadmins doc is created',
    { timeout: 90_000 },
    async () => {
      const { auth, db } = requireEmulators();
      const typedEmail = 'Super.Admin.Mint@gmail.com';
      const canonical = 'superadminmint@gmail.com';

      // Order: createUser → wait for onAuthUserCreate to finish
      // seeding the baseline claim → THEN write the
      // `platformSuperadmins/{canonical}` doc and assert
      // `syncSuperadminClaims` flips the claim.
      //
      // Why this order (the test was previously
      // pre-seed-then-createUser, which flaked false under CI load):
      //
      //   `syncSuperadminClaims` — the trigger this file exists to
      //   exercise — only does real work once `uidForCanonical`
      //   resolves, i.e. once `onAuthUserCreate` has written
      //   `userIndex/{canonical}`. The old pre-seed ordering fired
      //   `syncSuperadminClaims` from the pre-seed write *before*
      //   that bridge existed, so it no-op'd permanently (one write =
      //   one Eventarc delivery, and a clean no-op return is not
      //   retried). That left `onAuthUserCreate` as the *sole* claim
      //   author. When its single async delivery ran slow on a loaded
      //   CI runner, nothing minted the claim inside the 40s budget
      //   and the assertion saw `false` — not slow propagation, a
      //   genuinely-never-written claim with no backup author.
      //
      //   Seeding `platformSuperadmins` *after* the bridge exists
      //   makes `syncSuperadminClaims` the deterministic, retry-backed
      //   author (it now finds the uid every time) and is the real
      //   production shape: a superadmin doc added to an
      //   already-signed-in user. The doc-write's Eventarc delivery is
      //   retried on transient failure, so there is no single-delivery
      //   cliff.
      //
      // Waiting for `customClaims.canonical` before seeding also
      // closes the lost-update window: it proves `onAuthUserCreate`'s
      // own `setCustomUserClaims` already landed, so it can't clobber
      // the superadmin flag `syncSuperadminClaims` is about to add.
      const user = await auth.createUser({ email: typedEmail });

      const seeded = await waitForDelivery(async () => {
        const u = await auth.getUser(user.uid);
        const claims = (u.customClaims ?? {}) as { canonical?: string };
        return claims.canonical === canonical;
      });
      expect(seeded).toBe(true);

      // Fields shadow `firebase-schema.md` §3.2: `email` (typed),
      // `addedAt` (server timestamp), `addedBy` (canonical email of
      // the actor — operator-as-bootstrap here).
      await db.doc(`platformSuperadmins/${canonical}`).set({
        email: typedEmail,
        addedAt: FieldValue.serverTimestamp(),
        addedBy: 'operator@example.com',
      });

      const flipped = await waitForDelivery(async () => {
        const u = await auth.getUser(user.uid);
        const claims = (u.customClaims ?? {}) as { isPlatformSuperadmin?: boolean };
        return claims.isPlatformSuperadmin === true;
      });

      expect(flipped).toBe(true);
    },
  );

  it('revokes isPlatformSuperadmin when the doc is deleted', { timeout: 130_000 }, async () => {
    const { auth, db } = requireEmulators();
    const typedEmail = 'Super.Admin.Revoke@gmail.com';
    const canonical = 'superadminrevoke@gmail.com';

    // Same create-first → wait-for-bridge → seed ordering as the mint
    // test (see its comment for the full rationale): make
    // `syncSuperadminClaims` the deterministic, retry-backed claim
    // author instead of leaving `onAuthUserCreate` as a sole
    // single-delivery author that flakes under CI load.
    const user = await auth.createUser({ email: typedEmail });

    const seeded = await waitForDelivery(async () => {
      const u = await auth.getUser(user.uid);
      const claims = (u.customClaims ?? {}) as { canonical?: string };
      return claims.canonical === canonical;
    });
    expect(seeded).toBe(true);

    await db.doc(`platformSuperadmins/${canonical}`).set({
      email: typedEmail,
      addedAt: FieldValue.serverTimestamp(),
      addedBy: 'operator@example.com',
    });

    // Step 1: wait for the mint to land via `syncSuperadminClaims`.
    const minted = await waitForDelivery(async () => {
      const u = await auth.getUser(user.uid);
      const claims = (u.customClaims ?? {}) as { isPlatformSuperadmin?: boolean };
      return claims.isPlatformSuperadmin === true;
    });
    expect(minted).toBe(true);

    // Step 2: delete the doc, wait for the claim to clear. Eventarc
    // delete-event delivery on CI was measured at ~14.7s on the PR
    // that introduced this test; 40s budget matches the mint test
    // for headroom against future runner regression.
    await db.doc(`platformSuperadmins/${canonical}`).delete();
    const revoked = await waitForDelivery(async () => {
      const u = await auth.getUser(user.uid);
      const claims = (u.customClaims ?? {}) as { isPlatformSuperadmin?: boolean };
      return claims.isPlatformSuperadmin !== true;
    });
    expect(revoked).toBe(true);
  });
});
