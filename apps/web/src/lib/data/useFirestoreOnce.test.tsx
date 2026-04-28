// Tests for `useFirestoreOnce`. Mocks `getDoc` / `getDocs` so we can
// exercise the one-shot path without an emulator. Covers:
//   - Null input → query disabled, status pending.
//   - DocumentReference input → calls getDoc; resolves to data.
//   - DocumentReference where doc doesn't exist → data undefined,
//     status success.
//   - Query input → calls getDocs; resolves to T[].

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getDocMock = vi.fn();
const getDocsMock = vi.fn();

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<object>('firebase/firestore');
  return {
    ...actual,
    getDoc: (...args: unknown[]) => getDocMock(...args),
    getDocs: (...args: unknown[]) => getDocsMock(...args),
  };
});

import { useFirestoreOnce } from './useFirestoreOnce.js';

function fakeRef(path: string) {
  return { type: 'document' as const, path, __id: Math.random() };
}
function fakeQuery(path: string) {
  return { type: 'query' as const, path, __id: Math.random() };
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  getDocMock.mockReset();
  getDocsMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useFirestoreOnce (document)', () => {
  it('returns pending and never calls getDoc when ref is null', () => {
    const { result } = renderHook(
      () =>
        useFirestoreOnce<{ name: string }>(
          null as unknown as Parameters<typeof useFirestoreOnce<{ name: string }>>[0],
        ),
      { wrapper },
    );
    expect(result.current.status).toBe('pending');
    expect(getDocMock).not.toHaveBeenCalled();
    expect(getDocsMock).not.toHaveBeenCalled();
  });

  it('reads a document via getDoc and surfaces the data', async () => {
    getDocMock.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({ name: 'Alice' }),
    });
    const ref = fakeRef('stakes/csnorth/seats/abc') as unknown as Parameters<
      typeof useFirestoreOnce<{ name: string }>
    >[0];

    const { result } = renderHook(() => useFirestoreOnce<{ name: string }>(ref), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
      expect(result.current.data).toEqual({ name: 'Alice' });
    });
    expect(getDocMock).toHaveBeenCalledTimes(1);
    expect(getDocsMock).not.toHaveBeenCalled();
  });

  it('returns data: undefined when the doc does not exist', async () => {
    getDocMock.mockResolvedValueOnce({
      exists: () => false,
      data: () => undefined,
    });
    const ref = fakeRef('stakes/csnorth/seats/missing') as unknown as Parameters<
      typeof useFirestoreOnce<{ name: string }>
    >[0];

    const { result } = renderHook(() => useFirestoreOnce<{ name: string }>(ref), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
      expect(result.current.data).toBeUndefined();
    });
  });
});

describe('useFirestoreOnce (query)', () => {
  it('reads a collection via getDocs and surfaces the array data', async () => {
    getDocsMock.mockResolvedValueOnce({
      docs: [{ data: () => ({ name: 'A' }) }, { data: () => ({ name: 'B' }) }],
    });
    const q = fakeQuery('stakes/csnorth/seats') as unknown as Parameters<
      typeof useFirestoreOnce<{ name: string }>
    >[0];

    const { result } = renderHook(() => useFirestoreOnce<{ name: string }>(q), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
      expect(result.current.data).toEqual([{ name: 'A' }, { name: 'B' }]);
    });
    expect(getDocsMock).toHaveBeenCalledTimes(1);
    expect(getDocMock).not.toHaveBeenCalled();
  });
});
