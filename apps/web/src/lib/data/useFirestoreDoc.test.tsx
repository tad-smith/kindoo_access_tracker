// Tests for `useFirestoreDoc`. Mocks `firebase/firestore`'s
// `onSnapshot` so we can drive snapshot pushes from the test directly
// without standing up an emulator. Covers:
//   - Null ref → status pending, data undefined, no listener.
//   - Non-null ref → first snapshot transitions status to success
//     with the doc data.
//   - Doc doesn't exist → data undefined, status success.
//   - Listener error → status error, error field carries the value.
//   - Unmount → unsubscribe called.
//   - Ref change → previous unsubscribe called before new listener.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// onSnapshot mock is module-scoped so each test's `mockImplementation`
// only affects that test.
const onSnapshotMock = vi.fn();

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<object>('firebase/firestore');
  return {
    ...actual,
    onSnapshot: (...args: unknown[]) => onSnapshotMock(...args),
  };
});

import { useFirestoreDoc } from './useFirestoreDoc.js';

type FakeRef = { type: 'document'; path: string; __id: number };
let nextRefId = 0;
function fakeRef(path: string): FakeRef {
  return { type: 'document', path, __id: ++nextRefId };
}

function fakeSnapshot(data: unknown | undefined) {
  return {
    exists: () => data !== undefined,
    data: () => data,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  onSnapshotMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useFirestoreDoc', () => {
  it('returns pending status when ref is null and never subscribes', () => {
    const { result } = renderHook(() => useFirestoreDoc<{ x: number }>(null), { wrapper });
    expect(result.current.data).toBeUndefined();
    expect(result.current.status).toBe('pending');
    expect(onSnapshotMock).not.toHaveBeenCalled();
  });

  it('subscribes via onSnapshot when ref is non-null and surfaces snapshot data', async () => {
    let pushSnapshot: ((s: unknown) => void) | null = null;
    onSnapshotMock.mockImplementation((_ref, onNext) => {
      pushSnapshot = onNext;
      return () => {};
    });
    const ref = fakeRef('stakes/csnorth/seats/abc') as unknown as Parameters<
      typeof useFirestoreDoc<{ name: string }>
    >[0];

    const { result } = renderHook(() => useFirestoreDoc<{ name: string }>(ref), { wrapper });

    expect(onSnapshotMock).toHaveBeenCalledTimes(1);
    expect(pushSnapshot).not.toBeNull();

    await act(async () => {
      pushSnapshot!(fakeSnapshot({ name: 'Alice' }));
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
      expect(result.current.data).toEqual({ name: 'Alice' });
    });
  });

  it('returns data: undefined with status success when the doc does not exist', async () => {
    let pushSnapshot: ((s: unknown) => void) | null = null;
    onSnapshotMock.mockImplementation((_ref, onNext) => {
      pushSnapshot = onNext;
      return () => {};
    });
    const ref = fakeRef('stakes/csnorth/seats/missing') as unknown as Parameters<
      typeof useFirestoreDoc<{ name: string }>
    >[0];

    const { result } = renderHook(() => useFirestoreDoc<{ name: string }>(ref), { wrapper });

    await act(async () => {
      pushSnapshot!(fakeSnapshot(undefined));
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
      expect(result.current.data).toBeUndefined();
    });
  });

  it('surfaces listener errors as status error', async () => {
    let onError: ((e: unknown) => void) | null = null;
    onSnapshotMock.mockImplementation((_ref, _onNext, onErr) => {
      onError = onErr;
      return () => {};
    });
    const ref = fakeRef('stakes/csnorth/seats/blocked') as unknown as Parameters<
      typeof useFirestoreDoc<{ name: string }>
    >[0];

    const { result } = renderHook(() => useFirestoreDoc<{ name: string }>(ref), { wrapper });

    expect(onError).not.toBeNull();
    const fakeErr = Object.assign(new Error('permission denied'), {
      code: 'permission-denied',
      name: 'FirebaseError',
    });
    await act(async () => {
      onError!(fakeErr);
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
      expect(result.current.error).toBe(fakeErr);
      expect(result.current.data).toBeUndefined();
    });
  });

  it('unsubscribes on unmount', () => {
    const unsubscribe = vi.fn();
    onSnapshotMock.mockImplementation(() => unsubscribe);
    const ref = fakeRef('stakes/x/seats/a') as unknown as Parameters<
      typeof useFirestoreDoc<unknown>
    >[0];

    const { unmount } = renderHook(() => useFirestoreDoc<unknown>(ref), { wrapper });
    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('re-subscribes when ref changes; tears down the previous subscription first', () => {
    const unsubscribeA = vi.fn();
    const unsubscribeB = vi.fn();
    let call = 0;
    onSnapshotMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? unsubscribeA : unsubscribeB;
    });

    const refA = fakeRef('stakes/x/seats/a') as unknown as Parameters<
      typeof useFirestoreDoc<unknown>
    >[0];
    const refB = fakeRef('stakes/x/seats/b') as unknown as Parameters<
      typeof useFirestoreDoc<unknown>
    >[0];

    const { rerender } = renderHook(({ r }: { r: typeof refA }) => useFirestoreDoc<unknown>(r), {
      wrapper,
      initialProps: { r: refA },
    });

    expect(onSnapshotMock).toHaveBeenCalledTimes(1);
    expect(unsubscribeA).not.toHaveBeenCalled();

    rerender({ r: refB });

    expect(unsubscribeA).toHaveBeenCalledTimes(1);
    expect(onSnapshotMock).toHaveBeenCalledTimes(2);
    expect(unsubscribeB).not.toHaveBeenCalled();
  });

  it('does not subscribe when consumer unmounts before snapshot push', () => {
    const unsubscribe = vi.fn();
    onSnapshotMock.mockImplementation(() => unsubscribe);
    const ref = fakeRef('stakes/x/seats/c') as unknown as Parameters<
      typeof useFirestoreDoc<unknown>
    >[0];

    const { unmount } = render(<HookProbe refArg={ref} />);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('surfaces a synchronous onSnapshot throw as a hook error state', async () => {
    // Mirrors the SDK 12.x edge case where `onSnapshot` itself throws
    // synchronously instead of routing the error through the listener
    // callback. The hook must convert that into a hook error state, not
    // let the throw propagate to the React error boundary.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      onSnapshotMock.mockImplementation(() => {
        throw Object.assign(new Error('subscribe panic'), {
          code: 'permission-denied',
          name: 'FirebaseError',
        });
      });
      const ref = fakeRef('stakes/x/seats/panic') as unknown as Parameters<
        typeof useFirestoreDoc<unknown>
      >[0];

      const { result } = renderHook(() => useFirestoreDoc<unknown>(ref), { wrapper });

      await waitFor(() => {
        expect(result.current.status).toBe('error');
        expect(result.current.error?.code).toBe('permission-denied');
      });
      // Operator-visible log line includes the offending path.
      expect(
        consoleErrorSpy.mock.calls.some(
          ([first, payload]) =>
            typeof first === 'string' &&
            first.includes('[useFirestoreDoc]') &&
            (payload as { path?: string } | undefined)?.path === 'stakes/x/seats/panic',
        ),
      ).toBe(true);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('logs the failing path when the listener error callback fires', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let onError: ((e: unknown) => void) | null = null;
      onSnapshotMock.mockImplementation((_ref, _onNext, onErr) => {
        onError = onErr;
        return () => {};
      });
      const ref = fakeRef('stakes/x/wards/CO') as unknown as Parameters<
        typeof useFirestoreDoc<unknown>
      >[0];

      renderHook(() => useFirestoreDoc<unknown>(ref), { wrapper });
      const fakeErr = Object.assign(new Error('denied'), {
        code: 'permission-denied',
        name: 'FirebaseError',
      });
      await act(async () => {
        onError!(fakeErr);
      });

      expect(
        consoleErrorSpy.mock.calls.some(
          ([first, payload]) =>
            typeof first === 'string' &&
            first.includes('[useFirestoreDoc]') &&
            (payload as { path?: string; code?: string } | undefined)?.path ===
              'stakes/x/wards/CO' &&
            (payload as { code?: string } | undefined)?.code === 'permission-denied',
        ),
      ).toBe(true);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('swallows an unsubscribe throw on unmount without propagating', () => {
    // SDK can throw on `unsubscribe()` during teardown when its own
    // internal state is wedged. The cleanup must not propagate; the
    // surrounding React effect chain runs the next teardown either way.
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      onSnapshotMock.mockImplementation(() => () => {
        throw new Error('teardown wedged');
      });
      const ref = fakeRef('stakes/x/seats/d') as unknown as Parameters<
        typeof useFirestoreDoc<unknown>
      >[0];
      const { unmount } = renderHook(() => useFirestoreDoc<unknown>(ref), { wrapper });
      expect(() => unmount()).not.toThrow();
      expect(consoleWarnSpy).toHaveBeenCalled();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});

function HookProbe({ refArg }: { refArg: unknown }) {
  const queryClient = new QueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      <Inner refArg={refArg} />
    </QueryClientProvider>
  );
}

function Inner({ refArg }: { refArg: unknown }) {
  useFirestoreDoc(refArg as Parameters<typeof useFirestoreDoc<unknown>>[0]);
  return null;
}
