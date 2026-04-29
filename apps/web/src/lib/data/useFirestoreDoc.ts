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
//
// Defensive layers around the SDK's `onSnapshot`:
//   - The `onSnapshot` *call* is wrapped in a try/catch. The modular
//     SDK can throw synchronously when the SDK is in a torn-down state
//     (HMR re-eval, double-mount in StrictMode, internal listener
//     registry inconsistency). A throw there must not unmount the tree.
//   - The effect deps are keyed on the doc *path string*, not on the
//     `DocumentReference` instance. Callers like
//     `useFirestoreDoc(stakeRef(db, STAKE_ID))` produce a fresh ref each
//     render; identity-keyed deps would tear down/re-subscribe on every
//     parent render, and a throw on subscribe would loop the tree
//     (setState → re-render → fresh ref → throws → setState …).
//   - A `useRef` latch records "subscribe already threw for this path"
//     so even within the same render pass we never retry a known-bad
//     subscribe; cleared when the path changes (e.g., on sign-out, or
//     when a new claim makes the read allowable).
//   - The error callback logs the offending path + Firestore error code
//     to the console so the operator can narrow which rule is denying.
//   - `setQueryData` is called inside try/catch since the cache may be
//     mid-teardown when an unmount races with a snapshot push.
//
// These guards do NOT catch the SDK's *internal-assertion* panic
// (`Unexpected state ID: ca9` / `b815`) — that throws from inside the
// SDK's microtask dispatch and propagates through the global error
// handler, not through our callback. The root error boundary in
// `main.tsx` catches that case and renders a fallback. Together the
// two layers turn a permission-denied subscribe into either a hook
// error state (the common case) or an in-app error fallback (the rare
// SDK-panic case) — never a blank page.

import { useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { onSnapshot, type DocumentReference, type FirestoreError } from 'firebase/firestore';
import { useEffect, useRef, useState } from 'react';
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

  // Effect identity is the doc path string, not the ref instance.
  // Callers like `useFirestoreDoc(stakeRef(db, STAKE_ID))` produce a
  // fresh `DocumentReference` each render; if we keyed the effect on
  // the ref, every parent re-render would tear down and re-subscribe.
  // Worse, a synchronous `onSnapshot` throw would `setState` →
  // re-render → fresh ref → effect re-runs → throws again, looping
  // until the browser locks up. Path-keyed deps make the effect run
  // once per logical doc.
  const path = ref?.path ?? null;
  // Read the latest ref through a mutable ref so the effect closure
  // always sees the current `DocumentReference` instance even when
  // identity churns across renders without the path changing.
  const refRef = useRef(ref);
  refRef.current = ref;

  // Sticky guard: if `onSnapshot` synchronously threw for this path,
  // don't retry until the path itself changes. Belt-and-braces with the
  // path-keyed deps above; the deps stop the loop, this stops a stale
  // closure or StrictMode double-invoke from re-attempting a known-bad
  // subscribe within the same render pass.
  const subscribeFailedForPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!path) {
      setListenerError(null);
      subscribeFailedForPathRef.current = null;
      return;
    }

    if (subscribeFailedForPathRef.current === path) return;

    setListenerError(null);

    const liveRef = refRef.current;
    if (!liveRef) return;

    // `onSnapshot` returns synchronously in normal operation, but can
    // throw under the SDK's internal-state edge cases (HMR re-eval,
    // double-mount during StrictMode, listener registry race on
    // permission-denied). Convert any synchronous throw into a hook
    // error state so a single failed listener can't tear the tree down.
    let unsubscribe: () => void;
    try {
      unsubscribe = onSnapshot(
        liveRef,
        (snapshot) => {
          try {
            const value = snapshot.exists() ? snapshot.data() : undefined;
            queryClient.setQueryData<DocCacheValue<T>>(docKey(liveRef), { value });
          } catch (cacheErr) {
            // Cache write failure during unmount race; drop silently.
            // The unsubscribe in the cleanup below will fire next.
            console.warn('[useFirestoreDoc] cache write failed', { path, cacheErr });
          }
        },
        (err) => {
          // Surface the failing path + code so the operator can pin the
          // offending rule the next time the SDK trips this. Log once
          // per error rather than on every re-render to keep the
          // console useful.
          console.error('[useFirestoreDoc] listener error', {
            path,
            code: err.code,
            message: err.message,
          });
          setListenerError(err);
        },
      );
    } catch (subscribeErr) {
      console.error('[useFirestoreDoc] subscribe threw', { path, subscribeErr });
      subscribeFailedForPathRef.current = path;
      setListenerError(coerceFirestoreError(subscribeErr));
      return;
    }

    return () => {
      try {
        unsubscribe();
      } catch (unsubscribeErr) {
        // Best-effort teardown; an SDK-internal throw on unsubscribe
        // shouldn't propagate through the React effect cleanup chain.
        console.warn('[useFirestoreDoc] unsubscribe threw', {
          path,
          unsubscribeErr,
        });
      }
    };
  }, [path, queryClient]);

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

/**
 * Coerce an unknown thrown value into a `FirestoreError` shape so the
 * hook's `error` field always carries a typed object. Real
 * FirestoreErrors flow through unchanged; everything else gets a
 * synthetic `unknown` code so callers can still inspect `.code`.
 */
function coerceFirestoreError(err: unknown): FirestoreError {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    return err as FirestoreError;
  }
  return Object.assign(new Error(String(err)), {
    name: 'FirestoreError',
    code: 'unknown',
  }) as unknown as FirestoreError;
}
