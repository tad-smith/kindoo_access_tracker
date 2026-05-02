// FCM messaging wrapper. The push trigger calls `getMessaging()` here
// instead of importing `firebase-admin/messaging` directly so tests can
// swap in a fake without a network round-trip — same pattern as
// `lib/sheets.ts`.

import { getMessaging as adminGetMessaging } from 'firebase-admin/messaging';
import type { BatchResponse, MulticastMessage } from 'firebase-admin/messaging';

/** Surface the trigger consumes — narrower than full `Messaging` so tests can stub it. */
export type Sender = {
  sendEachForMulticast(message: MulticastMessage): Promise<BatchResponse>;
};

const defaultSender: Sender = {
  sendEachForMulticast: (message) => adminGetMessaging().sendEachForMulticast(message),
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
