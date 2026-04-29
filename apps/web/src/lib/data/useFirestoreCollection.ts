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
//
// Defensive guards mirror `useFirestoreDoc`: `onSnapshot` registration
// is wrapped in try/catch, the error callback logs the offending query
// path + Firestore error code, and `setQueryData` is itself wrapped to
// tolerate an unmount/cache-teardown race. See `useFirestoreDoc.ts`'s
// header for the full rationale and the link to the SDK panic these
// guards mitigate at the hook layer (the in-app error boundary in
// `main.tsx` catches the residual SDK-internal-assertion case).

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

    let unsubscribe: () => void;
    try {
      unsubscribe = onSnapshot(
        query,
        (snapshot) => {
          try {
            const next = snapshot.docs.map((d: QueryDocumentSnapshot<T>) => d.data());
            const cached = queryClient.getQueryData<CollectionCacheValue<T>>(queryKey(query));
            const prev = cached?.value;
            // Preserve referential stability when nothing changed at all.
            const out = arraysShallowEqual(prev, next) ? prev : next;
            queryClient.setQueryData<CollectionCacheValue<T>>(queryKey(query), { value: out });
          } catch (cacheErr) {
            console.warn('[useFirestoreCollection] cache write failed', {
              path: pathFor(query),
              cacheErr,
            });
          }
        },
        (err) => {
          console.error('[useFirestoreCollection] listener error', {
            path: pathFor(query),
            code: err.code,
            message: err.message,
          });
          setListenerError(err);
        },
      );
    } catch (subscribeErr) {
      console.error('[useFirestoreCollection] subscribe threw', {
        path: pathFor(query),
        subscribeErr,
      });
      setListenerError(coerceFirestoreError(subscribeErr));
      return;
    }

    return () => {
      try {
        unsubscribe();
      } catch (unsubscribeErr) {
        console.warn('[useFirestoreCollection] unsubscribe threw', {
          path: pathFor(query),
          unsubscribeErr,
        });
      }
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

/**
 * Best-effort path string for log lines. CollectionReference exposes
 * `.path`; bare Query objects don't. Returns `'<query>'` when the path
 * isn't accessible, so the log line stays readable.
 */
function pathFor(query: Query<unknown>): string {
  const path = (query as unknown as { path?: string }).path;
  return typeof path === 'string' && path.length > 0 ? path : '<query>';
}

function coerceFirestoreError(err: unknown): FirestoreError {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    return err as FirestoreError;
  }
  return Object.assign(new Error(String(err)), {
    name: 'FirestoreError',
    code: 'unknown',
  }) as unknown as FirestoreError;
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
