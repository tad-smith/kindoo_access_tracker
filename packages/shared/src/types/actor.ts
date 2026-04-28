// `ActorRef` — the `{ email, canonical }` pair that every domain doc
// carries on `lastActor` (the rules' integrity-check field per
// `firebase-schema.md` §6.1) and on history-style fields like
// `granted_by`, `last_modified_by`, `added_by`, etc.
//
// Centralised here so a doc-type author writes
// `last_modified_by: ActorRef` instead of redeclaring the shape on every
// type. The `email` half is the typed-form display string (whatever
// Firebase Auth handed us); the `canonical` half is the canonicalised
// form per `packages/shared/canonicalEmail.ts`.

export type ActorRef = {
  /** Typed display email — preserves casing + dots + +suffix. */
  email: string;
  /** Canonical form (lowercased, gmail-normalised). Trusted comparison key. */
  canonical: string;
};
