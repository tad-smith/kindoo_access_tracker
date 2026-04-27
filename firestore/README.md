# firestore/

Firestore Security Rules and composite-index declarations.

**Owner agent:** `backend-engineer`. See `firestore/CLAUDE.md` for conventions.

## Files

| File | Status (Phase 1) |
|---|---|
| `firestore.rules` | Lock-everything stub (`allow read, write: if false`). Real rules per `docs/firebase-schema.md` §6 land in **Phase 3**. |
| `firestore.indexes.json` | Empty `{ indexes: [], fieldOverrides: [] }`. Real composite indexes per `docs/firebase-schema.md` §5.1 land in **Phase 3**. |

## Why no indexes yet

Composite indexes are query-driven. Until queries exist (Phases 4+), there's nothing to index for. Single-field indexes are auto-created by Firestore on first query, so they don't need declaration here.

## Why locked-down rules

In Phase 1 there's no client code that should be doing client-side Firestore reads or writes. The `hello` callable (Phase 1) and seed data (Phase 2) come in through the Admin SDK, which bypasses rules entirely. Locking down rules forces an honest "the client cannot reach Firestore yet" until Phase 3 explicitly opens specific collections.
