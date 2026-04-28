// Live Firestore document subscription, surfaced as a TanStack Query
// result. Replaces reactfire's `useFirestoreDocData` (D11).
//
// Pattern: subscribe via `onSnapshot(ref)` in a `useEffect`; on each
// snapshot, push a sentinel-wrapped doc value into the TanStack Query
// cache via `setQueryData`; consumers read the cache via `useQuery`,
// which we then unwrap so they see the standard
// `{ data, status, error, isLoading, ... }` shape.
//
// Why the sentinel wrapper: TanStack Query 5 disallows `undefined` as a
// resolved query value (it's the "still loading" sentinel internally).
// A doc that doesn't exist is a legitimate "loaded, no data" state, so
// we wrap it as `{ value: T | undefined }` in the cache and unwrap on
// the way out. The queryFn is a no-op that resolves to a placeholder
// wrapper; the real data comes from `setQueryData` inside the
// `onSnapshot` callback.
//
// Lifecycle invariants:
//   - Null `ref`            → status `'pending'`, data `undefined`,
//                              query disabled (no listener attached).
//   - First snapshot lands  → status flips to `'success'` with the doc data.
//   - Doc doesn't exist     → `data` is `undefined`; status stays `'success'`.
//                              Consumers check `!data` to render "not found".
//   - Listener errors       → status `'error'`, `error` carries the
//                              `FirestoreError`; cleanup still runs on unmount.
//   - `ref` changes         → previous subscription torn down before
//                              the next one starts. No leaked listeners.

import { useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { onSnapshot, type DocumentReference, type FirestoreError } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { docKey } from './queryKeys.js';

/**
 * Subset of TanStack Query options forwarded by the hook. We block
 * `queryKey` / `queryFn` / `enabled` — those are owned by the hook.
 */
export type UseFirestoreDocOptions<T> = Omit<
  UseQueryOptions<DocCacheValue<T>, FirestoreError, DocCacheValue<T>>,
  'queryKey' | 'queryFn' | 'enabled'
>;

/** Wrapper used in the cache so `undefined` (doc-not-found) is representable. */
type DocCacheValue<T> = { value: T | undefined };

/** Public result shape — TanStack Query result with `data: T | undefined`. */
export type FirestoreDocResult<T> = {
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

/**
 * Subscribe to a Firestore document. Returns the standard TanStack
 * Query result shape. When `ref` is null the query is disabled and
 * `data` is `undefined`.
 */
export function useFirestoreDoc<T>(
  ref: DocumentReference<T> | null,
  options?: UseFirestoreDocOptions<T>,
): FirestoreDocResult<T> {
  const queryClient = useQueryClient();
  const [listenerError, setListenerError] = useState<FirestoreError | null>(null);

  const key = ref ? docKey(ref) : NULL_DOC_KEY;

  useEffect(() => {
    if (!ref) {
      setListenerError(null);
      return;
    }

    setListenerError(null);
    const unsubscribe = onSnapshot(
      ref,
      (snapshot) => {
        const value = snapshot.exists() ? snapshot.data() : undefined;
        queryClient.setQueryData<DocCacheValue<T>>(docKey(ref), { value });
      },
      (err) => {
        setListenerError(err);
      },
    );

    return () => {
      unsubscribe();
    };
  }, [ref, queryClient]);

  // Placeholder queryFn that never resolves. The listener inside the
  // `useEffect` above is the actual source of data; it pushes via
  // `setQueryData`, transitioning the query from `pending` to
  // `success`. If we let the queryFn resolve (with `undefined` or any
  // placeholder) it would race the listener and clobber freshly-
  // arrived snapshot data.
  const result = useQuery<DocCacheValue<T>, FirestoreError, DocCacheValue<T>>({
    queryKey: key,
    queryFn: () => new Promise<DocCacheValue<T>>(() => {}),
    enabled: ref !== null,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    gcTime: Infinity,
    ...options,
  });

  if (listenerError) {
    return {
      data: undefined,
      error: listenerError,
      status: 'error',
      isPending: false,
      isLoading: false,
      isSuccess: false,
      isError: true,
      isFetching: false,
      fetchStatus: 'idle',
    };
  }

  return {
    data: result.data?.value,
    error: result.error,
    status: result.status,
    isPending: result.isPending,
    isLoading: result.isLoading,
    isSuccess: result.isSuccess,
    isError: result.isError,
    isFetching: result.isFetching,
    fetchStatus: result.fetchStatus,
  };
}

const NULL_DOC_KEY = ['__kindoo_firestore__', 'doc', '__null__'] as const;
