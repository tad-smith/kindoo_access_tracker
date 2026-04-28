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

const PROJECT_ID = 'kindoo-staging';
const AUTH_HOST = '127.0.0.1:9099';
const FIRESTORE_HOST = '127.0.0.1:8080';

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
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer owner',
    },
    body: JSON.stringify({
      localId: uid,
      customAttributes: JSON.stringify(claims),
    }),
  });
  if (!res.ok) {
    throw new Error(`setCustomClaims failed: ${res.status} ${await res.text()}`);
  }
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
