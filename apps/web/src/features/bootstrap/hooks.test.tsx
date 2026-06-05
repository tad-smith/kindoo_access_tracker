// Pure-function tests for hook helpers + hook-level tests for the
// bootstrap building mutation. Hook-level tests mock `firebase/firestore`
// so assertions land on the exact payload the mutation hands to the
// transaction — the unique-name guard, the race-safe create (existence
// pre-check that refuses to clobber an existing building), and the
// immutable-`building_id` create semantics.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('returns a friendly message listing referencing ward names + codes', () => {
    const msg = buildingDeleteBlocker([
      ward({ ward_code: 'CO', ward_name: 'Maple' }),
      ward({ ward_code: 'PR', ward_name: 'Prairie' }),
    ]);
    expect(msg).toMatch(/Cannot delete/);
    expect(msg).toContain('referenced by 2 ward(s)');
    expect(msg).toContain('Maple (CO)');
    expect(msg).toContain('Prairie (PR)');
  });

  it('singular case still labels the count', () => {
    const msg = buildingDeleteBlocker([ward({ ward_code: 'CO', ward_name: 'Maple' })]);
    expect(msg).toContain('1 ward(s)');
    expect(msg).toContain('Maple (CO)');
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
    updateDoc: vi.fn().mockResolvedValue(undefined),
    getDoc: (...args: unknown[]) => getDocMock(...args),
    runTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      runTransactionMock(db, fn),
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
    buildingRef: (_db: unknown, _stakeId: string, buildingId: string) => ({
      __sentinel: 'buildingRef',
      path: `stakes/csnorth/buildings/${buildingId}`,
      id: buildingId,
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

import { useAddBuildingMutation } from './hooks';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  setDocMock.mockClear();
  getDocMock.mockClear();
  serverTimestampMock.mockClear();
  runTransactionMock.mockClear();
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
