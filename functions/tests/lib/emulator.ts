// Test helpers for the Cloud Functions emulator suite.
//
// Each integration test file imports `requireEmulators()` and uses
// the returned `{ db, auth }` admin handles to seed Firestore + Auth
// state, then invokes the trigger under test via its `.run(event)`
// method (a property of `firebase-functions` v2 CloudFunctions; v1's
// equivalent is the same name).
//
// The `describe.skipIf(!hasEmulators())` guard at file scope means
// these tests pass cleanly on a developer machine without the
// emulators running (`pnpm test` from a fresh checkout); the
// emulator-driven CI run picks them up. The Phase 2 acceptance
// criteria require the suite to be exercised against the emulator
// before the seven proofs land.

import { initializeApp, getApps, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

const PROJECT_ID = process.env['GCLOUD_PROJECT'] ?? 'demo-kindoo-tests';

/** True iff the Firestore + Auth emulators are advertised by env vars. */
export function hasEmulators(): boolean {
  return (
    Boolean(process.env['FIRESTORE_EMULATOR_HOST']) &&
    Boolean(process.env['FIREBASE_AUTH_EMULATOR_HOST'])
  );
}

/**
 * Initialise (or reuse) the Admin SDK pointed at the emulators and
 * return Firestore + Auth handles. Throws if the emulators aren't
 * advertised — pair with the file-scope `describe.skipIf(!hasEmulators())`
 * so the throw never fires in skipped suites.
 */
export function requireEmulators(): { app: App; db: Firestore; auth: Auth } {
  if (!hasEmulators()) {
    throw new Error(
      'requireEmulators() called without FIRESTORE_EMULATOR_HOST/FIREBASE_AUTH_EMULATOR_HOST set. ' +
        'Run via `firebase emulators:exec --only firestore,auth ...` or set env vars manually.',
    );
  }
  // Make sure Admin SDK uses the same project the emulators are scoped
  // to. Setting GCLOUD_PROJECT ahead of `initializeApp()` is the
  // documented way; some local invocations forget to set it because
  // the emulator-exec step does.
  process.env['GCLOUD_PROJECT'] = PROJECT_ID;

  const app =
    getApps()[0] ??
    initializeApp({
      projectId: PROJECT_ID,
    });
  return { app, db: getFirestore(app), auth: getAuth(app) };
}

/** Delete every Auth user + Firestore doc in the named project. */
export async function clearEmulators(): Promise<void> {
  const { auth, db } = requireEmulators();
  // Auth: list+delete in batches.
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    if (page.users.length > 0) {
      await auth.deleteUsers(page.users.map((u) => u.uid));
    }
    pageToken = page.pageToken;
  } while (pageToken);

  // Firestore: recursively delete every collection. The emulator's
  // recursive delete REST endpoint isn't exposed via the Admin SDK
  // directly, but `recursiveDelete` covers it for collection roots.
  const collections = await db.listCollections();
  for (const c of collections) {
    await db.recursiveDelete(c);
  }
}
