// Tests for the queue completion hooks:
//   - `resolveRemoveCompletionNote` — pure helper for the R-1 race
//     completion-note resolution.
//   - `useCompleteAddRequest` — mutation that creates a new seat doc
//     for `add_manual` / `add_temp` requests. The full mutation runs
//     inside a Firestore transaction; we mock `firebase/firestore`
//     so the assertion lands on the exact seat-body payload (T-42 /
//     T-43: must include `duplicate_scopes: []`).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { R1_AUTO_NOTE, resolveRemoveCompletionNote } from './hooks';

describe('resolveRemoveCompletionNote', () => {
  it('returns undefined when the seat still exists and the manager left no note', () => {
    expect(resolveRemoveCompletionNote(true, undefined)).toBeUndefined();
    expect(resolveRemoveCompletionNote(true, '')).toBeUndefined();
    expect(resolveRemoveCompletionNote(true, '   ')).toBeUndefined();
  });

  it('returns the trimmed manager note when the seat still exists', () => {
    expect(resolveRemoveCompletionNote(true, '  Removed manually.  ')).toBe('Removed manually.');
  });

  it('returns the R-1 auto-note alone when the seat is gone and no manager note is supplied', () => {
    expect(resolveRemoveCompletionNote(false, undefined)).toBe(R1_AUTO_NOTE);
    expect(resolveRemoveCompletionNote(false, '')).toBe(R1_AUTO_NOTE);
    expect(resolveRemoveCompletionNote(false, '   ')).toBe(R1_AUTO_NOTE);
  });

  it('preserves the manager note alongside the R-1 system tag on the race case', () => {
    const merged = resolveRemoveCompletionNote(false, '  Already cleared in LCR.  ');
    expect(merged).toBe(`Already cleared in LCR.\n\n[System: ${R1_AUTO_NOTE}]`);
  });
});

// ---- useCompleteAddRequest seat-body shape (T-42 / T-43) -----------

const txSetMock = vi.fn();
const txUpdateMock = vi.fn();
const txGetMock = vi.fn();

const runTransactionMock = vi.fn(
  async (_db: unknown, fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    const tx = {
      get: (ref: unknown) => txGetMock(ref),
      set: (ref: unknown, data: unknown) => txSetMock(ref, data),
      update: (ref: unknown, data: unknown) => txUpdateMock(ref, data),
    };
    return fn(tx);
  },
);

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<object>('firebase/firestore');
  return {
    ...actual,
    runTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      runTransactionMock(db, fn),
    serverTimestamp: () => '__server_timestamp__',
  };
});

vi.mock('../../../lib/firebase', () => ({
  db: { __sentinel: 'db' },
  auth: {
    currentUser: {
      email: 'mgr@example.com',
      uid: 'mgr-uid',
      getIdTokenResult: async () => ({
        claims: { canonical: 'mgr@example.com' },
      }),
    },
  },
}));

vi.mock('../../../lib/docs', async () => {
  const actual = await vi.importActual<object>('../../../lib/docs');
  return {
    ...actual,
    requestRef: (_db: unknown, _stakeId: string, requestId: string) => ({
      __sentinel: 'requestRef',
      path: `stakes/csnorth/requests/${requestId}`,
      id: requestId,
    }),
    seatRef: (_db: unknown, _stakeId: string, canonical: string) => ({
      __sentinel: 'seatRef',
      path: `stakes/csnorth/seats/${canonical}`,
      id: canonical,
    }),
    requestsCol: (_db: unknown) => ({ __sentinel: 'requestsCol' }),
  };
});

import { useCompleteAddRequest } from './hooks';
import type { AccessRequest } from '@kindoo/shared';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  txSetMock.mockClear();
  txUpdateMock.mockClear();
  txGetMock.mockClear();
  runTransactionMock.mockClear();
  // Two reads happen inside the transaction (in order):
  //   1. the request doc — must exist + be `pending`.
  //   2. the new seat doc — must NOT exist (create branch).
  // Stub them in sequence so the mutation reaches the seat-set call.
  txGetMock.mockImplementation((ref: unknown) => {
    const path = (ref as { path?: string }).path ?? '';
    if (path.includes('/requests/')) {
      return Promise.resolve({
        exists: () => true,
        data: () => ({ status: 'pending' }),
      });
    }
    // seats/
    return Promise.resolve({ exists: () => false });
  });
});

function addManualRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    request_id: 'r1',
    type: 'add_manual',
    scope: 'stake',
    member_email: 'subject@example.com',
    member_canonical: 'subject@example.com',
    member_name: 'Subject Person',
    reason: 'Visiting authority',
    comment: '',
    building_names: ['Cordera Building'],
    status: 'pending',
    requester_email: 'mgr@example.com',
    requester_canonical: 'mgr@example.com',
    requested_at: { seconds: 1, nanoseconds: 0 } as unknown as AccessRequest['requested_at'],
    lastActor: { email: 'mgr@example.com', canonical: 'mgr@example.com' },
    ...overrides,
  } as AccessRequest;
}

describe('useCompleteAddRequest seat-body shape', () => {
  it('T-42 / T-43: writes duplicate_scopes: [] on the new seat doc (server-maintained primitive mirror)', async () => {
    const { result } = renderHook(() => useCompleteAddRequest(), { wrapper });
    await result.current.mutateAsync({
      request: addManualRequest(),
      building_names: ['Cordera Building'],
    });
    await waitFor(() => expect(txSetMock).toHaveBeenCalled());
    const [seatRefArg, body] = txSetMock.mock.calls[0]!;
    expect(seatRefArg).toMatchObject({ id: 'subject@example.com' });
    const seatBody = body as Record<string, unknown>;
    // Critical T-43 assertion: the field is always set on every
    // server seat writer, even when empty.
    expect(seatBody['duplicate_scopes']).toEqual([]);
    // Sanity: the duplicate_grants array is also empty (no merge on
    // a fresh seat).
    expect(seatBody['duplicate_grants']).toEqual([]);
  });

  it('T-42 / T-43: still writes duplicate_scopes: [] on add_temp', async () => {
    const { result } = renderHook(() => useCompleteAddRequest(), { wrapper });
    await result.current.mutateAsync({
      request: addManualRequest({
        type: 'add_temp',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
      }),
      building_names: ['Cordera Building'],
    });
    await waitFor(() => expect(txSetMock).toHaveBeenCalled());
    const [, body] = txSetMock.mock.calls[0]!;
    expect((body as Record<string, unknown>)['duplicate_scopes']).toEqual([]);
  });
});
