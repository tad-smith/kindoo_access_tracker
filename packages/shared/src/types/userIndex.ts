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
   * Per-channel notification preferences. Only `push.newRequest` ships
   * in v1; the nested shape leaves room for future categories without
   * a migration. `true` on subscribe = clicking "Enable" is the opt-in.
   */
  notificationPrefs?: {
    push?: {
      newRequest: boolean;
    };
  };
};
