// Helpers for talking to the Firebase Auth + Firestore emulators
// directly from Playwright tests. We use the emulators' REST APIs
// rather than the Admin SDK so the e2e workspace stays free of any
// Firebase-Admin dependency (the migration plan limits new top-level
// packages without a strong reason; the REST endpoints are stable).
//
// References:
//   - https://firebase.google.com/docs/emulator-suite/connect_auth#auth-emulator-rest-api
//   - https://firebase.google.com/docs/emulator-suite/connect_firestore#use_the_local_emulator_to_test_your_app
//
// Project ID: matches `VITE_FIREBASE_PROJECT_ID` (defaults to
// `kindoo-staging`); the emulators namespace data per project.
//
// Project + emulator hosts are env-overridable (defaults preserve the
// shared-stack behaviour). Pointing a run at a unique project / alternate
// ports gives it an isolated namespace, so a parallel run's
// `clearAuth()` / `clearFirestore()` can't wipe this run's seeded data
// mid-test. Set `E2E_FIREBASE_PROJECT`, `E2E_AUTH_HOST`,
// `E2E_FIRESTORE_HOST` to override.

const PROJECT_ID = process.env.E2E_FIREBASE_PROJECT ?? 'kindoo-staging';
const AUTH_HOST = process.env.E2E_AUTH_HOST ?? '127.0.0.1:9099';
const FIRESTORE_HOST = process.env.E2E_FIRESTORE_HOST ?? '127.0.0.1:8080';

/**
 * Reset all Auth emulator state. The emulator's clear endpoint deletes
 * every user in the project namespace. Safe to call between tests.
 */
export async function clearAuth(): Promise<void> {
  const url = `http://${AUTH_HOST}/emulator/v1/projects/${PROJECT_ID}/accounts`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`clearAuth failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Reset all Firestore emulator state. Safe to call between tests.
 */
export async function clearFirestore(): Promise<void> {
  const url = `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`clearFirestore failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Create a synthetic Auth user via the emulator's signUp endpoint. The
 * emulator accepts an arbitrary "API key" so we pass a placeholder.
 * Returns `{ uid, idToken }` — the token can be used to drive
 * `signInWithCustomToken` from the browser context if needed.
 */
export async function createAuthUser(opts: {
  email: string;
  displayName?: string;
}): Promise<{ uid: string; idToken: string; refreshToken: string }> {
  const url = `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: opts.email,
      password: 'test-password-12345',
      displayName: opts.displayName ?? opts.email,
      returnSecureToken: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`createAuthUser failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { localId: string; idToken: string; refreshToken: string };
  return { uid: body.localId, idToken: body.idToken, refreshToken: body.refreshToken };
}

/**
 * Set custom claims on an existing emulator user. We hit the Identity
 * Toolkit *server-side* `accounts:update` endpoint — the one Firebase
 * Admin SDK uses under the hood for `setCustomUserClaims`. The
 * client-side variant at `/v1/accounts:update?key=...` does NOT accept
 * `customAttributes` (the emulator returns 400 INVALID_REQ_TYPE);
 * `customAttributes` is privileged and only the project-scoped admin
 * route honours it. The Auth emulator accepts `Authorization: Bearer
 * owner` as a stand-in for real service-account credentials.
 *
 * Endpoint:
 *   POST http://{AUTH_HOST}/identitytoolkit.googleapis.com/v1/projects/{pid}/accounts:update
 *   Authorization: Bearer owner
 *   { localId, customAttributes }
 *
 * Reference: https://cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/update
 *
 * In production these are set by the `onAuthUserCreate` /
 * `syncAccessClaims` / `syncManagersClaims` triggers; in tests we set
 * them directly to simulate "trigger has run, claims are seeded".
 */
export async function setCustomClaims(uid: string, claims: object): Promise<void> {
  const url = `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:update`;
  const body = JSON.stringify({ localId: uid, customAttributes: JSON.stringify(claims) });
  // The Auth emulator's `accounts:signUp` can return before the user is
  // queryable by the admin `accounts:update` route under concurrent
  // load — the update then 400s with USER_NOT_FOUND. The user DOES
  // exist (signUp returned its uid); this is read-after-write
  // propagation lag, so a short bounded retry clears it. Also rides out
  // a brief emulator-restart window (transient fetch failure).
  let lastErr = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
        body,
      });
      if (res.ok) return;
      lastErr = `${res.status} ${await res.text()}`;
      // Only USER_NOT_FOUND is the propagation race worth retrying; any
      // other non-OK status is a real error — fail fast.
      if (!lastErr.includes('USER_NOT_FOUND')) break;
    } catch (e) {
      lastErr = String(e);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`setCustomClaims failed: ${lastErr}`);
}

/**
 * Write a Firestore doc via the emulator's REST API. Path is the full
 * doc path (e.g., `stakes/csnorth/kindooManagers/alice@example.com`).
 * Fields are converted to Firestore's typed-value envelope.
 *
 * The fixture's job is to seed test state cheaply — we want to write
 * docs that the production rules wouldn't permit (the rules require
 * manager claims + a `lastActor` integrity check on every write). We
 * pass `Authorization: Bearer owner`, which the Firestore emulator
 * recognises as service-account-equivalent credentials and applies
 * **without** evaluating Security Rules. This is the same bypass the
 * Admin SDK uses against the emulator. Reference:
 * https://firebase.google.com/docs/emulator-suite/connect_firestore#admin_sdks
 *
 * Phase 2 only writes simple string/bool/timestamp fields, so we keep
 * the converter minimal.
 */
export async function writeDoc(path: string, data: Record<string, unknown>): Promise<void> {
  const url = `http://${FIRESTORE_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`;
  const fields: Record<string, object> = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer owner',
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    throw new Error(`writeDoc(${path}) failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Read the customAttributes (custom claims) currently stamped on an
 * Auth-emulator user. Used by tests to poll for trigger-driven claim
 * propagation before driving the SPA — the Functions emulator runs
 * `onAuthUserCreate` / `syncManagersClaims` asynchronously after
 * sign-up returns; without polling, sign-in returns a token whose
 * claims haven't been stamped yet.
 */
export async function getCustomClaims(uid: string): Promise<Record<string, unknown>> {
  const url = `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:lookup`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer owner',
    },
    body: JSON.stringify({ localId: [uid] }),
  });
  if (!res.ok) {
    throw new Error(`getCustomClaims failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { users?: Array<{ customAttributes?: string }> };
  const raw = body.users?.[0]?.customAttributes;
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Poll `getCustomClaims` until the user's custom claims include a
 * `stakes` map containing `stakeId`. Drives the test past the
 * sign-up → onAuthUserCreate → setCustomUserClaims race.
 */
export async function waitForServerStakeClaim(
  uid: string,
  stakeId: string,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const claims = await getCustomClaims(uid);
    const stakes = claims['stakes'] as Record<string, unknown> | undefined;
    if (stakes && stakeId in stakes) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitForServerStakeClaim(${uid}, ${stakeId}) timed out after ${timeoutMs}ms; last claims: ${JSON.stringify(claims)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function toFirestoreValue(v: unknown): object {
  if (v === null) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(toFirestoreValue) } };
  }
  if (typeof v === 'object') {
    const fields: Record<string, object> = {};
    for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
      fields[k] = toFirestoreValue(inner);
    }
    return { mapValue: { fields } };
  }
  throw new Error(`Unsupported Firestore value type for: ${String(v)}`);
}
