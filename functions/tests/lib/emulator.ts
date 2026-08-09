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
import { canonicalEmail } from '@kindoo/shared';
import { expect } from 'vitest';

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

/** The per-file budget for one Eventarc delivery. See {@link waitForDelivery}. */
export const DELIVERY_WAIT_MS = 40_000;

let abandoned = false;

/**
 * True once a delivery wait in this file has run its full budget. Callers
 * read it BEFORE their own wait, so a short-circuited result can be
 * reported as "skipped" rather than mis-attributed to their own trigger.
 */
export function deliveryWaitsAbandoned(): boolean {
  return abandoned;
}

/**
 * {@link waitFor} for an Eventarc-delivered write, with a latch.
 *
 * Once one such wait has run its full budget, the trigger has stopped
 * delivering rather than merely slowed, and every later wait in this file
 * would burn the same budget to reach the same answer. That is not
 * hypothetical arithmetic: the integration suite runs strictly serially
 * (`fileParallelism: false`, `maxWorkers: 1`), makes ~44 of these waits,
 * and `test.yml` caps the whole `test` job at 20 minutes — so an
 * unlatched 40s budget is ~31 minutes of pure waiting, and the job is
 * cancelled with no test name at all. That is strictly worse to diagnose
 * than the flake this helper exists to prevent, and it lands from causes
 * as ordinary as `KINDOO_SKIP_CLAIM_SYNC` reappearing in the wrong env
 * file or an unpinned `firebase-tools` regressing v1 auth emulation.
 *
 * So the first exhausted wait latches and later ones return `false`
 * immediately. Every test still fails on its own named assertion; they
 * just stop paying for a verdict already reached. Module scope means the
 * latch is per test file (vitest isolates modules), which bounds the
 * worst case at one full budget per file.
 *
 * ONLY for predicates whose staying false means "nothing was delivered".
 * A predicate that can legitimately stay false while delivery is healthy
 * — {@link claimsAfterClear}, where a false is a real regression in the
 * handler's clear path — must not latch, or one genuine failure converts
 * every later settle in the file into a mislabelled one.
 */
export async function waitForDelivery(
  predicate: () => Promise<boolean>,
  timeoutMs: number = DELIVERY_WAIT_MS,
): Promise<boolean> {
  if (abandoned) return false;
  const ok = await waitFor(predicate, timeoutMs);
  if (!ok) abandoned = true;
  return ok;
}

/**
 * Poll until the caller's stake block is gone, returning the LAST claims
 * object read so the caller asserts on a value — `expect(false).toBe(true)`
 * names nothing, and the claims object is what made T-95 diagnosable.
 *
 * Why polling: the two-phase clear tests race the DEPLOYED role-sync
 * trigger that phase one's write queued. That delivery (D1) reads role
 * data, then writes claims; if its read lands before phase two's write but
 * its write lands after phase two's in-process `runSync`, it restamps the
 * block just cleared. `claimsEqual` does not short-circuit that — it
 * compares D1's own freshly-read `existing` against its `merged`, which
 * differ in precisely that ordering. Phase two's own delivery (D2)
 * normally undoes it, so recovery means waiting out a full delivery, hence
 * the same {@link DELIVERY_WAIT_MS} budget as a settle.
 *
 * Deliberately does NOT use {@link waitForDelivery}. This predicate stays
 * false when the clear path is genuinely broken — which is exactly what
 * these tests are for — so latching on it would blame `onAuthUserCreate`
 * for every later settle in the file. It cannot run away either: the
 * block is cleared synchronously by the in-process `runSync` before this
 * is called, so the first read returns and the poll is only ever entered
 * when a live delivery restamped it.
 *
 * NOT a guarantee, and the residue is not something polling can fix: if D2
 * loads `existing` after `runSync` cleared the block but before D1
 * restamps it, `merged === existing`, `claimsEqual` short-circuits, D2
 * writes nothing, and the restamp is terminal. That needs D1's write to
 * land after D2's read despite a head start. Written down rather than
 * closed, because closing it means settling D1 before phase two and D1's
 * write is byte-identical to the in-process one preceding it — there is
 * nothing to observe.
 */
export async function claimsAfterClear(uid: string): Promise<{ stakes?: unknown } | undefined> {
  const { auth } = requireEmulators();
  const read = async () =>
    (await auth.getUser(uid)).customClaims as { stakes?: unknown } | undefined;
  let last = await read();
  if (last?.stakes === undefined) return last;
  await waitFor(async () => {
    last = await read();
    return last?.stakes === undefined;
  }, DELIVERY_WAIT_MS);
  return last;
}

/**
 * Create an Auth user and, when the Functions emulator is live, wait out
 * `onAuthUserCreate`'s async baseline claim write (its `applyFullClaims`
 * stamping `{ canonical }`) before returning. CI's integration config
 * (`--only firestore,auth,functions`) has that v1 auth trigger live, so
 * a synchronous claim write made right after plain `auth.createUser(...)`
 * races it and can be silently clobbered a few hundred ms later — the
 * trigger writes exactly once per user, so once its baseline has landed
 * it can't overwrite a later write. `test:integration:local` boots only
 * firestore+auth, so the trigger never fires; pass the caller's snapshot
 * of {@link hasFunctionsEmulator} (probed once at module load, per the
 * suite-lifetime note on that function) so this stays correct there too.
 */
export async function makeSettledUser(
  email: string,
  functionsEmulatorReachable: boolean,
): Promise<string> {
  const { auth } = requireEmulators();
  const user = await auth.createUser({ email });
  if (functionsEmulatorReachable) {
    // `onAuthUserCreate` stamps `canonical` via `canonicalize()`
    // (lowercase + Gmail-alias folding), not the typed email verbatim —
    // compare against the same canonical form so a mixed-case `email`
    // (e.g. a test distinguishing `adminA@`/`adminB@`) still settles.
    const wantCanonical = canonicalEmail(email);
    // `DELIVERY_WAIT_MS` (40s) matches `syncSuperadminClaims.e2e.test.ts`,
    // which polls a byte-identical predicate and whose docblock rejects a
    // 25s budget as flake-prone against the ~14.7s delivery measured on
    // this runner (~60% used). Callers size their `timeout:` to the SUM of
    // their waits; the poll exits as soon as the claim lands, so the happy
    // path stays sub-second.
    const wasAbandoned = deliveryWaitsAbandoned();
    const seeded = await waitForDelivery(async () => {
      const u = await auth.getUser(user.uid);
      return ((u.customClaims ?? {}) as { canonical?: string }).canonical === wantCanonical;
    });
    expect(
      seeded,
      wasAbandoned
        ? 'skipped: an earlier delivery wait in this file exhausted its budget'
        : `onAuthUserCreate never delivered its baseline claim for ${wantCanonical}`,
    ).toBe(true);
  }
  return user.uid;
}
