// Hook-level test for `useSubmitRequest`. Mocks `firebase/firestore`
// + `firebase/auth` so the test asserts the exact payload shape the
// mutation hands to `setDoc` — the rules' integrity check requires
// `lastActor.{email,canonical}` matching the auth token, plus
// `requester_canonical == authedCanonical()` and
// `requested_at == request.time`. A regression here would silently
// re-introduce the "Missing or insufficient permissions" failure
// mode operator hit on staging.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setDocMock = vi.fn().mockResolvedValue(undefined);
const docMock = vi.fn();
const serverTimestampMock = vi.fn(() => '__server_timestamp__');

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<object>('firebase/firestore');
  return {
    ...actual,
    setDoc: (...args: unknown[]) => setDocMock(...args),
    doc: (...args: unknown[]) => docMock(...args),
    serverTimestamp: () => serverTimestampMock(),
  };
});

let currentUserStub: {
  email: string | null;
  getIdTokenResult: () => Promise<{ claims: Record<string, unknown> }>;
} | null = null;

vi.mock('../../../lib/firebase', () => ({
  db: { __sentinel: 'db' },
  auth: {
    get currentUser() {
      return currentUserStub;
    },
  },
}));

// Skip the typed-doc helpers that reach into the real SDK to build a
// CollectionReference. Tests assert on the body that lands in setDoc;
// the ref shape doesn't matter as long as `doc(col)` returns the
// pre-allocated id.
vi.mock('../../../lib/docs', () => ({
  requestsCol: () => ({ __sentinel: 'requestsCol' }),
  seatRef: () => ({ __sentinel: 'seatRef' }),
}));

import { useSubmitRequest } from '../hooks';

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  setDocMock.mockClear();
  docMock.mockClear();
  serverTimestampMock.mockClear();
  // doc(col) is called with no id → returns a ref with a fixed id so
  // assertions can pin request_id.
  docMock.mockReturnValue({ id: 'allocated-id', path: 'stakes/csnorth/requests/allocated-id' });
  currentUserStub = {
    email: 'Tad.E.Smith@gmail.com',
    getIdTokenResult: async () => ({
      claims: { canonical: 'tadesmith@gmail.com' },
    }),
  };
});

afterEach(() => {
  currentUserStub = null;
});

describe('useSubmitRequest payload shape', () => {
  it('writes status=pending + requester_canonical from token + lastActor matching auth', async () => {
    const { result } = renderHook(() => useSubmitRequest(), { wrapper });
    await result.current.mutateAsync({
      type: 'add_manual',
      scope: 'stake',
      member_email: 'subject@example.com',
      member_name: 'Subject',
      reason: 'Visiting',
      comment: '',
      building_names: ['Cordera Building'],
    });

    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [, body] = setDocMock.mock.calls[0]!;
    expect(body).toMatchObject({
      request_id: 'allocated-id',
      type: 'add_manual',
      scope: 'stake',
      status: 'pending',
      requester_email: 'Tad.E.Smith@gmail.com',
      requester_canonical: 'tadesmith@gmail.com',
      // lastActor must match auth: typed email + canonical claim.
      lastActor: { email: 'Tad.E.Smith@gmail.com', canonical: 'tadesmith@gmail.com' },
      member_canonical: 'subject@example.com',
      member_email: 'subject@example.com',
      member_name: 'Subject',
      reason: 'Visiting',
      building_names: ['Cordera Building'],
    });
    // serverTimestamp() sentinel; only the rules engine resolves it
    // to request.time. Asserting the value we minted, not a Date /
    // string that would fail the rule equality.
    expect(body.requested_at).toBe('__server_timestamp__');
  });

  it('add_temp carries start_date + end_date when set', async () => {
    const { result } = renderHook(() => useSubmitRequest(), { wrapper });
    await result.current.mutateAsync({
      type: 'add_temp',
      scope: 'CO',
      member_email: 'subject@example.com',
      member_name: 'Subject',
      reason: 'Visiting',
      comment: '',
      start_date: '2026-05-01',
      end_date: '2026-05-08',
      building_names: [],
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [, body] = setDocMock.mock.calls[0]!;
    expect(body).toMatchObject({
      type: 'add_temp',
      scope: 'CO',
      start_date: '2026-05-01',
      end_date: '2026-05-08',
    });
  });

  it('remove submits carry seat_member_canonical for the completion lookup', async () => {
    const { result } = renderHook(() => useSubmitRequest(), { wrapper });
    await result.current.mutateAsync({
      type: 'remove',
      scope: 'CO',
      member_email: 'subject@example.com',
      member_name: '',
      reason: 'No longer needed',
      comment: '',
      building_names: [],
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [, body] = setDocMock.mock.calls[0]!;
    expect(body).toMatchObject({
      type: 'remove',
      seat_member_canonical: 'subject@example.com',
    });
  });

  it('throws when no auth user present', async () => {
    currentUserStub = null;
    const { result } = renderHook(() => useSubmitRequest(), { wrapper });
    await expect(
      result.current.mutateAsync({
        type: 'add_manual',
        scope: 'stake',
        member_email: 's@example.com',
        member_name: 'S',
        reason: 'r',
        comment: '',
        building_names: ['Cordera Building'],
      }),
    ).rejects.toThrow(/Not signed in/i);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('stamps urgent=true on the doc body when input.urgent is true', async () => {
    const { result } = renderHook(() => useSubmitRequest(), { wrapper });
    await result.current.mutateAsync({
      type: 'add_manual',
      scope: 'stake',
      member_email: 'subject@example.com',
      member_name: 'Subject',
      reason: 'Sub teacher',
      comment: 'Out of town this weekend',
      building_names: ['Cordera Building'],
      urgent: true,
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [, body] = setDocMock.mock.calls[0]!;
    expect(body.urgent).toBe(true);
  });

  it('omits urgent from the doc body when input.urgent is false', async () => {
    const { result } = renderHook(() => useSubmitRequest(), { wrapper });
    await result.current.mutateAsync({
      type: 'add_manual',
      scope: 'stake',
      member_email: 'subject@example.com',
      member_name: 'Subject',
      reason: 'r',
      comment: '',
      building_names: ['Cordera Building'],
      urgent: false,
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [, body] = setDocMock.mock.calls[0]!;
    expect('urgent' in body).toBe(false);
  });

  it('falls back to canonicalEmail(user.email) when the token lacks a canonical claim', async () => {
    currentUserStub = {
      email: 'Tad.E.Smith@gmail.com',
      getIdTokenResult: async () => ({ claims: {} }),
    };
    const { result } = renderHook(() => useSubmitRequest(), { wrapper });
    await result.current.mutateAsync({
      type: 'add_manual',
      scope: 'stake',
      member_email: 's@example.com',
      member_name: 'S',
      reason: 'r',
      comment: '',
      building_names: ['Cordera Building'],
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [, body] = setDocMock.mock.calls[0]!;
    // canonicalEmail strips dots + lowercases for gmail.
    expect(body.requester_canonical).toBe('tadesmith@gmail.com');
    expect(body.lastActor).toEqual({
      email: 'Tad.E.Smith@gmail.com',
      canonical: 'tadesmith@gmail.com',
    });
  });
});
