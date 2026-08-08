// Pure-function tests for hook helpers + hook-level tests for the
// bootstrap building mutation. Hook-level tests mock `firebase/firestore`
// so assertions land on the exact payload the mutation hands to the
// transaction — the unique-name guard, the race-safe create (existence
// pre-check that refuses to clobber an existing building), and the
// immutable-`building_id` create semantics.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Building, Ward } from '@kindoo/shared';
import { buildingDeleteBlocker, duplicateBuildingNameBlocker } from './hooks';

function ward(overrides: Partial<Ward> = {}): Ward {
  return {
    ward_code: 'CO',
    ward_name: 'Maple',
    building_name: 'Main',
    seat_cap: 20,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides as any),
  } as Ward;
}

function building(overrides: Partial<Building> = {}): Building {
  return {
    building_id: 'main',
    building_name: 'Main Building',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides as any),
  } as Building;
}

describe('buildingDeleteBlocker', () => {
  it('returns null when no ward references the building', () => {
    expect(buildingDeleteBlocker([])).toBeNull();
  });

  it('returns a friendly message listing referencing ward names', () => {
    const msg = buildingDeleteBlocker([
      ward({ ward_code: 'CO', ward_name: 'Maple' }),
      ward({ ward_code: 'PR', ward_name: 'Prairie' }),
    ]);
    expect(msg).toMatch(/Cannot delete/);
    expect(msg).toContain('referenced by 2 ward(s)');
    expect(msg).toContain('Maple');
    expect(msg).toContain('Prairie');
    // The ward code is no longer surfaced in the UI.
    expect(msg).not.toContain('(CO)');
    expect(msg).not.toContain('(PR)');
  });

  it('singular case still labels the count', () => {
    const msg = buildingDeleteBlocker([ward({ ward_code: 'CO', ward_name: 'Maple' })]);
    expect(msg).toContain('1 ward(s)');
    expect(msg).toContain('Maple');
    expect(msg).not.toContain('(CO)');
  });
});

describe('bootstrap duplicateBuildingNameBlocker', () => {
  const buildings = [
    building({ building_id: 'maple-building', building_name: 'Maple Building' }),
    building({ building_id: 'pine-building', building_name: 'Pine Building' }),
  ];

  it('returns null when the name is free', () => {
    expect(duplicateBuildingNameBlocker('Oak Building', buildings)).toBeNull();
  });

  it('blocks when another building already uses the name', () => {
    const msg = duplicateBuildingNameBlocker('Pine Building', buildings);
    expect(msg).toContain('Building names must be unique');
  });

  it('matches case-insensitively and trims', () => {
    expect(duplicateBuildingNameBlocker('  pine building ', buildings)).not.toBeNull();
  });

  it('returns null for an empty name (the slug guard handles emptiness)', () => {
    expect(duplicateBuildingNameBlocker('   ', buildings)).toBeNull();
  });
});

// ---- Hook-level: bootstrap building create --------------------------
//
// Mock `firebase/firestore` so the assertions land on the payload the
// mutation hands to the transaction. The load-bearing branches: the
// unique-display-name guard, the existence pre-check that refuses to
// clobber an existing building (the old `setDoc`-without-`merge` reset
// `created_at` and wiped fields), and immutable-slug create semantics.

const setDocMock = vi.fn().mockResolvedValue(undefined);
const updateDocMock = vi.fn().mockResolvedValue(undefined);
const getDocMock = vi.fn();
const serverTimestampMock = vi.fn(() => '__server_timestamp__');
// runTransaction shim — invokes the callback with a tx that delegates
// tx.get to getDocMock and tx.set to setDocMock.
const runTransactionMock = vi.fn(async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
  const tx = {
    get: (ref: unknown) => getDocMock(ref),
    set: (ref: unknown, data: unknown, options?: unknown) =>
      options === undefined ? setDocMock(ref, data) : setDocMock(ref, data, options),
  };
  return fn(tx);
});

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<object>('firebase/firestore');
  return {
    ...actual,
    setDoc: (...args: unknown[]) => setDocMock(...args),
    deleteDoc: vi.fn().mockResolvedValue(undefined),
    updateDoc: (...args: unknown[]) => updateDocMock(...args),
    getDoc: (...args: unknown[]) => getDocMock(...args),
    runTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      runTransactionMock(db, fn),
    serverTimestamp: () => serverTimestampMock(),
  };
});

// `getIdTokenMock` backs `refreshIdToken()` and `getIdTokenResultMock`
// backs the claim read in `waitForManagerClaim` (both via
// `auth.currentUser`), which `useCompleteSetupMutation` calls before
// flipping `setup_complete`. `getIdTokenResultMock` defaults to a token
// that already carries the `manager` claim on the active stake
// ('csnorth', per the `useActiveStake` mock below) so every other
// describe block (none of which touch `auth`) is unaffected; the
// `useCompleteSetupMutation` tests below override behaviour per case.
// `vi.hoisted` is required here (unlike the plain top-level `const`s
// above) because the `vi.mock` factory below reads `authMock` as a
// value at mock-registration time rather than closing over it inside a
// lazily-invoked function — without `vi.hoisted` that read lands in the
// TDZ, since `vi.mock` calls are hoisted above ordinary `const`s.
const { getIdTokenMock, getIdTokenResultMock, authMock } = vi.hoisted(() => {
  const getIdTokenMock = vi.fn().mockResolvedValue(undefined);
  const getIdTokenResultMock = vi
    .fn()
    .mockResolvedValue({ claims: { stakes: { csnorth: { manager: true } } } });
  const authMock: {
    currentUser: {
      getIdToken: typeof getIdTokenMock;
      getIdTokenResult: typeof getIdTokenResultMock;
    } | null;
  } = {
    currentUser: { getIdToken: getIdTokenMock, getIdTokenResult: getIdTokenResultMock },
  };
  return { getIdTokenMock, getIdTokenResultMock, authMock };
});

vi.mock('../../lib/firebase', () => ({
  db: { __sentinel: 'db' },
  auth: authMock,
}));

vi.mock('../../lib/docs', async () => {
  const actual = await vi.importActual<object>('../../lib/docs');
  return {
    ...actual,
    buildingRef: (_db: unknown, _stakeId: string, buildingId: string) => ({
      __sentinel: 'buildingRef',
      path: `stakes/csnorth/buildings/${buildingId}`,
      id: buildingId,
    }),
    wardRef: (_db: unknown, _stakeId: string, wardCode: string) => ({
      __sentinel: 'wardRef',
      path: `stakes/csnorth/wards/${wardCode}`,
      id: wardCode,
    }),
    stakeRef: (_db: unknown, stakeId: string) => ({
      __sentinel: 'stakeRef',
      path: `stakes/${stakeId}`,
      id: stakeId,
    }),
  };
});

vi.mock('../../lib/principal', () => ({
  usePrincipal: () => ({
    email: 'admin@example.com',
    canonical: 'admin@example.com',
    firebaseAuthSignedIn: true,
    isAuthenticated: true,
  }),
}));

vi.mock('../../lib/useActiveStake', () => ({
  useActiveStake: () => 'csnorth',
}));

import {
  useAddBuildingMutation,
  useAddWardMutation,
  useCompleteSetupMutation,
  useStep1Mutation,
} from './hooks';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  setDocMock.mockClear();
  updateDocMock.mockClear();
  getDocMock.mockClear();
  serverTimestampMock.mockClear();
  runTransactionMock.mockClear();
  getIdTokenMock.mockClear();
  getIdTokenMock.mockReset().mockResolvedValue(undefined);
  getIdTokenResultMock.mockClear();
  getIdTokenResultMock
    .mockReset()
    .mockResolvedValue({ claims: { stakes: { csnorth: { manager: true } } } });
  authMock.currentUser = { getIdToken: getIdTokenMock, getIdTokenResult: getIdTokenResultMock };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useStep1Mutation', () => {
  it('writes the Elders Quorum President app-access opt-in alongside the stake fields', async () => {
    const { result } = renderHook(() => useStep1Mutation(), { wrapper });
    await result.current.mutateAsync({
      stake_name: 'My Stake',
      stake_seat_cap: 200,
      eq_president_app_access: true,
    });
    await waitFor(() => expect(updateDocMock).toHaveBeenCalled());
    const [, body] = updateDocMock.mock.calls[0]!;
    expect(body).toMatchObject({
      stake_name: 'My Stake',
      stake_seat_cap: 200,
      eq_president_app_access: true,
      lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
    });
  });

  it('persists the opt-in as false when the wizard leaves the switch off', async () => {
    const { result } = renderHook(() => useStep1Mutation(), { wrapper });
    await result.current.mutateAsync({
      stake_name: 'My Stake',
      stake_seat_cap: 200,
      eq_president_app_access: false,
    });
    await waitFor(() => expect(updateDocMock).toHaveBeenCalled());
    const [, body] = updateDocMock.mock.calls[0]!;
    expect(body).toMatchObject({ eq_president_app_access: false });
  });
});

describe('useAddBuildingMutation', () => {
  it('derives the immutable building_id slug from the name and stamps created_at on create', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useAddBuildingMutation(), { wrapper });
    await result.current.mutateAsync({ building_name: 'Maple Building', address: '123 Main' });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [ref, body] = setDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({ path: 'stakes/csnorth/buildings/maple-building' });
    expect(body).toMatchObject({
      building_id: 'maple-building',
      building_name: 'Maple Building',
      address: '123 Main',
      created_at: '__server_timestamp__',
      lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
    });
  });

  it('blocks the create when another building already uses the chosen name', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useAddBuildingMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        building_name: 'Pine Building',
        address: '123 Main',
        existingBuildings: [
          building({ building_id: 'pine-building', building_name: 'Pine Building' }),
        ],
      }),
    ).rejects.toThrow(/Building names must be unique/i);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('refuses to clobber an existing building when the typed name slugs to an existing doc', async () => {
    // The defect: `setDoc` without `merge` overwrote the existing doc,
    // resetting created_at and wiping fields. The existence pre-check in
    // the transaction now surfaces an explicit error instead.
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useAddBuildingMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({ building_name: 'Maple Building', address: '123 Main' }),
    ).rejects.toThrow(/already exists/i);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('wraps the existence pre-check + write in a single runTransaction (race-safe)', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useAddBuildingMutation(), { wrapper });
    await result.current.mutateAsync({ building_name: 'Oak Building', address: '' });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    expect(runTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when the slug derived from the name is empty', async () => {
    const { result } = renderHook(() => useAddBuildingMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({ building_name: '   ', address: '123 Main' }),
    ).rejects.toThrow(/Building name is required/i);
    expect(setDocMock).not.toHaveBeenCalled();
  });
});

describe('useAddWardMutation', () => {
  it('derives the ward_code from the name via buildingSlug on create', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useAddWardMutation(), { wrapper });
    await result.current.mutateAsync({
      ward_name: '3rd Ward',
      building_id: 'maple-building',
      building_name: 'Maple Building',
      seat_cap: 20,
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [ref, body] = setDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({ path: 'stakes/csnorth/wards/3rd-ward' });
    expect(body).toMatchObject({
      ward_code: '3rd-ward',
      ward_name: '3rd Ward',
      building_id: 'maple-building',
      building_name: 'Maple Building',
      seat_cap: 20,
      created_at: '__server_timestamp__',
      lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
    });
  });

  it('rejects a name that slugs to an existing ward', async () => {
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useAddWardMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        ward_name: 'Maple Ward',
        building_id: 'maple-building',
        building_name: 'Maple Building',
        seat_cap: 20,
      }),
    ).rejects.toThrow(/already exists/i);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('wraps the existence pre-check + write in a single runTransaction (race-safe)', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useAddWardMutation(), { wrapper });
    await result.current.mutateAsync({
      ward_name: 'Oak Ward',
      building_id: 'maple-building',
      building_name: 'Maple Building',
      seat_cap: 20,
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    expect(runTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when the slug derived from the name is empty', async () => {
    const { result } = renderHook(() => useAddWardMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        ward_name: '   ',
        building_id: 'maple-building',
        building_name: 'Maple Building',
        seat_cap: 20,
      }),
    ).rejects.toThrow(/Ward name is required/i);
    expect(setDocMock).not.toHaveBeenCalled();
  });
});

// ---- Hook-level: complete setup --------------------------------------
//
// The defect this closes: once `setup_complete` flips true,
// `isBootstrapAdmin`/`isSetupInProgressReadable` (firestore.rules) go
// silent, and the client needs the `manager` claim
// `useEnsureBootstrapAdmin` minted earlier in the wizard already loaded
// onto its cached ID token — or the post-flip stake-doc read
// permission-denies and the admin bounces to NotAuthorized.
//
// A refresh alone doesn't prove the claim arrived — a transient failure
// of the wizard's fire-and-forget auto-add, or a silent
// `uidForCanonical` miss in `syncManagersClaims`, can leave the token
// claimless even after a fresh fetch. So on top of the ordering
// assertion (refresh lands before the write goes out — a call-count
// assertion alone is exactly what let the equivalent D28(d) bug ship),
// the tests below assert the fail-closed gate: a claim that never
// lands must block the write outright, not just log a warning and
// proceed.
describe('useCompleteSetupMutation', () => {
  it('refreshes the ID token before flipping setup_complete, not in onSuccess after it', async () => {
    const callOrder: string[] = [];
    getIdTokenMock.mockImplementation(async () => {
      callOrder.push('refresh');
    });
    updateDocMock.mockImplementationOnce(async () => {
      callOrder.push('write');
    });
    const { result } = renderHook(() => useCompleteSetupMutation(), { wrapper });
    await result.current.mutateAsync();
    expect(callOrder).toEqual(['refresh', 'write']);
    // Force-refresh, not a read of the (possibly stale) cached token.
    expect(getIdTokenMock).toHaveBeenCalledWith(true);
  });

  it('leaves setup_complete unwritten when the token refresh fails', async () => {
    getIdTokenMock.mockRejectedValue(new Error('network blip'));
    const { result } = renderHook(() => useCompleteSetupMutation(), { wrapper });
    await expect(result.current.mutateAsync()).rejects.toThrow(/network blip/);
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('still writes setup_complete=true with the lastActor integrity field', async () => {
    const { result } = renderHook(() => useCompleteSetupMutation(), { wrapper });
    await result.current.mutateAsync();
    await waitFor(() => expect(updateDocMock).toHaveBeenCalled());
    const [ref, body] = updateDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({ path: 'stakes/csnorth' });
    expect(body).toMatchObject({
      setup_complete: true,
      last_modified_at: '__server_timestamp__',
      last_modified_by: { email: 'admin@example.com', canonical: 'admin@example.com' },
      lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
    });
  });

  it('proceeds with the flip once the manager claim is confirmed present after the refresh', async () => {
    getIdTokenResultMock.mockResolvedValue({
      claims: { stakes: { csnorth: { manager: true } } },
    });
    const { result } = renderHook(() => useCompleteSetupMutation(), { wrapper });
    await result.current.mutateAsync();
    await waitFor(() => expect(updateDocMock).toHaveBeenCalledTimes(1));
  });

  // The gap PR #260's reviewer found: the prior fix refreshed and
  // proceeded regardless. A claim that never lands must leave the stake
  // doc untouched — asserted on the write itself, not merely on the
  // rejection, since a rejected promise with a write that fired anyway
  // would still strand the admin.
  it('never calls updateDoc and rejects the mutation when the manager claim never arrives', async () => {
    vi.useFakeTimers();
    getIdTokenResultMock.mockResolvedValue({ claims: {} });
    const { result } = renderHook(() => useCompleteSetupMutation(), { wrapper });
    const pending = result.current.mutateAsync();
    const assertion = expect(pending).rejects.toThrow(/setup access is still syncing/i);
    await act(() => vi.runAllTimersAsync());
    await assertion;
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  // Proves the retry loop actually re-checks rather than the first read
  // happening to already succeed (the previous test's mock never
  // resolves the claim; this one resolves it two retries in).
  it('proceeds with the flip when the manager claim arrives on a later retry', async () => {
    vi.useFakeTimers();
    getIdTokenResultMock
      .mockResolvedValueOnce({ claims: {} })
      .mockResolvedValueOnce({ claims: {} })
      .mockResolvedValueOnce({ claims: { stakes: { csnorth: { manager: true } } } });
    const { result } = renderHook(() => useCompleteSetupMutation(), { wrapper });
    const pending = result.current.mutateAsync();
    await act(() => vi.runAllTimersAsync());
    await pending;
    expect(getIdTokenResultMock).toHaveBeenCalledTimes(3);
    expect(updateDocMock).toHaveBeenCalledTimes(1);
  });
});
