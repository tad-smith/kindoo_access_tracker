// Barrel for the DIY Firestore hooks layer (D11). Replaces reactfire's
// `useFirestoreDocData` / `useFirestoreCollectionData` for live reads;
// adds a `useFirestoreOnce` helper for cursor-paginated reads (Phase 5
// Audit Log).
//
// Consumers in `features/*/hooks.ts` should import from here, not from
// the per-file modules. Keeps a single module boundary stable as we
// evolve the implementation.

export {
  useFirestoreDoc,
  type FirestoreDocResult,
  type UseFirestoreDocOptions,
} from './useFirestoreDoc.js';
export {
  useFirestoreCollection,
  type FirestoreCollectionResult,
  type UseFirestoreCollectionOptions,
} from './useFirestoreCollection.js';
export {
  useFirestoreOnce,
  type FirestoreOnceDocResult,
  type FirestoreOnceCollectionResult,
  type UseFirestoreOnceDocOptions,
  type UseFirestoreOnceCollectionOptions,
} from './useFirestoreOnce.js';
