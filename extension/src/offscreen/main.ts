// SPIKE — the offscreen document itself. Not wired into remote apply;
// see extension/docs/offscreen-listener-spike.md.
//
// This page exists to answer two questions and produce a log the
// operator can read hours later:
//
//   1. Does Firebase Auth rehydrate across the SW → offscreen boundary?
//      Both contexts are `chrome-extension://<id>`, and Auth persists to
//      IndexedDB per origin, so `getAuth()` here MAY find the session the
//      service worker already established. If it does not, the fallback
//      is to read the SW's cached Google access token out of
//      `chrome.storage.local` and mint a credential here. Both paths are
//      implemented and the log says which one ran — that is the
//      measurement, not an accident of defensive coding.
//
//   2. Does the document survive? Chrome's docs say only AUDIO_PLAYBACK
//      has an automatic lifetime limit. That is a claim about the API,
//      not proof the browser will not reap this under memory pressure or
//      across an update. So: a heartbeat every two minutes, and a boot
//      line that reports the gap since the previous context's last
//      event. A dying document cannot finish an async storage write on
//      its way out, so the gap on the NEXT boot is the durable evidence,
//      not any teardown handler.
//
// Deliberately inert. The listener logs and messages the SW. It never
// claims a job, never provisions, never touches the existing poll loop.
//
// Entry point note: this is a document context, so it uses the regular
// `firebase/auth` entry point. `firebase/auth/web-extension` — which
// `lib/firebase.ts` must use because it runs in the service worker —
// pins persistence to indexedDB only. The regular build's chain is
// [indexedDB, localStorage, sessionStorage] and searches all of them for
// an existing user, so it is a superset of what the SW wrote.

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  collection,
  getFirestore,
  limit,
  onSnapshot,
  query,
  where,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';
import { canonicalEmail } from '@kindoo/shared';
import { STORAGE_KEYS, type PrincipalSnapshot } from '../lib/messaging';
import {
  humanDuration,
  logSpike,
  readLastSpikeEvent,
  SPIKE_HEARTBEAT_MS,
  type SpikeSnapshotPush,
} from '../lib/spike';

// Duplicated from `lib/firebase.ts` rather than imported: that module
// pulls in `firebase/auth/web-extension` and calls `initializeApp` for
// the SW's singletons. Importing it here would drag the wrong Auth build
// into this bundle. A shared config module is the production fix; for a
// spike, six lines of duplication beat touching a production file.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
};

/** Matches `REMOTE_APPLY_JOB_QUERY_LIMIT` in `background/data.ts`. Same
 * ceiling on one result set, so the listener's initial-read cost is
 * directly comparable to one poll's. */
const JOB_QUERY_LIMIT = 20;

/** Backoff after `onSnapshot` hands us an error. `onSnapshot` has
 * already torn the listener down by then, so nothing re-attaches on its
 * own. Capped rather than unbounded: a listener that gave up after a
 * long outage would silently answer question 2 with a false negative. */
const REATTACH_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

const bootAt = Date.now();

let listenerUnsub: Unsubscribe | null = null;
let listenerCanonical: string | null = null;
let snapshotCount = 0;
let lastSnapshotAt: number | null = null;
let reattachAttempt = 0;
let reattachTimer: ReturnType<typeof setTimeout> | null = null;

async function main(): Promise<void> {
  // Read the tail of the previous context's log BEFORE writing anything,
  // so a fresh boot can report how long the extension went unlistened.
  const previous = await readLastSpikeEvent();
  const gapMs = previous ? Date.now() - Date.parse(previous.at) : null;
  logSpike('offscreen', 'document.booted', {
    url: location.href,
    previousEventKind: previous?.kind ?? null,
    previousEventAt: previous?.at ?? null,
    gapSincePreviousEventMs: gapMs,
    gapSincePreviousEvent: gapMs === null ? null : humanDuration(gapMs),
    chromeVersion: navigator.userAgent,
  });

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

  await probeAuth(auth);

  onAuthStateChanged(auth, (user) => {
    if (user) {
      void attachListener(db, user);
      return;
    }
    detachListener('auth signed out');
  });

  startHeartbeat(auth);
  window.addEventListener('pagehide', () => {
    // Best effort only. The storage write behind this almost certainly
    // will not land — which is exactly why `document.booted` reports the
    // gap instead of relying on a farewell.
    logSpike('offscreen', 'document.pagehide', { upMs: Date.now() - bootAt });
  });
}

/**
 * Question 1, measured.
 *
 * Three outcomes, and keeping them apart is the whole point:
 *
 *   - a user arrives on the first `onAuthStateChanged` → rehydration
 *     works, and this is nearly free;
 *   - no user AND the SW has no principal snapshot in storage → nobody
 *     is signed in anywhere, so this run says nothing either way;
 *   - no user BUT the SW does have a principal snapshot → rehydration
 *     genuinely does not cross the boundary, and the token relay below
 *     is the real path.
 *
 * Collapsing the last two would let a signed-out profile masquerade as a
 * negative result.
 */
async function probeAuth(auth: Auth): Promise<void> {
  const startedAt = Date.now();
  const swPrincipal = await readPrincipalSnapshot();
  const first = await firstAuthState(auth);

  if (first) {
    logSpike('offscreen', 'auth.rehydrated', {
      path: 'indexeddb-rehydrate',
      uid: first.uid,
      email: first.email,
      matchesSwSnapshot: swPrincipal ? swPrincipal.uid === first.uid : null,
      tookMs: Date.now() - startedAt,
    });
    return;
  }

  if (!swPrincipal) {
    logSpike('offscreen', 'auth.noSessionAnywhere', {
      note: 'the SW has no principal snapshot either — sign in via the panel, then watch for auth.rehydrated',
      tookMs: Date.now() - startedAt,
    });
    return;
  }

  logSpike('offscreen', 'auth.notRehydrated', {
    swUid: swPrincipal.uid,
    swEmail: swPrincipal.email,
    tookMs: Date.now() - startedAt,
    note: 'the SW holds a session this document did not inherit — falling back to the token relay',
  });
  await tokenRelaySignIn(auth);
}

/**
 * Fallback path: re-mint a Firebase session here from the Google access
 * token the SW cached at sign-in.
 *
 * Reading `STORAGE_KEYS.googleAccessToken` directly is a knowing
 * violation of the one-owner-per-storage-key rule in extension/CLAUDE.md
 * — `lib/auth.ts` owns that key. A production version would route it
 * through the SW, or better, mint a fresh token rather than reuse a
 * cached one: this token was issued when the operator signed in and
 * Google access tokens expire in about an hour, so on any profile that
 * has been running a while this path is expected to fail. That expiry
 * problem is the real cost of the relay, and the log is where it shows up.
 */
async function tokenRelaySignIn(auth: Auth): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.googleAccessToken);
  const token: unknown = stored[STORAGE_KEYS.googleAccessToken];
  if (typeof token !== 'string' || token.length === 0) {
    logSpike('offscreen', 'auth.tokenRelayNoToken', {
      note: 'no cached Google access token — the relay has nothing to exchange',
    });
    return;
  }
  try {
    const result = await signInWithCredential(auth, GoogleAuthProvider.credential(null, token));
    logSpike('offscreen', 'auth.tokenRelaySignedIn', {
      path: 'token-relay',
      uid: result.user.uid,
      email: result.user.email,
    });
  } catch (err) {
    logSpike('offscreen', 'auth.tokenRelayFailed', {
      code: errorCode(err),
      message: err instanceof Error ? err.message : String(err),
      note: 'most likely an expired cached access token — see the comment on tokenRelaySignIn',
    });
  }
}

/** Resolve on the first `onAuthStateChanged`, which is the SDK's
 * hydration verdict rather than a timeout race. */
function firstAuthState(auth: Auth): Promise<User | null> {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      resolve(user);
    });
  });
}

async function readPrincipalSnapshot(): Promise<PrincipalSnapshot | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.principalSnapshot);
  const raw: unknown = stored[STORAGE_KEYS.principalSnapshot];
  if (typeof raw !== 'object' || raw === null) return null;
  return raw as PrincipalSnapshot;
}

/**
 * Same mailbox address the SW's poller uses: the canonical email off the
 * ID token's custom claim, falling back to a locally-computed one only
 * for the window before the sync triggers stamp it. Mirrors `readActor`
 * in `background/data.ts` — recomputing it locally can diverge from the
 * stored claim, and the rules compare against the claim.
 */
async function readCanonical(user: User): Promise<string | null> {
  if (!user.email) return null;
  const tokenResult = await user.getIdTokenResult();
  const claimed = (tokenResult.claims as { canonical?: string }).canonical;
  return claimed ?? canonicalEmail(user.email);
}

/**
 * Attach the listener this whole spike is about:
 * `remoteApply/{canonicalEmail}/jobs` where `status == 'queued'` — the
 * exact query `findQueuedRemoteApplyJobs` polls today, so the read
 * volumes are comparable.
 *
 * `includeMetadataChanges: true` so the log distinguishes a cached
 * result from a server one. Without it a listener that never actually
 * reached Firestore would look identical to a healthy quiet one, and
 * "quiet" is the state we are trying to prove is real.
 */
async function attachListener(db: Firestore, user: User): Promise<void> {
  const canonical = await readCanonical(user);
  if (!canonical) {
    logSpike('offscreen', 'listener.noCanonical', { uid: user.uid });
    return;
  }
  if (listenerUnsub && listenerCanonical === canonical) return;
  detachListener('re-attaching for a new principal');

  const path = `remoteApply/${canonical}/jobs`;
  const jobs = collection(db, 'remoteApply', canonical, 'jobs');
  const q = query(jobs, where('status', '==', 'queued'), limit(JOB_QUERY_LIMIT));

  listenerCanonical = canonical;
  listenerUnsub = onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      reattachAttempt = 0;
      snapshotCount += 1;
      lastSnapshotAt = Date.now();
      const event = logSpike('offscreen', 'listener.snapshot', {
        n: snapshotCount,
        docs: snap.size,
        fromCache: snap.metadata.fromCache,
        hasPendingWrites: snap.metadata.hasPendingWrites,
        changes: snap.docChanges().map((c) => `${c.type}:${c.doc.id}`),
        jobIds: snap.docs.map((d) => d.id),
        sinceBoot: humanDuration(Date.now() - bootAt),
      });
      const push: SpikeSnapshotPush = { type: 'spike.offscreen.snapshot', event };
      // Fire and forget. `background/messages.ts` answers anything with a
      // string `type`, so a reply always arrives and is always ignored.
      chrome.runtime.sendMessage(push).catch(() => undefined);
    },
    (err) => {
      // onSnapshot has already torn the listener down by the time this
      // fires, so clear our handle before scheduling a re-attach.
      listenerUnsub = null;
      listenerCanonical = null;
      logSpike('offscreen', 'listener.error', {
        code: errorCode(err),
        message: err.message,
        upSinceBoot: humanDuration(Date.now() - bootAt),
      });
      scheduleReattach(db, user);
    },
  );

  logSpike('offscreen', 'listener.attached', {
    path,
    filter: "status == 'queued'",
    limit: JOB_QUERY_LIMIT,
  });
}

function detachListener(why: string): void {
  if (!listenerUnsub) return;
  listenerUnsub();
  listenerUnsub = null;
  listenerCanonical = null;
  logSpike('offscreen', 'listener.detached', { why });
}

function scheduleReattach(db: Firestore, user: User): void {
  if (reattachTimer !== null) return;
  const index = Math.min(reattachAttempt, REATTACH_BACKOFF_MS.length - 1);
  const delay = REATTACH_BACKOFF_MS[index] ?? 300_000;
  reattachAttempt += 1;
  logSpike('offscreen', 'listener.reattachScheduled', { attempt: reattachAttempt, delayMs: delay });
  reattachTimer = setTimeout(() => {
    reattachTimer = null;
    void attachListener(db, user);
  }, delay);
}

/** The survival signal. Everything on this line is something that could
 * plausibly explain a silent listener, so a single heartbeat is enough
 * to tell "alive and idle" from "alive but broken". */
function startHeartbeat(auth: Auth): void {
  setInterval(() => {
    const upMs = Date.now() - bootAt;
    logSpike('offscreen', 'heartbeat', {
      up: humanDuration(upMs),
      upMs,
      listener: listenerUnsub ? 'attached' : 'detached',
      snapshots: snapshotCount,
      lastSnapshotAgo: lastSnapshotAt === null ? null : humanDuration(Date.now() - lastSnapshotAt),
      uid: auth.currentUser?.uid ?? null,
      online: navigator.onLine,
      visibility: document.visibilityState,
    });
  }, SPIKE_HEARTBEAT_MS);
}

function errorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}

void main().catch((err) => {
  logSpike('offscreen', 'document.bootFailed', {
    message: err instanceof Error ? err.message : String(err),
  });
});
