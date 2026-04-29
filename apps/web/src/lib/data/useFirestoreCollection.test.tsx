// Tests for `useFirestoreCollection`. Same mocking pattern as
// `useFirestoreDoc.test.tsx`. Covers:
//   - Null query → status pending, data undefined, no listener.
//   - First snapshot → success state with array data in order.
//   - Listener error → status error, error field carries the value.
//   - Unmount → unsubscribe called.
//   - Referential stability: re-snapshot with element-wise-equal data
//     keeps the previous array reference.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const onSnapshotMock = vi.fn();

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<object>('firebase/firestore');
  return {
    ...actual,
    onSnapshot: (...args: unknown[]) => onSnapshotMock(...args),
  };
});

import { useFirestoreCollection } from './useFirestoreCollection.js';

type FakeQuery = { type: 'query'; path: string; __id: number };
let nextId = 0;
function fakeQuery(path: string): FakeQuery {
  return { type: 'query', path, __id: ++nextId };
}

function fakeQuerySnapshot(items: unknown[]) {
  return {
    docs: items.map((data) => ({
      data: () => data,
    })),
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

describe('useFirestoreCollection', () => {
  it('returns pending status when query is null and never subscribes', () => {
    const { result } = renderHook(() => useFirestoreCollection<{ x: number }>(null), {
      wrapper,
    });
    expect(result.current.data).toBeUndefined();
    expect(result.current.status).toBe('pending');
    expect(onSnapshotMock).not.toHaveBeenCalled();
  });

  it('returns array data in order on first snapshot', async () => {
    let pushSnapshot: ((s: unknown) => void) | null = null;
    onSnapshotMock.mockImplementation((_q, onNext) => {
      pushSnapshot = onNext;
      return () => {};
    });
    const q = fakeQuery('stakes/csnorth/seats') as unknown as Parameters<
      typeof useFirestoreCollection<{ name: string }>
    >[0];

    const { result } = renderHook(() => useFirestoreCollection<{ name: string }>(q), {
      wrapper,
    });

    await act(async () => {
      pushSnapshot!(fakeQuerySnapshot([{ name: 'Alice' }, { name: 'Bob' }]));
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
      expect(result.current.data).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
    });
  });

  it('preserves array reference when snapshot data is element-wise equal', async () => {
    let pushSnapshot: ((s: unknown) => void) | null = null;
    onSnapshotMock.mockImplementation((_q, onNext) => {
      pushSnapshot = onNext;
      return () => {};
    });
    const q = fakeQuery('stakes/csnorth/seats') as unknown as Parameters<
      typeof useFirestoreCollection<{ name: string }>
    >[0];

    const { result } = renderHook(() => useFirestoreCollection<{ name: string }>(q), {
      wrapper,
    });

    await act(async () => {
      pushSnapshot!(fakeQuerySnapshot([{ name: 'Alice' }, { name: 'Bob' }]));
    });
    await waitFor(() => expect(result.current.status).toBe('success'));
    const first = result.current.data;

    // Push a fresh snapshot with structurally-equal data (Firestore
    // would produce fresh objects on every snapshot; the hook should
    // detect they're equal and reuse the prior array reference).
    await act(async () => {
      pushSnapshot!(fakeQuerySnapshot([{ name: 'Alice' }, { name: 'Bob' }]));
    });
    expect(result.current.data).toBe(first);
  });

  it('produces a new array when snapshot data actually changes', async () => {
    let pushSnapshot: ((s: unknown) => void) | null = null;
    onSnapshotMock.mockImplementation((_q, onNext) => {
      pushSnapshot = onNext;
      return () => {};
    });
    const q = fakeQuery('stakes/csnorth/seats') as unknown as Parameters<
      typeof useFirestoreCollection<{ name: string }>
    >[0];

    const { result } = renderHook(() => useFirestoreCollection<{ name: string }>(q), {
      wrapper,
    });

    await act(async () => {
      pushSnapshot!(fakeQuerySnapshot([{ name: 'Alice' }]));
    });
    await waitFor(() => expect(result.current.status).toBe('success'));
    const first = result.current.data;

    await act(async () => {
      pushSnapshot!(fakeQuerySnapshot([{ name: 'Alice' }, { name: 'Bob' }]));
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
    });
    expect(result.current.data).not.toBe(first);
  });

  it('surfaces listener errors as status error', async () => {
    let onError: ((e: unknown) => void) | null = null;
    onSnapshotMock.mockImplementation((_q, _onNext, onErr) => {
      onError = onErr;
      return () => {};
    });
    const q = fakeQuery('stakes/csnorth/seats') as unknown as Parameters<
      typeof useFirestoreCollection<{ name: string }>
    >[0];

    const { result } = renderHook(() => useFirestoreCollection<{ name: string }>(q), {
      wrapper,
    });

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
    });
  });

  it('unsubscribes on unmount', () => {
    const unsubscribe = vi.fn();
    onSnapshotMock.mockImplementation(() => unsubscribe);
    const q = fakeQuery('stakes/csnorth/seats') as unknown as Parameters<
      typeof useFirestoreCollection<unknown>
    >[0];

    const { unmount } = renderHook(() => useFirestoreCollection<unknown>(q), { wrapper });
    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('surfaces a synchronous onSnapshot throw as a hook error state', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      onSnapshotMock.mockImplementation(() => {
        throw Object.assign(new Error('subscribe panic'), {
          code: 'permission-denied',
          name: 'FirebaseError',
        });
      });
      const q = fakeQuery('stakes/csnorth/kindooManagers') as unknown as Parameters<
        typeof useFirestoreCollection<unknown>
      >[0];
      const { result } = renderHook(() => useFirestoreCollection<unknown>(q), { wrapper });
      await waitFor(() => {
        expect(result.current.status).toBe('error');
        expect(result.current.error?.code).toBe('permission-denied');
      });
      expect(
        consoleErrorSpy.mock.calls.some(
          ([first, payload]) =>
            typeof first === 'string' &&
            first.includes('[useFirestoreCollection]') &&
            (payload as { path?: string } | undefined)?.path === 'stakes/csnorth/kindooManagers',
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
      onSnapshotMock.mockImplementation((_q, _onNext, onErr) => {
        onError = onErr;
        return () => {};
      });
      const q = fakeQuery('stakes/csnorth/wards') as unknown as Parameters<
        typeof useFirestoreCollection<unknown>
      >[0];
      renderHook(() => useFirestoreCollection<unknown>(q), { wrapper });
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
            first.includes('[useFirestoreCollection]') &&
            (payload as { path?: string; code?: string } | undefined)?.path ===
              'stakes/csnorth/wards' &&
            (payload as { code?: string } | undefined)?.code === 'permission-denied',
        ),
      ).toBe(true);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('swallows an unsubscribe throw on unmount without propagating', () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      onSnapshotMock.mockImplementation(() => () => {
        throw new Error('teardown wedged');
      });
      const q = fakeQuery('stakes/csnorth/buildings') as unknown as Parameters<
        typeof useFirestoreCollection<unknown>
      >[0];
      const { unmount } = renderHook(() => useFirestoreCollection<unknown>(q), { wrapper });
      expect(() => unmount()).not.toThrow();
      expect(consoleWarnSpy).toHaveBeenCalled();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});
