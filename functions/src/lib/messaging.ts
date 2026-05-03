// FCM messaging wrapper. The push trigger calls `getMessaging()` here
// instead of importing `firebase-admin/messaging` directly so tests can
// swap in a fake without a network round-trip — same pattern as
// `lib/sheets.ts`.
//
// Unlike `firebase-admin/firestore`'s `getFirestore()` (which auto-inits
// from `GCLOUD_PROJECT`), `getMessaging()` requires an explicit
// default-app `initializeApp()` first or it throws "default Firebase app
// does not exist". `ensureAdminInit()` is idempotent and a no-op when
// another module (or the test harness) already set up the default app.
//
// Why we can't just check `getApps().length === 0`: firebase-functions
// v7 internally creates a NAMED app (`__FIREBASE_FUNCTIONS_SDK__`) when
// it builds the snapshot for an `onDocumentCreated` trigger and no
// default app exists yet. That makes `getApps()` non-empty, but the
// default app is still missing and `getMessaging()` still throws. The
// correct check is "does an app named `[DEFAULT]` exist?", not "are
// there any apps?".

import { getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging as adminGetMessaging } from 'firebase-admin/messaging';
import type { BatchResponse, MulticastMessage } from 'firebase-admin/messaging';
import { logger } from 'firebase-functions';

/** Surface the trigger consumes — narrower than full `Messaging` so tests can stub it. */
export type Sender = {
  sendEachForMulticast(message: MulticastMessage): Promise<BatchResponse>;
};

/** firebase-admin's internal default-app name; constants.ts not exported. */
const DEFAULT_APP_NAME = '[DEFAULT]';

/**
 * Idempotent default-app init. Exported for tests; the default sender
 * calls it before every send so the trigger doesn't have to.
 */
export function ensureAdminInit(): void {
  const before = getApps();
  const hasDefault = before.some((a) => a.name === DEFAULT_APP_NAME);
  logger.info('[messaging.ensureAdminInit] entry', {
    appsBefore: before.length,
    appNames: before.map((a) => a.name),
    hasDefault,
  });
  if (!hasDefault) {
    logger.info('[messaging.ensureAdminInit] no default app; calling initializeApp()');
    try {
      const app = initializeApp();
      logger.info('[messaging.ensureAdminInit] initializeApp() returned', {
        appName: app.name,
        appOptionsKeys: Object.keys(app.options ?? {}),
      });
    } catch (err) {
      logger.error('[messaging.ensureAdminInit] initializeApp() threw', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw err;
    }
  }
  const after = getApps();
  logger.info('[messaging.ensureAdminInit] exit', {
    appsAfter: after.length,
    appNames: after.map((a) => a.name),
  });
}

const defaultSender: Sender = {
  sendEachForMulticast: (message) => {
    logger.info('[messaging.defaultSender.sendEachForMulticast] entry', {
      tokenCount: message.tokens?.length ?? 0,
    });
    ensureAdminInit();
    logger.info('[messaging.defaultSender.sendEachForMulticast] calling adminGetMessaging()');
    const m = adminGetMessaging();
    logger.info('[messaging.defaultSender.sendEachForMulticast] got messaging client; sending');
    return m.sendEachForMulticast(message);
  },
};

let activeSender: Sender = defaultSender;

/** Active sender — production goes through `firebase-admin/messaging`. */
export function getSender(): Sender {
  logger.info('[messaging.getSender] called', {
    isDefault: activeSender === defaultSender,
  });
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
