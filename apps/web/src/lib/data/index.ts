// Barrel for the DIY Firestore hooks layer (architecture D11). Live
// reads via `useFirestoreDoc` / `useFirestoreCollection`; one-shot
// reads (e.g. cursor pagination on the Audit Log) via
// `useFirestoreOnce`.
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
