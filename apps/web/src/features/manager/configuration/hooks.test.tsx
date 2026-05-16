// Pure-function tests for configuration hook helpers + hook-level
// tests for the KindooSite mutations. The hook-level tests mock
// `firebase/firestore` so the assertions land on the exact payload
// the mutation hands to `setDoc` / `deleteDoc` — slug derivation,
// slug stability on rename, create-time collision pre-check, merge-
// write semantics that preserve extension-written `kindoo_eid`, and
// edit-vs-create branching.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Building, Ward } from '@kindoo/shared';

// ---- Pure helpers ---------------------------------------------------

import {
  buildingDeleteBlocker,
  kindooSiteDeleteBlocker,
  nextSheetOrder,
  planDeleteResequenceWrites,
  planReorderWrites,
} from './hooks';

function ward(overrides: Partial<Ward> = {}): Ward {
  return {
    ward_code: 'CO',
    ward_name: 'Cordera',
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

describe('configuration buildingDeleteBlocker', () => {
  it('returns null when no ward references the building', () => {
    expect(buildingDeleteBlocker([])).toBeNull();
  });

  it('returns a message listing referencing ward names + codes', () => {
    const msg = buildingDeleteBlocker([
      ward({ ward_code: 'CO', ward_name: 'Cordera' }),
      ward({ ward_code: 'PR', ward_name: 'Prairie' }),
    ]);
    expect(msg).toContain('Cannot delete');
    expect(msg).toContain('2 ward(s)');
    expect(msg).toContain('Cordera (CO)');
    expect(msg).toContain('Prairie (PR)');
  });
});

describe('configuration kindooSiteDeleteBlocker', () => {
  it('returns null when no ward or building references the site', () => {
    expect(kindooSiteDeleteBlocker('east-stake', [], [])).toBeNull();
  });

  it('returns a message listing referencing wards when only wards block', () => {
    const msg = kindooSiteDeleteBlocker(
      'east-stake',
      [
        ward({ ward_code: 'CO', ward_name: 'Cordera', kindoo_site_id: 'east-stake' }),
        ward({ ward_code: 'PC', ward_name: 'Pine Creek', kindoo_site_id: 'east-stake' }),
      ],
      [],
    );
    expect(msg).toContain('Cannot delete Kindoo site "east-stake"');
    expect(msg).toContain('Wards: Cordera (CO), Pine Creek (PC)');
    expect(msg).not.toContain('Buildings:');
    expect(msg).toContain('Unassign these wards / buildings from this site before deleting.');
  });

  it('returns a message listing referencing buildings when only buildings block', () => {
    const msg = kindooSiteDeleteBlocker(
      'east-stake',
      [],
      [building({ building_id: 'foothills', building_name: 'Foothills Stake Center' })],
    );
    expect(msg).toContain('Cannot delete Kindoo site "east-stake"');
    expect(msg).not.toContain('Wards:');
    expect(msg).toContain('Buildings: Foothills Stake Center');
  });

  it('groups wards and buildings on separate lines when both block', () => {
    const msg = kindooSiteDeleteBlocker(
      'east-stake',
      [ward({ ward_code: 'CO', ward_name: 'Cordera', kindoo_site_id: 'east-stake' })],
      [building({ building_id: 'foothills', building_name: 'Foothills Stake Center' })],
    );
    expect(msg).toContain('Wards: Cordera (CO)');
    expect(msg).toContain('Buildings: Foothills Stake Center');
  });
});

describe('configuration nextSheetOrder', () => {
  it('returns 1 when the existing list is empty', () => {
    expect(nextSheetOrder([])).toBe(1);
  });

  it('returns max+1 across the existing rows', () => {
    expect(nextSheetOrder([{ sheet_order: 1 }, { sheet_order: 5 }, { sheet_order: 3 }])).toBe(6);
  });
});

describe('configuration planReorderWrites', () => {
  it('returns the rows whose new contiguous order differs from current', () => {
    const current = [
      { calling_name: 'A', sheet_order: 1 },
      { calling_name: 'B', sheet_order: 2 },
      { calling_name: 'C', sheet_order: 3 },
    ];
    // Move C to top → only A→2, B→3, C→1 differ.
    const writes = planReorderWrites(['C', 'A', 'B'], current);
    expect(writes).toEqual([
      { calling_name: 'C', sheet_order: 1 },
      { calling_name: 'A', sheet_order: 2 },
      { calling_name: 'B', sheet_order: 3 },
    ]);
  });

  it('skips rows whose order is already correct', () => {
    const current = [
      { calling_name: 'A', sheet_order: 1 },
      { calling_name: 'B', sheet_order: 2 },
      { calling_name: 'C', sheet_order: 3 },
    ];
    // Identity reorder → no writes.
    expect(planReorderWrites(['A', 'B', 'C'], current)).toEqual([]);
  });

  it('writes only the changed positions when adjacent rows swap', () => {
    const current = [
      { calling_name: 'A', sheet_order: 1 },
      { calling_name: 'B', sheet_order: 2 },
      { calling_name: 'C', sheet_order: 3 },
    ];
    const writes = planReorderWrites(['A', 'C', 'B'], current);
    expect(writes).toEqual([
      { calling_name: 'C', sheet_order: 2 },
      { calling_name: 'B', sheet_order: 3 },
    ]);
  });
});

describe('configuration planDeleteResequenceWrites', () => {
  it('renumbers survivors to contiguous 1..N-1 when middle row is deleted', () => {
    const current = [
      { calling_name: 'A', sheet_order: 1 },
      { calling_name: 'B', sheet_order: 2 },
      { calling_name: 'C', sheet_order: 3 },
    ];
    expect(planDeleteResequenceWrites('B', current)).toEqual([
      { calling_name: 'C', sheet_order: 2 },
    ]);
  });

  it('returns no writes when the deleted row is at the end', () => {
    const current = [
      { calling_name: 'A', sheet_order: 1 },
      { calling_name: 'B', sheet_order: 2 },
      { calling_name: 'C', sheet_order: 3 },
    ];
    expect(planDeleteResequenceWrites('C', current)).toEqual([]);
  });

  it('handles non-contiguous starting state by writing every survivor that needs to move', () => {
    const current = [
      { calling_name: 'A', sheet_order: 5 },
      { calling_name: 'B', sheet_order: 7 },
      { calling_name: 'C', sheet_order: 9 },
    ];
    expect(planDeleteResequenceWrites('B', current)).toEqual([
      { calling_name: 'A', sheet_order: 1 },
      { calling_name: 'C', sheet_order: 2 },
    ]);
  });
});

// ---- Hook-level: KindooSite mutations -------------------------------
//
// The hook-level tests below mock `firebase/firestore` so the
// assertions land on the exact payload the mutation hands to
// `setDoc` / `deleteDoc` — there's no live Firestore round-trip. The
// load-bearing branches are slug derivation, slug stability on
// rename, the create-time collision pre-check, the merge: true write
// (which preserves extension-written `kindoo_eid`), and the edit-vs-
// create branching on `input.id`.

const setDocMock = vi.fn().mockResolvedValue(undefined);
const deleteDocMock = vi.fn().mockResolvedValue(undefined);
const getDocMock = vi.fn();
const updateDocMock = vi.fn().mockResolvedValue(undefined);
const writeBatchMock = vi.fn();
const serverTimestampMock = vi.fn(() => '__server_timestamp__');
// runTransaction shim — invokes the callback with a tx that delegates
// tx.get to getDocMock and tx.set to setDocMock so create-path assertions
// (collision pre-check + payload shape) work without a real Firestore.
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
    deleteDoc: (...args: unknown[]) => deleteDocMock(...args),
    getDoc: (...args: unknown[]) => getDocMock(...args),
    updateDoc: (...args: unknown[]) => updateDocMock(...args),
    runTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      runTransactionMock(db, fn),
    writeBatch: () => writeBatchMock(),
    serverTimestamp: () => serverTimestampMock(),
  };
});

vi.mock('../../../lib/firebase', () => ({
  db: { __sentinel: 'db' },
  auth: { currentUser: null },
}));

vi.mock('../../../lib/docs', async () => {
  const actual = await vi.importActual<object>('../../../lib/docs');
  return {
    ...actual,
    kindooSiteRef: (_db: unknown, _stakeId: string, kindooSiteId: string) => ({
      __sentinel: 'kindooSiteRef',
      path: `stakes/csnorth/kindooSites/${kindooSiteId}`,
      id: kindooSiteId,
    }),
  };
});

vi.mock('../../../lib/principal', () => ({
  usePrincipal: () => ({
    email: 'mgr@example.com',
    canonical: 'mgr@example.com',
    firebaseAuthSignedIn: true,
    isAuthenticated: true,
  }),
}));

import { useDeleteKindooSiteMutation, useUpsertKindooSiteMutation } from './hooks';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  setDocMock.mockClear();
  deleteDocMock.mockClear();
  getDocMock.mockClear();
  updateDocMock.mockClear();
  writeBatchMock.mockClear();
  serverTimestampMock.mockClear();
  runTransactionMock.mockClear();
});

describe('useUpsertKindooSiteMutation', () => {
  it('derives the doc id from display_name via buildingSlug on create', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useUpsertKindooSiteMutation(), { wrapper });
    await result.current.mutateAsync({
      display_name: 'East Stake Foothills',
      kindoo_expected_site_name: 'East Stake Foothills CS',
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [ref, body, options] = setDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({
      path: 'stakes/csnorth/kindooSites/east-stake-foothills',
      id: 'east-stake-foothills',
    });
    expect(body).toMatchObject({
      id: 'east-stake-foothills',
      display_name: 'East Stake Foothills',
      kindoo_expected_site_name: 'East Stake Foothills CS',
    });
    // merge: true is load-bearing — it preserves any extension-written
    // kindoo_eid the manager UI doesn't surface.
    expect(options).toEqual({ merge: true });
  });

  it('keeps the doc id stable when the operator renames an existing site (no re-slug)', async () => {
    // Edit path: caller passes the existing id. Even though the new
    // display_name would slug to a DIFFERENT value, the mutation must
    // use the existing id so wards / buildings referencing the slug
    // don't dangle.
    const { result } = renderHook(() => useUpsertKindooSiteMutation(), { wrapper });
    await result.current.mutateAsync({
      id: 'east-stake-foothills',
      display_name: 'Other Name',
      kindoo_expected_site_name: 'Other Name CS',
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [ref, body] = setDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({
      path: 'stakes/csnorth/kindooSites/east-stake-foothills',
      id: 'east-stake-foothills',
    });
    expect(body).toMatchObject({
      id: 'east-stake-foothills',
      display_name: 'Other Name',
    });
    // No collision pre-check on edit — the existing doc IS the target.
    expect(getDocMock).not.toHaveBeenCalled();
  });

  it('refuses to silently overwrite when the derived slug collides on create', async () => {
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertKindooSiteMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        display_name: 'East Stake Foothills',
        kindoo_expected_site_name: 'East Stake Foothills CS',
      }),
    ).rejects.toThrow(/already exists/i);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('writes with merge: true so extension-written kindoo_eid is preserved on edit', async () => {
    // The mutation never writes `kindoo_eid` — the manager UI doesn't
    // expose it — and `setDoc(..., { merge: true })` leaves any field
    // not in the body alone. This test pins both invariants in the
    // payload shape: kindoo_eid is absent from the write AND the
    // mutation passes merge: true so Firestore preserves the existing
    // value.
    const { result } = renderHook(() => useUpsertKindooSiteMutation(), { wrapper });
    await result.current.mutateAsync({
      id: 'east-stake-foothills',
      display_name: 'East Stake Foothills (renamed)',
      kindoo_expected_site_name: 'East Stake Foothills CS',
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [, body, options] = setDocMock.mock.calls[0]!;
    expect(body).not.toHaveProperty('kindoo_eid');
    expect(options).toEqual({ merge: true });
  });

  it('rejects when the derived slug is empty', async () => {
    const { result } = renderHook(() => useUpsertKindooSiteMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        display_name: '   ',
        kindoo_expected_site_name: 'CS',
      }),
    ).rejects.toThrow(/Display name is required/i);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('stamps lastActor from the signed-in principal', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useUpsertKindooSiteMutation(), { wrapper });
    await result.current.mutateAsync({
      display_name: 'East Stake Foothills',
      kindoo_expected_site_name: 'East Stake Foothills CS',
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [, body] = setDocMock.mock.calls[0]!;
    expect(body).toMatchObject({
      lastActor: { email: 'mgr@example.com', canonical: 'mgr@example.com' },
    });
  });

  it('wraps the create-path existence check + set in a single runTransaction', async () => {
    // Guards against the read-then-write race: two concurrent creates
    // with the same slug must not both pass the pre-check and clobber.
    // Edit path takes a plain setDoc — no transaction needed.
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useUpsertKindooSiteMutation(), { wrapper });
    await result.current.mutateAsync({
      display_name: 'East Stake Foothills',
      kindoo_expected_site_name: 'East Stake Foothills CS',
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    expect(runTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('edit path skips runTransaction (no existence check; plain merge-write)', async () => {
    const { result } = renderHook(() => useUpsertKindooSiteMutation(), { wrapper });
    await result.current.mutateAsync({
      id: 'east-stake-foothills',
      display_name: 'East Stake Foothills (renamed)',
      kindoo_expected_site_name: 'East Stake Foothills CS',
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    expect(runTransactionMock).not.toHaveBeenCalled();
  });
});

describe('useDeleteKindooSiteMutation', () => {
  const refWard = (overrides: Partial<Ward> = {}): Ward =>
    ({
      ward_code: 'CO',
      ward_name: 'Cordera',
      building_name: 'Cordera Building',
      seat_cap: 20,
      kindoo_site_id: 'east-stake',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(overrides as any),
    }) as Ward;

  const refBuilding = (overrides: Partial<Building> = {}): Building =>
    ({
      building_id: 'foothills',
      building_name: 'Foothills Stake Center',
      kindoo_site_id: 'east-stake',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(overrides as any),
    }) as Building;

  it('deletes the site doc when no ward or building still references it', async () => {
    const { result } = renderHook(() => useDeleteKindooSiteMutation(), { wrapper });
    await result.current.mutateAsync({
      kindooSiteId: 'east-stake',
      wards: [refWard({ kindoo_site_id: null })],
      buildings: [refBuilding({ kindoo_site_id: null })],
    });
    await waitFor(() => expect(deleteDocMock).toHaveBeenCalled());
    const [ref] = deleteDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({ path: 'stakes/csnorth/kindooSites/east-stake' });
  });

  it('refuses to delete when a ward still references the site', async () => {
    const { result } = renderHook(() => useDeleteKindooSiteMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        kindooSiteId: 'east-stake',
        wards: [refWard()],
        buildings: [],
      }),
    ).rejects.toThrow(/Cannot delete Kindoo site "east-stake"/);
    expect(deleteDocMock).not.toHaveBeenCalled();
  });

  it('refuses to delete when a building still references the site', async () => {
    const { result } = renderHook(() => useDeleteKindooSiteMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        kindooSiteId: 'east-stake',
        wards: [],
        buildings: [refBuilding()],
      }),
    ).rejects.toThrow(/Foothills Stake Center/);
    expect(deleteDocMock).not.toHaveBeenCalled();
  });

  it('error message lists wards and buildings when both block', async () => {
    const { result } = renderHook(() => useDeleteKindooSiteMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        kindooSiteId: 'east-stake',
        wards: [refWard()],
        buildings: [refBuilding()],
      }),
    ).rejects.toThrow(/Cordera \(CO\).*Foothills Stake Center/s);
  });

  it('ignores wards / buildings pointing at a different site', async () => {
    const { result } = renderHook(() => useDeleteKindooSiteMutation(), { wrapper });
    await result.current.mutateAsync({
      kindooSiteId: 'east-stake',
      wards: [refWard({ kindoo_site_id: 'west-stake' })],
      buildings: [refBuilding({ kindoo_site_id: 'west-stake' })],
    });
    await waitFor(() => expect(deleteDocMock).toHaveBeenCalled());
  });
});
