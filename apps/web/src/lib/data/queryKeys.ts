// Cache-key derivation for the DIY Firestore hooks.
//
// `useFirestoreDoc` / `useFirestoreCollection` / `useFirestoreOnce` all
// push their snapshots into the TanStack Query cache via
// `setQueryData(key, data)`. The key has to be:
//   - Stable across re-renders for the same Firestore ref/query (so a
//     remounted hook re-finds the data already in cache).
//   - Unique enough that a doc and a collection at the same path don't
//     collide.
//   - Unique enough that two queries with different `where` clauses
//     against the same collection don't collide.
//
// Firestore's modular SDK exposes a stable internal path on
// `DocumentReference` (the `.path` getter) and on `Query` (via
// `query._query` / `_queryOptions`, which is implementation-detail).
// Rather than reach into private fields, we use the public `.path`
// for `DocumentReference` and `CollectionReference`, and we hash a
// JSON-stringified summary of the query's filters/orders for non-
// collection `Query` objects. The summary is computed by walking the
// query via `JSON.stringify`-able helpers — but the Firestore Query
// object is not directly serialisable, so for queries we fall back to
// a stable identity provided by the caller (the query reference
// itself). React's `useMemo`/`useEffect` deps already keep it stable
// per-render; the cache-key just needs to differ between distinct
// query *objects*. Co-location of the path provides enough uniqueness
// at our scale (one query per route, well-defined per-component).

import type { DocumentReference, Query } from 'firebase/firestore';

/**
 * Stable cache key prefix used for all DIY-hook entries. Lets consumers
 * invalidate every Firestore-backed cache entry with one `invalidateQueries`
 * call without nuking unrelated TanStack Query state.
 */
export const FIRESTORE_QUERY_KEY_PREFIX = '__kindoo_firestore__' as const;

/**
 * Derive a cache key for a `DocumentReference`. Uses the public `.path`
 * (e.g. `stakes/csnorth/seats/abc`) so two refs to the same doc share a
 * cache entry across remounts.
 */
export function docKey(ref: DocumentReference<unknown>): readonly unknown[] {
  return [FIRESTORE_QUERY_KEY_PREFIX, 'doc', ref.path] as const;
}

/**
 * Derive a cache key for a `Query`. Collection refs expose `.path` via
 * the `CollectionReference` subtype; bare `Query` objects don't, so we
 * use a per-instance sentinel injected via a `WeakMap` (each new query
 * object gets a new sentinel, so distinct query objects collide only
 * if a caller passes the same reference to two hooks — which is
 * exactly when sharing the cache is correct).
 *
 * Phase 5+ pages that build queries inside `useMemo` get stable keys
 * for free. Pages that rebuild a query every render get a fresh key
 * every render — that's a caller bug, not a hook bug.
 */
export function queryKey(query: Query<unknown>): readonly unknown[] {
  // CollectionReference exposes `.path`; Query doesn't.
  const path = (query as unknown as { path?: string }).path;
  if (typeof path === 'string' && path.length > 0) {
    return [FIRESTORE_QUERY_KEY_PREFIX, 'query', path, identityFor(query)] as const;
  }
  return [FIRESTORE_QUERY_KEY_PREFIX, 'query', identityFor(query)] as const;
}

/**
 * Per-instance sentinel for a `Query` object. Two distinct query
 * objects get distinct sentinels even when they describe the same
 * filter set; same query object across renders gets the same sentinel.
 */
const identityCache = new WeakMap<object, number>();
let nextIdentity = 0;
function identityFor(query: Query<unknown>): number {
  const cached = identityCache.get(query as unknown as object);
  if (cached !== undefined) return cached;
  const id = ++nextIdentity;
  identityCache.set(query as unknown as object, id);
  return id;
}
