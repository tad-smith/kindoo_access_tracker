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
// emulator-driven CI run picks them up.

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

/** Delete every Auth user + Firestore doc in the named project.
 *
 * Firestore clear: hit the emulator's REST `DELETE …/databases/(default)/documents`
 * endpoint directly rather than relying on `db.recursiveDelete()`.
 * `recursiveDelete` walks the tree client-side via a `BulkWriter`; under
 * back-to-back-test load on CI the promise has been observed to resolve
 * before all rows are fully gone, leaving leftover audit rows visible to
 * the next test's reads (the "expected length 1 but got 2" flake in
 * `auditTrigger.test.ts`, seen across `B-5 follow-up`, idempotency, and
 * out-of-band tests). The REST endpoint blocks until the emulator has
 * dropped its in-memory store — synchronous and atomic.
 *
 * NOTE on the cross-file LEFTOVER race: in the CI integration config
 * (`--only firestore,auth,functions`) every write to an audited entity
 * doc under a shared stake (`csnorth`) fires the DEPLOYED `auditXxxWrites`
 * trigger, which fans an `auditLog` row ASYNCHRONOUSLY via Eventarc. A row
 * whose trigger was still queued when this blow-away ran lands a few
 * hundred ms LATER — after `clearEmulators()` returned — and bleeds into
 * the next file's `stakes/csnorth/auditLog` reads. `clearEmulators()`
 * cannot close that window: a single blow-away can't catch a write that
 * hasn't happened yet, and polling for *absence* can't prove "no more
 * coming" (a fast trigger burst can deliver in gaps). So the fix lives on
 * the READ side instead — audit-row-counting assertions scope to exactly
 * the row under test (a dedicated stake id, an action/request-id filter,
 * or a deterministic `auditId(time, suffix)` doc id) rather than reading
 * the whole shared-stake collection. See `auditTrigger.test.ts` (private
 * `audit-trigger-suite` stake), `notifyOnRequestWrite.test.ts`
 * (`readEmailFailedAudits` request-id filter), and the
 * `markRequestComplete` / `syncApplyFix` audit smoke checks (doc-id reads).
 */
export async function clearEmulators(): Promise<void> {
  const { auth } = requireEmulators();
  // Auth: list+delete in batches.
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    if (page.users.length > 0) {
      await auth.deleteUsers(page.users.map((u) => u.uid));
    }
    pageToken = page.pageToken;
  } while (pageToken);

  // Firestore: REST blow-away. `FIRESTORE_EMULATOR_HOST` is
  // `host:port` (asserted by `hasEmulators()` above). Project ID is the
  // one Admin SDK already resolved.
  const host = process.env['FIRESTORE_EMULATOR_HOST']!;
  const url = `http://${host}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`clearEmulators(Firestore) failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Probe the Functions emulator on the conventional localhost:5001 port.
 * Returns true iff the port answers.
 *
 * The CI integration run boots `--only firestore,auth,functions`, so the
 * `onAuthUserCreate` v1 auth trigger is live and fires (asynchronously,
 * via Eventarc) on every `auth.createUser(...)` — its `applyFullClaims`
 * write then races any in-process claim write a test makes right after
 * `createUser`. The local-only run (`test:integration:local`) boots only
 * firestore + auth, so the trigger never fires. Tests that set claims
 * shortly after `createUser` use this probe to wait for the trigger's
 * baseline write to settle first (closing the lost-update window) only
 * when the trigger is actually live.
 *
 * The probe uses a short AbortController timeout because the connection
 * either lands immediately or fails immediately; there is no slow path on
 * a healthy emulator.
 */
export async function hasFunctionsEmulator(): Promise<boolean> {
  if (!hasEmulators()) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    // Any HTTP response (even 404) counts as "alive"; we only care that
    // the socket accepts connections.
    await fetch('http://127.0.0.1:5001/', { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll `predicate` every `intervalMs` until it returns true or the
 * deadline elapses. Returns whether it became true. Used to wait for an
 * eventually-consistent emulator state (an Eventarc-delivered trigger
 * write, a claim round-trip) without an arbitrary fixed sleep.
 */
export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
