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
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

/**
 * Probe the Functions emulator on the conventional localhost:5001 port.
 * Returns true iff the port answers — used to gate the suite so it
 * skips when only firestore + auth are up (e.g. `test:integration:local`).
 *
 * The probe uses a short AbortController timeout because the
 * connection either lands immediately or fails immediately; there is
 * no slow path on a healthy emulator.
 */
async function hasFunctionsEmulator(): Promise<boolean> {
  if (!hasEmulators()) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    // Any HTTP response (even 404) counts as "alive"; we only care
    // that the socket accepts connections.
    await fetch('http://127.0.0.1:5001/', { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll `predicate` every 250ms until it returns true or the deadline
 * elapses. Used to wait for the eventually-consistent trigger fire +
 * `setCustomUserClaims` round-trip.
 */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

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

  it('mints isPlatformSuperadmin=true when a platformSuperadmins doc is created', async () => {
    const { auth, db } = requireEmulators();
    const typedEmail = 'Super.Admin@gmail.com';
    const canonical = 'superadmin@gmail.com';

    const user = await auth.createUser({ email: typedEmail });
    await db.doc(`userIndex/${canonical}`).set({
      uid: user.uid,
      typedEmail,
      lastSignIn: FieldValue.serverTimestamp(),
    });

    // Real Firestore write that should fire `syncSuperadminClaims` via
    // Eventarc. Fields shadow `firebase-schema.md` §3.2: `email`
    // (typed), `addedAt` (server timestamp), `addedBy` (canonical
    // email of the actor — operator-as-bootstrap here).
    await db.doc(`platformSuperadmins/${canonical}`).set({
      email: typedEmail,
      addedAt: FieldValue.serverTimestamp(),
      addedBy: 'operator@example.com',
    });

    const flipped = await waitFor(async () => {
      const u = await auth.getUser(user.uid);
      const claims = (u.customClaims ?? {}) as { isPlatformSuperadmin?: boolean };
      return claims.isPlatformSuperadmin === true;
    }, 15_000);

    expect(flipped).toBe(true);
  });

  it('revokes isPlatformSuperadmin when the doc is deleted', async () => {
    const { auth, db } = requireEmulators();
    const typedEmail = 'Super.Admin@gmail.com';
    const canonical = 'superadmin@gmail.com';

    const user = await auth.createUser({ email: typedEmail });
    await db.doc(`userIndex/${canonical}`).set({
      uid: user.uid,
      typedEmail,
      lastSignIn: FieldValue.serverTimestamp(),
    });

    // Step 1: add the doc, wait for the claim to flip on.
    await db.doc(`platformSuperadmins/${canonical}`).set({
      email: typedEmail,
      addedAt: FieldValue.serverTimestamp(),
      addedBy: 'operator@example.com',
    });
    const minted = await waitFor(async () => {
      const u = await auth.getUser(user.uid);
      const claims = (u.customClaims ?? {}) as { isPlatformSuperadmin?: boolean };
      return claims.isPlatformSuperadmin === true;
    }, 15_000);
    expect(minted).toBe(true);

    // Step 2: delete the doc, wait for the claim to clear.
    await db.doc(`platformSuperadmins/${canonical}`).delete();
    const revoked = await waitFor(async () => {
      const u = await auth.getUser(user.uid);
      const claims = (u.customClaims ?? {}) as { isPlatformSuperadmin?: boolean };
      return claims.isPlatformSuperadmin !== true;
    }, 15_000);
    expect(revoked).toBe(true);
  });
});
