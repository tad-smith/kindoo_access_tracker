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
  const startedAt = Date.now();
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
  // Hand the sweep whatever is left of the hook budget, so a slow Auth
  // half shrinks the sweep's slice instead of pushing the pair past the
  // hook timeout.
  await sweepFirestore(
    `http://${host}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { deadlineMs: Math.max(1_000, CLEAR_BUDGET_MS - (Date.now() - startedAt)) },
  );
}

/** Statuses the emulator returns for transient contention, not for a bad request. */
const RETRYABLE_SWEEP_STATUSES = new Set([409, 429, 503]);
const SWEEP_ATTEMPTS = 4;

/** `errno` codes that mean the connection dropped, not that nothing is listening. */
const RETRYABLE_FETCH_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT']);

/**
 * Whether a thrown `fetch` failure is worth another attempt.
 *
 * Treating every throw as transient is the expensive mistake here. If the
 * Firestore emulator is gone while Auth is still up — separate processes,
 * so the Auth half above succeeds and the sweep is still reached — `fetch`
 * rejects with `ECONNREFUSED` immediately. Retrying that costs four
 * attempts and ~700ms per call, and `clearEmulators` runs in
 * `beforeAll` / `afterEach` / `afterAll` across ~500 integration tests:
 * ~6 minutes of pure backoff added to a run that is already red, under a
 * 20-minute job cap. It threw in ~0ms before this helper existed.
 *
 * So: retry the deadline abort and connection drops; let everything else —
 * `ECONNREFUSED`, and programming errors like
 * `TypeError: Failed to parse URL` — fail on the first attempt.
 */
function isRetryableFetchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  const code = (err as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === 'string' && RETRYABLE_FETCH_CODES.has(code);
}

let sweepAbandoned = false;

/** Test-only: clear the {@link sweepFirestore} latch between cases. */
export function _resetSweepLatch(): void {
  sweepAbandoned = false;
}

/**
 * Wall-clock ceiling for a whole `clearEmulators` call, retries included.
 *
 * It runs in `afterEach`, and vitest's default `hookTimeout` is 10s — no
 * config here sets one, and no hook overrides it. An attempt-only bound
 * does not respect that: the thing being retried is by name a *timeout*
 * (`Transaction lock timeout`), so a failing attempt is not necessarily
 * fast. Overrunning the hook reports `Hook timed out in 10000ms` against
 * whatever unrelated test was running — losing the attempt count and body
 * this retry exists to produce, and landing exactly the misattributed
 * diagnosis it is meant to prevent, one layer up.
 *
 * 8.5s, not a rounder guess, because the budget has to be BIGGER than the
 * problem it covers. Measured against this emulator: the Auth half costs
 * ≤84ms and an uncontended sweep ≤50ms, so the hook normally finishes in
 * ~0.1s of its 10s. A tighter ceiling would convert the very case this
 * exists for — a sweep that blocks for seconds and then succeeds — from a
 * pass into a red abort. 8.5s keeps the abort a last resort while leaving
 * ~1.5s for vitest to report the informative failure.
 *
 * {@link clearEmulators} subtracts the Auth half's actual cost before
 * handing the remainder to {@link sweepFirestore}, so a slow Auth half
 * shrinks the sweep's slice rather than pushing the pair over.
 */
const CLEAR_BUDGET_MS = 8_500;

/**
 * `DELETE` the whole document tree, retrying transient contention.
 *
 * The emulator answers the sweep with `409 ABORTED — Transaction lock
 * timeout` rather than blocking when it contends with an in-flight write.
 * In this suite that write is almost always a deployed trigger's Eventarc
 * delivery arriving after the test that queued it — the same
 * "delivery outlives the test" family the {@link clearEmulators} docblock
 * describes, except this variant takes the SWEEP down (a thrown `afterEach`,
 * failing whichever test happens to be running) instead of leaking a row.
 * T-97, seen once in ~6 full runs.
 *
 * `ABORTED` is documented as retryable and the contending write is short,
 * so a few quick attempts clear it. Bounded twice over — by attempt count
 * and by {@link CLEAR_BUDGET_MS} wall-clock, because how long a
 * *contended* DELETE takes to answer is not known (the one sighting only
 * bounds it below 10s).
 *
 * Every retry is LOGGED rather than swallowed. A retry hides whatever held
 * the lock, and this sweep runs in `afterEach` of nearly every integration
 * test — if it starts needing three attempts routinely, that is a signal
 * about trigger fan-out, and it should not be invisible.
 *
 * `deadlineMs` exists so the deadline path is testable in milliseconds
 * rather than seconds; production callers use the default.
 */
export async function sweepFirestore(
  url: string,
  { deadlineMs = CLEAR_BUDGET_MS }: { deadlineMs?: number } = {},
): Promise<void> {
  // Same reasoning as `waitForDelivery` below: once a sweep has spent its
  // whole budget without the emulator answering at all, every later hook
  // in this file would pay the same budget to learn the same thing. Module
  // state is per test file (vitest isolates modules), so this bounds a
  // hung emulator at one budget per FILE — not per run. Every test still
  // fails, named, and immediately.
  if (sweepAbandoned) {
    throw new Error(
      'clearEmulators(Firestore) skipped: an earlier sweep exhausted its budget — ' +
        'the emulator is not answering, see the first failure for the response',
    );
  }
  const deadline = Date.now() + deadlineMs;
  // An abort is always terminal (it fires AT the deadline, so there is
  // never time for another attempt), and its message says only
  // "aborted due to timeout". Keeping the last real response means the
  // final error still carries the `Transaction lock timeout` body that
  // explains WHY the sweep was slow — the diagnostic this all exists for.
  let lastResponse: string | undefined;
  for (let attempt = 1; ; attempt++) {
    // Bound the ATTEMPT, not merely the decision to start another one.
    // The premise here is that a contended DELETE's duration is unknown,
    // so an unbounded `fetch` would let a single slow answer overrun the
    // hook budget no matter how few attempts were made.
    const remainingMs = Math.max(1, deadline - Date.now());
    let detail: string;
    let retryable: boolean;
    try {
      const res = await fetch(url, {
        method: 'DELETE',
        signal: AbortSignal.timeout(remainingMs),
      });
      if (res.ok) {
        if (attempt > 1) {
          console.warn(
            `clearEmulators(Firestore): swept on attempt ${attempt} of ${SWEEP_ATTEMPTS}`,
          );
        }
        return;
      }
      detail = `${res.status} ${await res.text()}`;
      lastResponse = detail;
      retryable = RETRYABLE_SWEEP_STATUSES.has(res.status);
    } catch (err) {
      // The deadline abort, or a transport failure such as a socket reset.
      // Both used to escape this loop and throw raw, with no attempt count
      // and no context. `isRetryableFetchError` keeps the fail-fast path
      // for the ones no amount of waiting fixes.
      detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      retryable = isRetryableFetchError(err);
    }

    const backoffMs = 100 * 2 ** (attempt - 1);
    const outOfTime = Date.now() + backoffMs >= deadline;
    if (attempt >= SWEEP_ATTEMPTS || outOfTime || !retryable) {
      const carried =
        lastResponse && lastResponse !== detail ? `; last response: ${lastResponse}` : '';
      // Latch only when the emulator never ANSWERED — hung or absent, the
      // runaway this guards. A 409 means it answered, just slowly, which is
      // the T-97 scenario itself: latching there would turn one failed test
      // into a failed file, all of them claiming "not answering" when it
      // demonstrably was. A fail-fast classification (a bad URL, a 400)
      // never latches either — that is this call's problem, not the
      // emulator's.
      if ((attempt >= SWEEP_ATTEMPTS || outOfTime) && lastResponse === undefined) {
        sweepAbandoned = true;
      }
      throw new Error(
        `clearEmulators(Firestore) failed after ${attempt} attempt(s)` +
          `${outOfTime ? ` (${deadlineMs}ms deadline)` : ''}: ${detail}${carried}`,
      );
    }
    console.warn(`clearEmulators(Firestore): ${detail} on attempt ${attempt}, retrying`);
    await new Promise((r) => setTimeout(r, backoffMs));
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
 * latch is per test file (vitest isolates modules).
 *
 * The two failure modes do NOT sum, because every test here performs a
 * latched settle BEFORE any non-latching wait, and a failed `expect`
 * aborts its test:
 *
 * - Delivery stopped → the first settle in each file spends one budget
 *   and latches; every later settle short-circuits and every test aborts
 *   before reaching a non-latching wait. ~7 files × 40s ≈ 4.7 min.
 * - Delivery healthy, a handler regressed → settles pass in milliseconds
 *   and only the non-latching waits spend anything. At most five are
 *   reachable (3 × `claimsAfterClear`, plus `flipped` / `minted` in the
 *   e2e file; `revoked` sits behind `minted`). ≈ 3.3 min.
 *
 * So ~4.7 min, well inside the 20-minute cap.
 *
 * What is NOT bounded: delivery that is uniformly SLOW rather than
 * stopped. Nothing latches, because every wait succeeds — just barely —
 * and ~44 near-budget waits would exceed the cap on their own. The latch
 * cannot help there; only lowering the budget or raising the cap would.
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
