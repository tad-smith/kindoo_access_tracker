// Live Firestore collection / query subscription, surfaced as a
// TanStack Query result. Replaces reactfire's
// `useFirestoreCollectionData` (D11).
//
// Same pattern as `useFirestoreDoc`: `onSnapshot(query)` in a
// `useEffect`, snapshot data pushed into the TanStack Query cache via
// `setQueryData` (wrapped in a `{ value }` sentinel so undefined is
// representable), consumers read via `useQuery` and we unwrap on the
// way out.
//
// Referential stability: when a snapshot arrives whose docs are
// element-wise shallow-equal to the previously-cached array, we keep
// the previous array reference. Downstream `useMemo` / list-render
// stability falls out for free.

import { useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import {
  onSnapshot,
  type FirestoreError,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { queryKey } from './queryKeys.js';

type CollectionCacheValue<T> = { value: readonly T[] | undefined };

export type UseFirestoreCollectionOptions<T> = Omit<
  UseQueryOptions<CollectionCacheValue<T>, FirestoreError, CollectionCacheValue<T>>,
  'queryKey' | 'queryFn' | 'enabled'
>;

export type FirestoreCollectionResult<T> = {
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

/**
 * Subscribe to a Firestore query. Returns the standard TanStack
 * Query result shape with `T[]` data. Null query → disabled + undefined.
 */
export function useFirestoreCollection<T>(
  query: Query<T> | null,
  options?: UseFirestoreCollectionOptions<T>,
): FirestoreCollectionResult<T> {
  const queryClient = useQueryClient();
  const [listenerError, setListenerError] = useState<FirestoreError | null>(null);

  const key = query ? queryKey(query) : NULL_QUERY_KEY;

  useEffect(() => {
    if (!query) {
      setListenerError(null);
      return;
    }

    setListenerError(null);
    const unsubscribe = onSnapshot(
      query,
      (snapshot) => {
        const next = snapshot.docs.map((d: QueryDocumentSnapshot<T>) => d.data());
        const cached = queryClient.getQueryData<CollectionCacheValue<T>>(queryKey(query));
        const prev = cached?.value;
        // Preserve referential stability when nothing changed at all.
        const out = arraysShallowEqual(prev, next) ? prev : next;
        queryClient.setQueryData<CollectionCacheValue<T>>(queryKey(query), { value: out });
      },
      (err) => {
        setListenerError(err);
      },
    );

    return () => {
      unsubscribe();
    };
  }, [query, queryClient]);

  // Placeholder queryFn that never resolves; the listener is the
  // source of truth. See `useFirestoreDoc.ts` for why a resolving
  // placeholder races the snapshot push.
  const result = useQuery<CollectionCacheValue<T>, FirestoreError, CollectionCacheValue<T>>({
    queryKey: key,
    queryFn: () => new Promise<CollectionCacheValue<T>>(() => {}),
    enabled: query !== null,
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

const NULL_QUERY_KEY = ['__kindoo_firestore__', 'query', '__null__'] as const;

/**
 * Shallow array equality — at our scale (250 seats max) the
 * O(n*keys) cost is negligible and the win in re-render avoidance is
 * measurable.
 */
function arraysShallowEqual<T>(prev: readonly T[] | undefined, next: readonly T[]): boolean {
  if (!prev || prev.length !== next.length) return false;
  for (let i = 0; i < next.length; i++) {
    if (!shallowEqual(prev[i], next[i])) return false;
  }
  return true;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) {
      return false;
    }
  }
  return true;
}
