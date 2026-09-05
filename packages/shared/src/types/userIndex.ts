// userIndex bridge type. Per `docs/firebase-schema.md` §3.1 — the
// canonical-email-keyed lookup that lets the claim-sync triggers
// translate a role-data write (keyed by canonical email) into the uid
// they need for `setCustomUserClaims`.
//
// The doc is written by `onAuthUserCreate` (first sign-in) and by the
// `bumpLastSignIn` callable (per-session, debounced ~1/hour). The two
// optional fields below (`fcmTokens`, `notificationPrefs`) are written
// directly by the user from the SPA — userIndex rules permit
// self-update of those keys only.

/**
 * Structural Timestamp shape. Both `firebase/firestore`'s `Timestamp`
 * (client) and `firebase-admin/firestore`'s `Timestamp` (server)
 * satisfy this — they share `toDate()` + `toMillis()` + numeric
 * fields. Declared inline so `@kindoo/shared` stays runtime-dep-free
 * (the shared package's CLAUDE.md forbids importing the firebase SDK
 * here; only consumers do).
 */
export interface TimestampLike {
  readonly seconds: number;
  readonly nanoseconds: number;
  toDate(): Date;
  toMillis(): number;
}

/**
 * `userIndex/{canonicalEmail}` document body. Doc ID = canonical email.
 *
 * `typedEmail` is preserved exactly as Firebase Auth returned it on
 * sign-in — useful for surfacing in the UI without round-tripping
 * through Auth, and for diagnosing duplicate-canonical collisions
 * (Q15 in `firebase-schema.md` §8.4) when two distinct Google
 * accounts canonicalise to the same key.
 */
export type UserIndexEntry = {
  uid: string;
  typedEmail: string;
  lastSignIn: TimestampLike;
  /**
   * FCM registration tokens keyed by stable per-device id. The deviceId
   * is generated client-side (UUID stored in `localStorage`) so the
   * same device always overwrites the same slot rather than
   * accumulating. Absent on docs from devices that never opted in.
   */
  fcmTokens?: Record<string, string>;
  /**
   * Per-channel notification preferences. Every category key is
   * optional and **absent reads as off** — a merge-write of one
   * category must be expressible without asserting anything about its
   * siblings, and an unanswered question must not read as "yes".
   * Consumers gate on `=== true`, never `!== false`.
   *
   * `push.newRequest` is the original category, opted into by the
   * Push Notifications panel's Enable button. `push.syncReminder` is
   * the daily nudge about temp seats that expired more than a day ago
   * and are still in SBA (T-103); it is a SEPARATE opt-in and is NOT
   * implied by `newRequest`, because the Enable button's copy promises
   * a notification "when a new access request is submitted" and
   * nothing beyond that. New and existing subscribers alike start off,
   * so there is nothing to backfill.
   *
   * Neither key gates email. Email has no per-user opt-in — only the
   * stake-level `notifications_enabled` kill-switch — so a manager who
   * never enables push still receives every notification by email.
   */
  notificationPrefs?: {
    push?: {
      newRequest?: boolean;
      syncReminder?: boolean;
    };
  };
};
