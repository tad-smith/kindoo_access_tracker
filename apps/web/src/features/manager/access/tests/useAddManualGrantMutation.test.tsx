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
import type { ManualGrant } from '@kindoo/shared';

const setDocMock = vi.fn().mockResolvedValue(undefined);
const updateDocMock = vi.fn().mockResolvedValue(undefined);
const getDocMock = vi.fn();
const deleteDocMock = vi.fn().mockResolvedValue(undefined);
const serverTimestampMock = vi.fn(() => '__server_timestamp__');
const arrayUnionMock = vi.fn((...values: unknown[]) => ({ __op: 'arrayUnion', values }));
const arrayRemoveMock = vi.fn((...values: unknown[]) => ({ __op: 'arrayRemove', values }));
const deleteFieldMock = vi.fn(() => ({ __op: 'deleteField' }));

// runTransaction shim — the delete path decides its write shape from a
// transactional read, so the tx's `get` / `update` delegate to the same
// mocks the non-transactional paths use.
const runTransactionMock = vi.fn(
  async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    await fn({
      get: (...args: unknown[]) => getDocMock(...args),
      update: (...args: unknown[]) => updateDocMock(...args),
    }),
);

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<object>('firebase/firestore');
  return {
    ...actual,
    setDoc: (...args: unknown[]) => setDocMock(...args),
    updateDoc: (...args: unknown[]) => updateDocMock(...args),
    getDoc: (...args: unknown[]) => getDocMock(...args),
    deleteDoc: (...args: unknown[]) => deleteDocMock(...args),
    arrayUnion: (...args: unknown[]) => arrayUnionMock(...args),
    arrayRemove: (...args: unknown[]) => arrayRemoveMock(...args),
    deleteField: () => deleteFieldMock(),
    runTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      runTransactionMock(db, fn),
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

vi.mock('../../../../lib/useActiveStake', () => ({
  useActiveStake: () => 'csnorth',
}));

import { useAddManualGrantMutation, useDeleteManualGrantMutation } from '../hooks';

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
  deleteDocMock.mockClear();
  arrayUnionMock.mockClear();
  arrayRemoveMock.mockClear();
  deleteFieldMock.mockClear();
  runTransactionMock.mockClear();
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
      level: 'full',
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
      level: 'full',
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
      level: 'full',
    });
    await waitFor(() => expect(updateDocMock).toHaveBeenCalled());
    const [, payload] = updateDocMock.mock.calls[0]!;
    expect(payload).toMatchObject({
      'manual_grants.stake': expect.objectContaining({ __op: 'arrayUnion' }),
      lastActor: { email: 'Tad.E.Smith@gmail.com', canonical: 'tadesmith@gmail.com' },
      last_modified_by: { email: 'Tad.E.Smith@gmail.com', canonical: 'tadesmith@gmail.com' },
    });
    // Did NOT call setDoc on the update path.
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('UPDATE payload writes only keys in the rule allowlist (no member_email / member_name)', async () => {
    // Regression guard for the staging "Missing or insufficient
    // permissions" bug: the previous payload included member_email +
    // member_name, which trips the access rule's
    //   diff.affectedKeys().hasOnly(['manual_grants',
    //     'last_modified_by', 'last_modified_at', 'lastActor'])
    // check and denies the update.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        member_canonical: 'subject@example.com',
        member_email: 'subject@example.com',
        member_name: 'Subject',
        importer_callings: {},
        manual_grants: {},
      }),
    });
    const { result } = renderHook(() => useAddManualGrantMutation(), { wrapper });
    await result.current.mutateAsync({
      member_email: 'subject@example.com',
      member_name: 'Subject',
      scope: 'stake',
      reason: 'Visiting helper',
      level: 'full',
    });
    await waitFor(() => expect(updateDocMock).toHaveBeenCalled());
    const [, payload] = updateDocMock.mock.calls[0]!;
    const allowed = new Set([
      'manual_grants.stake',
      'last_modified_at',
      'last_modified_by',
      'lastActor',
    ]);
    const actualKeys = new Set(Object.keys(payload as Record<string, unknown>));
    expect([...actualKeys].sort()).toEqual([...allowed].sort());
    // No member_email / member_name leak.
    expect(payload).not.toHaveProperty('member_email');
    expect(payload).not.toHaveProperty('member_name');
  });

  it('UPDATE payload omits member_* even when input typed values differ from the existing doc', async () => {
    // Operator's exact diagnostic-trace shape: the form passed
    // member_email='tad.e.smith@gmail.com' / member_name='Test' against
    // an existing access doc. The hook must NOT propagate those into
    // the update.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        member_canonical: 'tadesmith@gmail.com',
        member_email: 'Tad.E.Smith@gmail.com',
        member_name: 'Test User',
        importer_callings: {},
        manual_grants: {},
      }),
    });
    const { result } = renderHook(() => useAddManualGrantMutation(), { wrapper });
    await result.current.mutateAsync({
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Test',
      scope: 'stake',
      reason: 'Stake helper',
      level: 'full',
    });
    await waitFor(() => expect(updateDocMock).toHaveBeenCalled());
    const [, payload] = updateDocMock.mock.calls[0]!;
    expect(payload).not.toHaveProperty('member_email');
    expect(payload).not.toHaveProperty('member_name');
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
        level: 'full',
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
      level: 'full',
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
        level: 'full',
      }),
    ).rejects.toThrow(/manual grant with that reason already exists/i);
    expect(updateDocMock).not.toHaveBeenCalled();
  });
});

// Access-level marker. The stored grant carries `level` ONLY for the
// limited tier — full is encoded as the absence of the key. That
// asymmetry is load-bearing rather than stylistic: deletion is an
// `arrayRemove` on the stored object and Firestore matches array
// elements by deep equality, so writing `level: 'full'` would add a key
// the delete path can't reproduce and the grant would be undeletable.
describe('useAddManualGrantMutation — access level', () => {
  const LIMITED_INPUT = {
    member_email: 'subject@example.com',
    member_name: 'Subject',
    scope: 'stake',
    reason: 'Covering bishop',
    level: 'limited',
  } as const;

  const FULL_INPUT = { ...LIMITED_INPUT, level: 'full' } as const;

  it('marks the created grant limited when the Limited level is chosen', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useAddManualGrantMutation(), { wrapper });
    await result.current.mutateAsync(LIMITED_INPUT);
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [, body] = setDocMock.mock.calls[0]!;
    expect(body.manual_grants.stake[0].level).toBe('limited');
  });

  it('writes no level key at all when the Full level is chosen', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useAddManualGrantMutation(), { wrapper });
    await result.current.mutateAsync(FULL_INPUT);
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [, body] = setDocMock.mock.calls[0]!;
    const grant = body.manual_grants.stake[0];
    // Key ABSENCE, not falsiness — `level: undefined` would still
    // serialise into the stored object and break the arrayRemove match.
    expect('level' in grant).toBe(false);
    expect(Object.keys(grant).sort()).toEqual(['grant_id', 'granted_at', 'granted_by', 'reason']);
  });

  it('marks the grant limited on the arrayUnion path for an existing access doc', async () => {
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
    await result.current.mutateAsync(LIMITED_INPUT);
    await waitFor(() => expect(updateDocMock).toHaveBeenCalled());
    const [appended] = arrayUnionMock.mock.calls[0]! as [Record<string, unknown>];
    expect(appended.level).toBe('limited');
    expect(Object.keys(appended).sort()).toEqual([
      'grant_id',
      'granted_at',
      'granted_by',
      'level',
      'reason',
    ]);
  });

  it('removes a limited grant with the exact object that was written', async () => {
    // Add a limited grant and keep the object the mutation built.
    getDocMock.mockResolvedValue({ exists: () => false });
    const add = renderHook(() => useAddManualGrantMutation(), { wrapper });
    await add.result.current.mutateAsync(LIMITED_INPUT);
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const stored = setDocMock.mock.calls[0]![1].manual_grants.stake[0];

    // Hand that same stored object to the delete path, the way the page
    // does when a manager clicks Delete on a rendered grant row. A
    // sibling grant keeps the scope populated so the arrayRemove branch
    // is the one under test.
    updateDocMock.mockClear();
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        importer_callings: { CO: ['Bishop'] },
        manual_grants: { stake: [stored, otherGrant('g-sibling')] },
      }),
    });
    const del = renderHook(() => useDeleteManualGrantMutation(), { wrapper });
    await del.result.current.mutateAsync({
      member_canonical: 'subject@example.com',
      scope: 'stake',
      grant: stored,
    });
    await waitFor(() => expect(updateDocMock).toHaveBeenCalled());

    // The value handed to arrayRemove must deep-equal the written grant,
    // level marker included.
    expect(arrayRemoveMock).toHaveBeenCalledWith(stored);
    const [, payload] = updateDocMock.mock.calls[0]!;
    expect(payload['manual_grants.stake']).toEqual({ __op: 'arrayRemove', values: [stored] });
    // Importer callings survive, so the doc is not garbage-collected.
    expect(deleteDocMock).not.toHaveBeenCalled();
  });
});

// Removal shape. `arrayRemove` on a scope's LAST grant leaves
// `manual_grants: { CO: [] }`, which is not `{}` — the rules' delete
// predicate (`resource.data.manual_grants == {}`) then denies the
// doc-cleanup delete, and the manager sees "insufficient permissions"
// on a removal that in fact succeeded. Dropping the scope KEY is what
// keeps "the doc exists iff some grant exists" true.
function otherGrant(id: string): ManualGrant {
  return {
    grant_id: id,
    reason: `reason-${id}`,
    granted_by: { email: 'Mgr@x.com', canonical: 'mgr@x.com' },
    // Same `Date`-as-Timestamp shortcut the add mutation writes with.
    granted_at: new Date('2026-01-01T00:00:00Z') as unknown as ManualGrant['granted_at'],
  };
}

describe('useDeleteManualGrantMutation — scope-key cleanup', () => {
  const TARGET = otherGrant('g-target');

  function seedDoc(doc: {
    importer_callings?: Record<string, string[]>;
    manual_grants: Record<string, unknown[]>;
  }) {
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({ importer_callings: {}, ...doc }),
    });
  }

  async function removeTarget(scope = 'stake') {
    const del = renderHook(() => useDeleteManualGrantMutation(), { wrapper });
    await del.result.current.mutateAsync({
      member_canonical: 'subject@example.com',
      scope,
      grant: TARGET,
    });
    await waitFor(() => expect(updateDocMock).toHaveBeenCalled());
    return updateDocMock.mock.calls[0]![1] as Record<string, unknown>;
  }

  it('drops the scope key instead of leaving an empty array when the last grant goes', async () => {
    seedDoc({ manual_grants: { stake: [TARGET] } });
    const payload = await removeTarget();
    expect(payload['manual_grants.stake']).toEqual({ __op: 'deleteField' });
    expect(arrayRemoveMock).not.toHaveBeenCalled();
  });

  it('deletes the doc once its last grant leaves and no importer callings remain', async () => {
    seedDoc({ manual_grants: { stake: [TARGET] } });
    await removeTarget();
    await waitFor(() => expect(deleteDocMock).toHaveBeenCalledTimes(1));
  });

  it('uses arrayRemove and keeps the doc when other grants share the scope', async () => {
    seedDoc({ manual_grants: { stake: [TARGET, otherGrant('g-2')] } });
    const payload = await removeTarget();
    expect(payload['manual_grants.stake']).toEqual({ __op: 'arrayRemove', values: [TARGET] });
    expect(deleteFieldMock).not.toHaveBeenCalled();
    expect(deleteDocMock).not.toHaveBeenCalled();
  });

  it('drops the scope key but keeps the doc when importer callings remain', async () => {
    seedDoc({ importer_callings: { CO: ['Bishop'] }, manual_grants: { stake: [TARGET] } });
    const payload = await removeTarget();
    expect(payload['manual_grants.stake']).toEqual({ __op: 'deleteField' });
    expect(deleteDocMock).not.toHaveBeenCalled();
  });

  it('keeps the doc when another scope still holds a grant', async () => {
    seedDoc({ manual_grants: { stake: [TARGET], CO: [otherGrant('g-co')] } });
    const payload = await removeTarget();
    expect(payload['manual_grants.stake']).toEqual({ __op: 'deleteField' });
    expect(payload).not.toHaveProperty('manual_grants.CO');
    expect(deleteDocMock).not.toHaveBeenCalled();
  });

  it('sweeps grant-less scope keys an earlier removal left behind, then deletes the doc', async () => {
    // `{ CO: [] }` is what every pre-fix removal wrote. Left in place it
    // would keep `manual_grants != {}` forever and the doc could never
    // be cleaned up.
    seedDoc({ manual_grants: { stake: [TARGET], CO: [] } });
    const payload = await removeTarget();
    expect(payload['manual_grants.stake']).toEqual({ __op: 'deleteField' });
    expect(payload['manual_grants.CO']).toEqual({ __op: 'deleteField' });
    await waitFor(() => expect(deleteDocMock).toHaveBeenCalledTimes(1));
  });

  it('writes only keys inside the update rule allowlist', async () => {
    seedDoc({ manual_grants: { stake: [TARGET], CO: [] } });
    const payload = await removeTarget();
    // Every key must resolve to one of: manual_grants, last_modified_at,
    // last_modified_by, lastActor.
    const roots = new Set(Object.keys(payload).map((k) => k.split('.')[0]));
    expect([...roots].sort()).toEqual([
      'lastActor',
      'last_modified_at',
      'last_modified_by',
      'manual_grants',
    ]);
    expect(payload['lastActor']).toEqual({
      email: 'Tad.E.Smith@gmail.com',
      canonical: 'tadesmith@gmail.com',
    });
  });

  it('decides the write shape inside one transaction so a concurrent add is not lost', async () => {
    // `deleteField()` is not an atomic array op: read-then-write outside
    // a transaction would clobber a grant added in between.
    seedDoc({ manual_grants: { stake: [TARGET] } });
    await removeTarget();
    expect(runTransactionMock).toHaveBeenCalledTimes(1);
    expect(getDocMock).toHaveBeenCalledTimes(1);
  });

  it('force-refreshes the ID token before the write', async () => {
    seedDoc({ manual_grants: { stake: [TARGET] } });
    await removeTarget();
    expect(getIdTokenResultSpy).toHaveBeenCalledWith(true);
  });

  it('does nothing when the access doc has already been deleted', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const del = renderHook(() => useDeleteManualGrantMutation(), { wrapper });
    await del.result.current.mutateAsync({
      member_canonical: 'subject@example.com',
      scope: 'stake',
      grant: TARGET,
    });
    expect(updateDocMock).not.toHaveBeenCalled();
    expect(deleteDocMock).not.toHaveBeenCalled();
  });
});
