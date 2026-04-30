// Hook-level test for `useAddManualGrantMutation`. Mocks
// `firebase/firestore` + `firebase/auth` so the test asserts the
// exact payload shape the mutation hands to `setDoc` / `updateDoc` —
// the rules' integrity check requires `lastActor.{email,canonical}`
// matching the auth token, plus `member_canonical == doc.id`,
// `importer_callings == {}` on create, and ≥1 manual_grants entry.
//
// Force-refresh assertion: every mutation call must hit
// `getIdTokenResult(true)` to pick up server-side claim mints. A
// regression here would silently re-introduce the "Missing or
// insufficient permissions" failure mode operator hit on staging.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setDocMock = vi.fn().mockResolvedValue(undefined);
const updateDocMock = vi.fn().mockResolvedValue(undefined);
const getDocMock = vi.fn();
const serverTimestampMock = vi.fn(() => '__server_timestamp__');
const arrayUnionMock = vi.fn((...values: unknown[]) => ({ __op: 'arrayUnion', values }));

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<object>('firebase/firestore');
  return {
    ...actual,
    setDoc: (...args: unknown[]) => setDocMock(...args),
    updateDoc: (...args: unknown[]) => updateDocMock(...args),
    getDoc: (...args: unknown[]) => getDocMock(...args),
    arrayUnion: (...args: unknown[]) => arrayUnionMock(...args),
    serverTimestamp: () => serverTimestampMock(),
  };
});

let currentUserStub: {
  email: string | null;
  getIdTokenResult: (force?: boolean) => Promise<{ claims: Record<string, unknown> }>;
} | null = null;
const getIdTokenResultSpy = vi.fn();

vi.mock('../../../../lib/firebase', () => ({
  db: { __sentinel: 'db' },
  auth: {
    get currentUser() {
      return currentUserStub;
    },
  },
}));

vi.mock('../../../../lib/docs', () => ({
  accessCol: () => ({ __sentinel: 'accessCol' }),
  accessRef: (_db: unknown, _stake: string, can: string) => ({
    __sentinel: 'accessRef',
    path: `stakes/csnorth/access/${can}`,
  }),
}));

import { useAddManualGrantMutation } from '../hooks';

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  setDocMock.mockClear();
  updateDocMock.mockClear();
  getDocMock.mockClear();
  arrayUnionMock.mockClear();
  serverTimestampMock.mockClear();
  getIdTokenResultSpy.mockClear();
  currentUserStub = {
    email: 'Tad.E.Smith@gmail.com',
    getIdTokenResult: (force?: boolean) => {
      getIdTokenResultSpy(force);
      return Promise.resolve({
        claims: {
          canonical: 'tadesmith@gmail.com',
          email: 'Tad.E.Smith@gmail.com',
          stakes: { csnorth: { manager: true } },
        },
      });
    },
  };
});

afterEach(() => {
  currentUserStub = null;
});

describe('useAddManualGrantMutation', () => {
  it('force-refreshes the ID token before the write', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useAddManualGrantMutation(), { wrapper });
    await result.current.mutateAsync({
      member_email: 'subject@example.com',
      member_name: 'Subject',
      scope: 'stake',
      reason: 'Visiting helper',
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    expect(getIdTokenResultSpy).toHaveBeenCalledWith(true);
  });

  it('creates a manual-only access doc when none exists (rule-shape check)', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useAddManualGrantMutation(), { wrapper });
    await result.current.mutateAsync({
      member_email: 'subject@example.com',
      member_name: 'Subject',
      scope: 'stake',
      reason: 'Visiting helper',
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [ref, body] = setDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({ path: 'stakes/csnorth/access/subject@example.com' });
    expect(body).toMatchObject({
      // Rule predicate 2: doc-id matches body's member_canonical.
      member_canonical: 'subject@example.com',
      member_email: 'subject@example.com',
      member_name: 'Subject',
      // Rule predicate 3: importer_callings must be exactly {}.
      importer_callings: {},
      // Rule predicate 4: at least one scope-key in manual_grants.
      manual_grants: {
        stake: [
          expect.objectContaining({
            reason: 'Visiting helper',
            granted_by: { email: 'Tad.E.Smith@gmail.com', canonical: 'tadesmith@gmail.com' },
          }),
        ],
      },
      // Rule predicate 5: lastActor matches token (canonical + typed).
      lastActor: { email: 'Tad.E.Smith@gmail.com', canonical: 'tadesmith@gmail.com' },
      last_modified_by: { email: 'Tad.E.Smith@gmail.com', canonical: 'tadesmith@gmail.com' },
    });
  });

  it('updates an existing access doc with arrayUnion (no importer_callings touch)', async () => {
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        member_canonical: 'subject@example.com',
        member_email: 'subject@example.com',
        member_name: 'Subject',
        importer_callings: { CO: ['Bishop'] },
        manual_grants: {},
      }),
    });
    const { result } = renderHook(() => useAddManualGrantMutation(), { wrapper });
    await result.current.mutateAsync({
      member_email: 'subject@example.com',
      member_name: 'Subject',
      scope: 'stake',
      reason: 'Visiting helper',
    });
    await waitFor(() => expect(updateDocMock).toHaveBeenCalled());
    const [, payload] = updateDocMock.mock.calls[0]!;
    // Update predicate's affectedKeys allowlist:
    //   ['manual_grants', 'last_modified_by', 'last_modified_at', 'lastActor']
    // (member_email + member_name only re-write when blank — they pass
    // through as-is here, so the rule's `affectedKeys` evaluation
    // sees no change.)
    expect(payload).toMatchObject({
      'manual_grants.stake': expect.objectContaining({ __op: 'arrayUnion' }),
      lastActor: { email: 'Tad.E.Smith@gmail.com', canonical: 'tadesmith@gmail.com' },
      last_modified_by: { email: 'Tad.E.Smith@gmail.com', canonical: 'tadesmith@gmail.com' },
    });
    // Did NOT call setDoc on the update path.
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('throws when no auth user present', async () => {
    currentUserStub = null;
    const { result } = renderHook(() => useAddManualGrantMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        member_email: 's@example.com',
        member_name: 'S',
        scope: 'stake',
        reason: 'r',
      }),
    ).rejects.toThrow(/Not signed in/i);
    expect(setDocMock).not.toHaveBeenCalled();
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('falls back to canonicalEmail(user.email) when the token lacks a canonical claim', async () => {
    currentUserStub = {
      email: 'Tad.E.Smith@gmail.com',
      getIdTokenResult: () =>
        Promise.resolve({
          claims: { stakes: { csnorth: { manager: true } } },
        }),
    };
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useAddManualGrantMutation(), { wrapper });
    await result.current.mutateAsync({
      member_email: 'subject@example.com',
      member_name: 'Subject',
      scope: 'stake',
      reason: 'r',
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [, body] = setDocMock.mock.calls[0]!;
    expect(body.lastActor).toEqual({
      email: 'Tad.E.Smith@gmail.com',
      canonical: 'tadesmith@gmail.com',
    });
  });

  it('rejects a duplicate (scope, reason) with a friendly message', async () => {
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        member_canonical: 'subject@example.com',
        member_email: 'subject@example.com',
        member_name: 'Subject',
        importer_callings: {},
        manual_grants: {
          stake: [
            {
              grant_id: 'g-prior',
              reason: 'Visiting helper',
              granted_by: { email: 'mgr@x.com', canonical: 'mgr@x.com' },
              granted_at: new Date(),
            },
          ],
        },
      }),
    });
    const { result } = renderHook(() => useAddManualGrantMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        member_email: 'subject@example.com',
        member_name: 'Subject',
        scope: 'stake',
        reason: 'Visiting helper',
      }),
    ).rejects.toThrow(/manual grant with that reason already exists/i);
    expect(updateDocMock).not.toHaveBeenCalled();
  });
});
