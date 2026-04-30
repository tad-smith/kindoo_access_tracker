// Tests for `useRunImportNowMutation`. Mocks `firebase/functions` so
// the assertions land on the exact name + payload the wrapper hands to
// `httpsCallable`, plus the typed `ImportSummary` round-trip and the
// "callable not deployed yet" friendly-rewrite path.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportSummary } from '@kindoo/shared';

const callableInvoke = vi.fn();
const httpsCallableMock = vi.fn((_app: unknown, _name: string) => callableInvoke);

vi.mock('firebase/functions', () => ({
  getFunctions: () => ({ __sentinel: 'functions' }),
  httpsCallable: (app: unknown, name: string) => httpsCallableMock(app, name),
}));

vi.mock('../../../lib/firebase', () => ({
  firebaseApp: { __sentinel: 'app' },
  db: { __sentinel: 'db' },
}));

vi.mock('../../../lib/data', () => ({
  useFirestoreDoc: () => ({ data: undefined, isLoading: true }),
}));

vi.mock('../../../lib/docs', () => ({
  stakeRef: () => ({ __sentinel: 'stakeRef' }),
}));

import { useRunImportNowMutation } from './hooks';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function summary(over: Partial<ImportSummary> = {}): ImportSummary {
  return {
    ok: true,
    inserted: 0,
    deleted: 0,
    updated: 0,
    access_added: 0,
    access_removed: 0,
    warnings: [],
    skipped_tabs: [],
    over_caps: [],
    elapsed_ms: 0,
    triggered_by: 'tester@example.com',
    ...over,
  };
}

beforeEach(() => {
  callableInvoke.mockReset();
  httpsCallableMock.mockClear();
});

describe('useRunImportNowMutation', () => {
  it('invokes the `runImportNow` callable with the configured stake id', async () => {
    callableInvoke.mockResolvedValueOnce({ data: summary({ inserted: 4 }) });
    const { result } = renderHook(() => useRunImportNowMutation(), { wrapper });

    const out = await result.current.mutateAsync();

    expect(httpsCallableMock).toHaveBeenCalled();
    const firstCall = httpsCallableMock.mock.calls[0];
    expect(firstCall?.[1]).toBe('runImportNow');
    expect(callableInvoke).toHaveBeenCalledWith({ stakeId: 'csnorth' });
    expect(out.inserted).toBe(4);
  });

  it('returns the typed ImportSummary on success', async () => {
    const expected = summary({ inserted: 7, updated: 2, deleted: 1, elapsed_ms: 1500 });
    callableInvoke.mockResolvedValueOnce({ data: expected });
    const { result } = renderHook(() => useRunImportNowMutation(), { wrapper });

    const out = await result.current.mutateAsync();
    expect(out).toEqual(expected);
  });

  it('rewrites a "not-found" error to a friendly Phase-8-not-deployed message', async () => {
    callableInvoke.mockRejectedValueOnce(new Error('functions/not-found: callable missing'));
    const { result } = renderHook(() => useRunImportNowMutation(), { wrapper });

    await expect(result.current.mutateAsync()).rejects.toThrow(/not yet enabled/i);
  });

  it('surfaces the original error for non-not-found failures', async () => {
    callableInvoke.mockRejectedValueOnce(new Error('permission-denied: not a manager'));
    const { result } = renderHook(() => useRunImportNowMutation(), { wrapper });

    await expect(result.current.mutateAsync()).rejects.toThrow(/permission-denied/);
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
