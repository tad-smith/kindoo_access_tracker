// One-shot Firestore read, surfaced as a TanStack Query result. No
// live subscription; used by the Audit Log cursor pagination path
// where pagination does not compose with `onSnapshot`.
//
// Returns either a single doc (when given a `DocumentReference`) or a
// `T[]` (when given a `Query`). The discriminator is the runtime
// shape of the input — `DocumentReference` carries `.type === 'document'`
// in the modular SDK; `Query` carries `.type === 'query' | 'collection'`.
//
// Pattern: a real `queryFn` that calls `getDoc` / `getDocs` and
// resolves to a sentinel-wrapped value (`{ value }`). The wrapper
// keeps `undefined` representable as a resolved value (TanStack Query
// 5 disallows raw undefined). We unwrap on the way out so consumers
// see `data: T | undefined` (doc) or `data: readonly T[] | undefined`
// (query).

import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import {
  getDoc,
  getDocs,
  type DocumentReference,
  type FirestoreError,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { docKey, queryKey } from './queryKeys.js';

type DocCacheValue<T> = { kind: 'doc'; value: T | undefined };
type CollectionCacheValue<T> = { kind: 'collection'; value: readonly T[] | undefined };
type CacheValue<T> = DocCacheValue<T> | CollectionCacheValue<T>;

export type UseFirestoreOnceDocOptions<T> = Omit<
  UseQueryOptions<DocCacheValue<T>, FirestoreError, DocCacheValue<T>>,
  'queryKey' | 'queryFn' | 'enabled'
>;

export type UseFirestoreOnceCollectionOptions<T> = Omit<
  UseQueryOptions<CollectionCacheValue<T>, FirestoreError, CollectionCacheValue<T>>,
  'queryKey' | 'queryFn' | 'enabled'
>;

export type FirestoreOnceDocResult<T> = {
  data: T | undefined;
  error: FirestoreError | null;
  status: 'pending' | 'success' | 'error';
  isPending: boolean;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  isFetching: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
};

export type FirestoreOnceCollectionResult<T> = {
  data: readonly T[] | undefined;
  error: FirestoreError | null;
  status: 'pending' | 'success' | 'error';
  isPending: boolean;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  isFetching: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
};

/** One-shot read of a single document. */
export function useFirestoreOnce<T>(
  ref: DocumentReference<T> | null,
  options?: UseFirestoreOnceDocOptions<T>,
): FirestoreOnceDocResult<T>;

/** One-shot read of a collection / query. */
export function useFirestoreOnce<T>(
  query: Query<T> | null,
  options?: UseFirestoreOnceCollectionOptions<T>,
): FirestoreOnceCollectionResult<T>;

export function useFirestoreOnce<T>(
  refOrQuery: DocumentReference<T> | Query<T> | null,
  options?: unknown,
): FirestoreOnceDocResult<T> | FirestoreOnceCollectionResult<T> {
  const isDoc = refOrQuery !== null && isDocumentReference(refOrQuery);
  const enabled = refOrQuery !== null;

  // Single useQuery call covers both shapes. The result type is the
  // tagged union of doc / collection; we narrow on the way out via
  // the discriminator field.
  const result = useQuery<CacheValue<T>, FirestoreError, CacheValue<T>>({
    queryKey: cacheKeyFor(refOrQuery, isDoc),
    queryFn: async () => {
      if (!refOrQuery) {
        return { kind: 'doc', value: undefined } satisfies DocCacheValue<T>;
      }
      if (isDoc) {
        const snap = await getDoc(refOrQuery as DocumentReference<T>);
        return {
          kind: 'doc',
          value: snap.exists() ? snap.data() : undefined,
        } satisfies DocCacheValue<T>;
      }
      const snap = await getDocs(refOrQuery as Query<T>);
      return {
        kind: 'collection',
        value: snap.docs.map((d: QueryDocumentSnapshot<T>) => d.data()),
      } satisfies CollectionCacheValue<T>;
    },
    enabled,
    ...(options as object),
  });

  // Unwrap the cache value into the public result shape.
  const data = result.data;
  if (isDoc) {
    return {
      data: data?.kind === 'doc' ? data.value : undefined,
      error: result.error,
      status: result.status,
      isPending: result.isPending,
      isLoading: result.isLoading,
      isSuccess: result.isSuccess,
      isError: result.isError,
      isFetching: result.isFetching,
      fetchStatus: result.fetchStatus,
    } satisfies FirestoreOnceDocResult<T>;
  }
  return {
    data: data?.kind === 'collection' ? data.value : undefined,
    error: result.error,
    status: result.status,
    isPending: result.isPending,
    isLoading: result.isLoading,
    isSuccess: result.isSuccess,
    isError: result.isError,
    isFetching: result.isFetching,
    fetchStatus: result.fetchStatus,
  } satisfies FirestoreOnceCollectionResult<T>;
}

/**
 * Discriminate `DocumentReference` from `Query` at runtime. The
 * modular Firestore SDK tags refs with a string `type` field
 * (`'document'` for DocumentReference; `'query'` or `'collection'`
 * for Query / CollectionReference). We check for `'document'`.
 */
function isDocumentReference(
  refOrQuery: DocumentReference<unknown> | Query<unknown>,
): refOrQuery is DocumentReference<unknown> {
  const t = (refOrQuery as { type?: string }).type;
  return t === 'document';
}

function cacheKeyFor(
  refOrQuery: DocumentReference<unknown> | Query<unknown> | null,
  isDoc: boolean,
): readonly unknown[] {
  if (!refOrQuery) return NULL_KEY;
  return isDoc
    ? docKey(refOrQuery as DocumentReference<unknown>)
    : queryKey(refOrQuery as Query<unknown>);
}

const NULL_KEY = ['__kindoo_firestore__', 'once', '__null__'] as const;
