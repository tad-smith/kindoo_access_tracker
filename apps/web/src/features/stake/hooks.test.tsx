// Hook-level tests for `useSetSeatOrganization` — the inline org-edit
// mutation on the Stake Roster card. `firebase/firestore` is mocked so
// the assertions land on the exact payload handed to `updateDoc`: the
// four-key `hasOnly` allowlist the Firestore rule permits, with the
// stamped actor.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateDocMock = vi.fn();
const serverTimestampMock = vi.fn(() => ({ __sentinel: 'serverTimestamp' }));
const toastMock = vi.fn();

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<object>('firebase/firestore');
  return {
    ...actual,
    updateDoc: (...args: unknown[]) => updateDocMock(...args),
    serverTimestamp: () => serverTimestampMock(),
  };
});

vi.mock('../../lib/firebase', () => ({
  db: { __sentinel: 'db' },
  auth: { currentUser: null },
}));

vi.mock('../../lib/docs', async () => {
  const actual = await vi.importActual<object>('../../lib/docs');
  return {
    ...actual,
    seatRef: (_db: unknown, _stakeId: string, canonical: string) => ({
      __sentinel: 'seatRef',
      path: `stakes/csnorth/seats/${canonical}`,
      id: canonical,
    }),
  };
});

vi.mock('../../lib/principal', () => ({
  usePrincipal: () => ({
    email: 'mgr@example.com',
    canonical: 'mgr@example.com',
    firebaseAuthSignedIn: true,
    isAuthenticated: true,
  }),
}));

const activeStakeMock = vi.fn(() => 'csnorth' as string | null);
vi.mock('../../lib/useActiveStake', () => ({
  useActiveStake: () => activeStakeMock(),
}));

vi.mock('../../lib/store/toast', () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));

import { useSetSeatOrganization } from './hooks';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  updateDocMock.mockReset();
  updateDocMock.mockResolvedValue(undefined);
  serverTimestampMock.mockClear();
  toastMock.mockClear();
  activeStakeMock.mockReturnValue('csnorth');
});

describe('useSetSeatOrganization', () => {
  it('targets the member seat doc in the active stake', async () => {
    const { result } = renderHook(() => useSetSeatOrganization(), { wrapper });
    await result.current.mutateAsync({ memberCanonical: 'a@x.com', organizationId: 'choir' });
    await waitFor(() => expect(updateDocMock).toHaveBeenCalled());
    const [ref] = updateDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({ path: 'stakes/csnorth/seats/a@x.com', id: 'a@x.com' });
  });

  it('writes EXACTLY the four-key hasOnly allowlist', async () => {
    const { result } = renderHook(() => useSetSeatOrganization(), { wrapper });
    await result.current.mutateAsync({ memberCanonical: 'a@x.com', organizationId: 'choir' });
    await waitFor(() => expect(updateDocMock).toHaveBeenCalled());
    const [, body] = updateDocMock.mock.calls[0]!;
    expect(Object.keys(body as object).sort()).toEqual([
      'lastActor',
      'last_modified_at',
      'last_modified_by',
      'organization_id',
    ]);
  });

  it('stamps the chosen org id, server timestamp, and actor on both actor fields', async () => {
    const { result } = renderHook(() => useSetSeatOrganization(), { wrapper });
    await result.current.mutateAsync({ memberCanonical: 'a@x.com', organizationId: 'choir' });
    await waitFor(() => expect(updateDocMock).toHaveBeenCalled());
    const [, body] = updateDocMock.mock.calls[0]!;
    expect(body).toMatchObject({
      organization_id: 'choir',
      last_modified_at: { __sentinel: 'serverTimestamp' },
      last_modified_by: { email: 'mgr@example.com', canonical: 'mgr@example.com' },
      lastActor: { email: 'mgr@example.com', canonical: 'mgr@example.com' },
    });
  });

  it('writes null when clearing the organization', async () => {
    const { result } = renderHook(() => useSetSeatOrganization(), { wrapper });
    await result.current.mutateAsync({ memberCanonical: 'a@x.com', organizationId: null });
    await waitFor(() => expect(updateDocMock).toHaveBeenCalled());
    const [, body] = updateDocMock.mock.calls[0]!;
    expect((body as { organization_id: unknown }).organization_id).toBeNull();
  });

  it('throws and does not write when there is no active stake', async () => {
    activeStakeMock.mockReturnValue(null);
    const { result } = renderHook(() => useSetSeatOrganization(), { wrapper });
    await expect(
      result.current.mutateAsync({ memberCanonical: 'a@x.com', organizationId: 'choir' }),
    ).rejects.toThrow(/active stake/i);
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('toasts an error when the write fails', async () => {
    updateDocMock.mockRejectedValue(new Error('permission-denied'));
    const { result } = renderHook(() => useSetSeatOrganization(), { wrapper });
    await expect(
      result.current.mutateAsync({ memberCanonical: 'a@x.com', organizationId: 'choir' }),
    ).rejects.toThrow();
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/organization/i), 'error');
  });
});
