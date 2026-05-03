// FCM messaging wrapper. The push trigger calls `getMessaging()` here
// instead of importing `firebase-admin/messaging` directly so tests can
// swap in a fake without a network round-trip — same pattern as
// `lib/sheets.ts`.
//
// Unlike `firebase-admin/firestore`'s `getFirestore()` (which auto-inits
// from `GCLOUD_PROJECT`), `getMessaging()` requires an explicit
// `initializeApp()` first or it throws "default Firebase app does not
// exist". `ensureInit()` is idempotent and a no-op when another module
// (or the test harness) already set up the app.

import { getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging as adminGetMessaging } from 'firebase-admin/messaging';
import type { BatchResponse, MulticastMessage } from 'firebase-admin/messaging';

/** Surface the trigger consumes — narrower than full `Messaging` so tests can stub it. */
export type Sender = {
  sendEachForMulticast(message: MulticastMessage): Promise<BatchResponse>;
};

/**
 * Idempotent admin-app init. Exported for tests; the default sender
 * calls it before every send so the trigger doesn't have to.
 */
export function ensureAdminInit(): void {
  if (getApps().length === 0) initializeApp();
}

const defaultSender: Sender = {
  sendEachForMulticast: (message) => {
    ensureAdminInit();
    return adminGetMessaging().sendEachForMulticast(message);
  },
};

let activeSender: Sender = defaultSender;

/** Active sender — production goes through `firebase-admin/messaging`. */
export function getSender(): Sender {
  return activeSender;
}

/** Test hook — replace the active sender. Returns a restore function. */
export function _setSender(sender: Sender): () => void {
  const prev = activeSender;
  activeSender = sender;
  return () => {
    activeSender = prev;
  };
}
