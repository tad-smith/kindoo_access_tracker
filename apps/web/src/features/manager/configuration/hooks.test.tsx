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
import type { AccessRequest, Building, Seat, Ward } from '@kindoo/shared';

// ---- Pure helpers ---------------------------------------------------

import {
  buildingDeleteBlocker,
  buildingRenameBlocker,
  duplicateBuildingNameBlocker,
  duplicateOrganizationNameBlocker,
  duplicateWardNameBlocker,
  kindooSiteDeleteBlocker,
  organizationDeleteBlocker,
} from './hooks';
import type { DuplicateGrant, Organization } from '@kindoo/shared';

function organization(overrides: Partial<Organization> = {}): Organization {
  return {
    organization_id: 'primary-children',
    name: 'Primary Children',
    seat_cap: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides as any),
  } as Organization;
}

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

function seat(overrides: Partial<Seat> = {}): Seat {
  return {
    member_canonical: 'a@x.com',
    member_email: 'a@x.com',
    member_name: 'A',
    scope: 'CO',
    type: 'manual',
    callings: [],
    building_names: ['Black Forest'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides as any),
  } as Seat;
}

function request(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    request_id: 'r1',
    type: 'add_manual',
    scope: 'CO',
    member_email: 'a@x.com',
    member_canonical: 'a@x.com',
    member_name: 'A',
    reason: 'Calling',
    building_names: ['Black Forest'],
    status: 'pending',
    requester_email: 'a@x.com',
    requester_canonical: 'a@x.com',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides as any),
  } as AccessRequest;
}

describe('configuration buildingDeleteBlocker', () => {
  it('returns null when no ward references the building', () => {
    expect(buildingDeleteBlocker([])).toBeNull();
  });

  it('returns a message listing referencing ward names', () => {
    const msg = buildingDeleteBlocker([
      ward({ ward_code: 'CO', ward_name: 'Maple' }),
      ward({ ward_code: 'PR', ward_name: 'Prairie' }),
    ]);
    expect(msg).toContain('Cannot delete');
    expect(msg).toContain('2 ward(s)');
    expect(msg).toContain('Maple');
    expect(msg).toContain('Prairie');
    // The ward code is no longer surfaced in the UI.
    expect(msg).not.toContain('(CO)');
    expect(msg).not.toContain('(PR)');
  });
});

describe('configuration duplicateWardNameBlocker', () => {
  // A legacy ward stored at doc id 'CO' with display name 'Maple' — the
  // case the slug-only check misses (a new 'Maple' slugs to 'maple', not
  // 'CO', so only a name-based guard catches it).
  const wards = [
    ward({ ward_code: 'CO', ward_name: 'Maple' }),
    ward({ ward_code: 'PR', ward_name: 'Prairie' }),
  ];

  it('returns null when the name is free', () => {
    expect(duplicateWardNameBlocker('Oak', wards, undefined)).toBeNull();
  });

  it('blocks a new ward whose name matches a legacy 2-letter-coded ward', () => {
    const msg = duplicateWardNameBlocker('Maple', wards, undefined);
    expect(msg).toContain('Ward names must be unique');
  });

  it('blocks a rename onto another existing ward name', () => {
    // Editing PR (Prairie) and renaming it to Maple must be blocked.
    expect(duplicateWardNameBlocker('Maple', wards, 'PR')).not.toBeNull();
  });

  it('ignores the ward being edited (same code)', () => {
    expect(duplicateWardNameBlocker('Maple', wards, 'CO')).toBeNull();
  });

  it('matches case-insensitively and trims', () => {
    expect(duplicateWardNameBlocker('  maple ', wards, undefined)).not.toBeNull();
  });
});

describe('configuration duplicateBuildingNameBlocker', () => {
  const buildings = [
    building({ building_id: 'maple-building', building_name: 'Maple Building' }),
    building({ building_id: 'pine-building', building_name: 'Pine Building' }),
  ];

  it('returns null when the name is free', () => {
    expect(duplicateBuildingNameBlocker('Oak Building', buildings, undefined)).toBeNull();
  });

  it('blocks when another building (different slug) uses the name', () => {
    const msg = duplicateBuildingNameBlocker('Pine Building', buildings, 'maple-building');
    expect(msg).toContain('Building names must be unique');
  });

  it('ignores the building being edited (same slug)', () => {
    expect(duplicateBuildingNameBlocker('Maple Building', buildings, 'maple-building')).toBeNull();
  });

  it('matches case-insensitively and trims', () => {
    expect(duplicateBuildingNameBlocker('  pine building ', buildings, undefined)).not.toBeNull();
  });
});

describe('configuration buildingRenameBlocker', () => {
  it('returns null when nothing references the current name', () => {
    expect(
      buildingRenameBlocker('Black Forest', [seat({ building_names: ['Maple'] })], []),
    ).toBeNull();
  });

  it('blocks when an active seat snapshots the current name', () => {
    const msg = buildingRenameBlocker(
      'Black Forest',
      [seat({ building_names: ['Black Forest'] })],
      [],
    );
    expect(msg).toContain('Can\'t rename "Black Forest"');
    // Singular subject → singular verb "references".
    expect(msg).toContain('1 seat references it');
    expect(msg).toContain('Remove or reassign them first.');
  });

  it('blocks when a pending request snapshots the current name', () => {
    const msg = buildingRenameBlocker(
      'Black Forest',
      [],
      [request({ status: 'pending', building_names: ['Black Forest'] })],
    );
    // Singular subject → singular verb "references".
    expect(msg).toContain('1 pending request references it');
  });

  it('allows the rename when the only reference is a completed request (historical)', () => {
    expect(
      buildingRenameBlocker(
        'Black Forest',
        [],
        [request({ status: 'complete', building_names: ['Black Forest'] })],
      ),
    ).toBeNull();
  });

  it('allows the rename when the only reference is a rejected request (historical)', () => {
    expect(
      buildingRenameBlocker(
        'Black Forest',
        [],
        [request({ status: 'rejected', building_names: ['Black Forest'] })],
      ),
    ).toBeNull();
  });

  it('allows the rename when the only reference is a cancelled request (historical)', () => {
    expect(
      buildingRenameBlocker(
        'Black Forest',
        [],
        [request({ status: 'cancelled', building_names: ['Black Forest'] })],
      ),
    ).toBeNull();
  });

  it('counts and pluralizes seats + pending requests in the message', () => {
    const msg = buildingRenameBlocker(
      'Black Forest',
      [
        seat({ member_canonical: 's1@x.com', building_names: ['Black Forest'] }),
        seat({ member_canonical: 's2@x.com', building_names: ['Black Forest'] }),
        seat({ member_canonical: 's3@x.com', building_names: ['Other'] }),
      ],
      [
        request({ request_id: 'r1', status: 'pending', building_names: ['Black Forest'] }),
        request({ request_id: 'r2', status: 'pending', building_names: ['Other'] }),
      ],
    );
    // 2 seats reference it, 1 pending request references it.
    expect(msg).toContain('2 seats');
    expect(msg).toContain('1 pending request');
    expect(msg).toBe(
      'Can\'t rename "Black Forest" — 2 seats and 1 pending request reference it. ' +
        'Remove or reassign them first.',
    );
  });

  it('uses the plural verb for a compound subject of two singular parts', () => {
    // 1 seat + 1 pending request = 2 references total → "reference",
    // even though each individual part is singular.
    const msg = buildingRenameBlocker(
      'Black Forest',
      [seat({ building_names: ['Black Forest'] })],
      [request({ status: 'pending', building_names: ['Black Forest'] })],
    );
    expect(msg).toBe(
      'Can\'t rename "Black Forest" — 1 seat and 1 pending request reference it. ' +
        'Remove or reassign them first.',
    );
  });

  it('tolerates a seat / request with an absent building_names array', () => {
    expect(
      buildingRenameBlocker(
        'Black Forest',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [{ ...seat(), building_names: undefined } as any],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [{ ...request(), building_names: undefined } as any],
      ),
    ).toBeNull();
  });

  it('blocks when the only reference is a duplicate-grant building set (primary elsewhere)', () => {
    // Member's primary seat is in another building; the renamed building
    // is referenced ONLY by a duplicate-site grant (T-43). Renaming it
    // would stale that snapshot → must block.
    const msg = buildingRenameBlocker(
      'Black Forest',
      [
        seat({
          building_names: ['Maple Building'],
          duplicate_grants: [
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { scope: 'PR', type: 'manual', building_names: ['Black Forest'] } as any,
          ],
        }),
      ],
      [],
    );
    expect(msg).toContain('Can\'t rename "Black Forest"');
    expect(msg).toContain('1 seat references it');
  });

  it('counts a seat once when it references via both primary and duplicate-grant arrays', () => {
    const msg = buildingRenameBlocker(
      'Black Forest',
      [
        seat({
          building_names: ['Black Forest'],
          duplicate_grants: [
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { scope: 'PR', type: 'manual', building_names: ['Black Forest'] } as any,
          ],
        }),
      ],
      [],
    );
    // One seat, not two. Singular subject → singular verb "references".
    expect(msg).toBe(
      'Can\'t rename "Black Forest" — 1 seat references it. Remove or reassign them first.',
    );
  });

  it('tolerates a seat whose duplicate_grants entry has no building_names', () => {
    expect(
      buildingRenameBlocker(
        'Black Forest',
        [
          seat({
            building_names: ['Maple Building'],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            duplicate_grants: [{ scope: 'PR', type: 'manual' } as any],
          }),
        ],
        [],
      ),
    ).toBeNull();
  });
});

describe('configuration kindooSiteDeleteBlocker', () => {
  it('returns null when no building references the site', () => {
    expect(kindooSiteDeleteBlocker('east-stake', [])).toBeNull();
  });

  it('returns a message listing referencing buildings', () => {
    const msg = kindooSiteDeleteBlocker('east-stake', [
      building({ building_id: 'pine', building_name: 'Pine Stake Center' }),
      building({ building_id: 'maple', building_name: 'Maple Building' }),
    ]);
    expect(msg).toContain('Cannot delete Kindoo site "east-stake"');
    expect(msg).toContain('Pine Stake Center');
    expect(msg).toContain('Maple Building');
    expect(msg).toContain('Unassign these buildings from this site before deleting.');
  });
});

describe('configuration duplicateOrganizationNameBlocker', () => {
  const orgs = [
    organization({ organization_id: 'primary-children', name: 'Primary Children' }),
    organization({ organization_id: 'scouts', name: 'Scouts' }),
  ];

  it('returns null when the name is free', () => {
    expect(duplicateOrganizationNameBlocker('Youth Council', orgs, undefined)).toBeNull();
  });

  it('blocks when another organization (different slug) uses the name', () => {
    const msg = duplicateOrganizationNameBlocker('Scouts', orgs, 'primary-children');
    expect(msg).toContain('Organization names must be unique');
  });

  it('ignores the organization being edited (same slug)', () => {
    expect(
      duplicateOrganizationNameBlocker('Primary Children', orgs, 'primary-children'),
    ).toBeNull();
  });

  it('matches case-insensitively and trims', () => {
    expect(duplicateOrganizationNameBlocker('  scouts ', orgs, undefined)).not.toBeNull();
  });
});

describe('configuration organizationDeleteBlocker', () => {
  it('returns null when no seat references the org', () => {
    expect(
      organizationDeleteBlocker('primary-children', [
        seat({ organization_id: 'scouts' }),
        seat({ organization_id: null }),
      ]),
    ).toBeNull();
  });

  it('blocks when a seat references the org via its primary organization_id', () => {
    const msg = organizationDeleteBlocker('primary-children', [
      seat({ organization_id: 'primary-children' }),
    ]);
    expect(msg).toContain('Cannot delete');
    expect(msg).toContain('1 seat');
    expect(msg).toContain('Reassign or remove them first.');
  });

  it('blocks when a seat references the org ONLY via a duplicate-grant organization_id', () => {
    const dup: DuplicateGrant = {
      scope: 'stake',
      type: 'manual',
      organization_id: 'primary-children',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const msg = organizationDeleteBlocker('primary-children', [
      seat({ organization_id: 'scouts', duplicate_grants: [dup] }),
    ]);
    expect(msg).toContain('1 seat');
  });

  it('counts and pluralizes multiple referencing seats', () => {
    const msg = organizationDeleteBlocker('primary-children', [
      seat({ member_canonical: 's1@x.com', organization_id: 'primary-children' }),
      seat({ member_canonical: 's2@x.com', organization_id: 'primary-children' }),
      seat({ member_canonical: 's3@x.com', organization_id: 'scouts' }),
    ]);
    expect(msg).toContain('2 seats');
  });

  it('counts a seat once when it references via both primary and duplicate-grant', () => {
    const dup: DuplicateGrant = {
      scope: 'stake',
      type: 'manual',
      organization_id: 'primary-children',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const msg = organizationDeleteBlocker('primary-children', [
      seat({ organization_id: 'primary-children', duplicate_grants: [dup] }),
    ]);
    // One seat, not two.
    expect(msg).toContain('1 seat');
  });

  it('tolerates a seat with absent organization_id and duplicate_grants', () => {
    expect(
      organizationDeleteBlocker('primary-children', [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ...seat(), organization_id: undefined, duplicate_grants: undefined } as any,
      ]),
    ).toBeNull();
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
    wardRef: (_db: unknown, _stakeId: string, wardCode: string) => ({
      __sentinel: 'wardRef',
      path: `stakes/csnorth/wards/${wardCode}`,
      id: wardCode,
    }),
    buildingRef: (_db: unknown, _stakeId: string, buildingId: string) => ({
      __sentinel: 'buildingRef',
      path: `stakes/csnorth/buildings/${buildingId}`,
      id: buildingId,
    }),
    organizationRef: (_db: unknown, _stakeId: string, organizationId: string) => ({
      __sentinel: 'organizationRef',
      path: `stakes/csnorth/organizations/${organizationId}`,
      id: organizationId,
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

vi.mock('../../../lib/useActiveStake', () => ({
  useActiveStake: () => 'csnorth',
}));

import {
  useDeleteBuildingMutation,
  useDeleteKindooSiteMutation,
  useDeleteOrganizationMutation,
  useUpsertBuildingMutation,
  useUpsertKindooSiteMutation,
  useUpsertOrganizationMutation,
  useUpsertWardMutation,
} from './hooks';

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
      display_name: 'East Stake Pine',
      kindoo_expected_site_name: 'East Stake Pine CS',
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [ref, body, options] = setDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({
      path: 'stakes/csnorth/kindooSites/east-stake-pine',
      id: 'east-stake-pine',
    });
    expect(body).toMatchObject({
      id: 'east-stake-pine',
      display_name: 'East Stake Pine',
      kindoo_expected_site_name: 'East Stake Pine CS',
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
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertKindooSiteMutation(), { wrapper });
    await result.current.mutateAsync({
      id: 'east-stake-pine',
      display_name: 'Other Name',
      kindoo_expected_site_name: 'Other Name CS',
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [ref, body] = setDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({
      path: 'stakes/csnorth/kindooSites/east-stake-pine',
      id: 'east-stake-pine',
    });
    expect(body).toMatchObject({
      id: 'east-stake-pine',
      display_name: 'Other Name',
    });
  });

  it('refuses to silently overwrite when the derived slug collides on create', async () => {
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertKindooSiteMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        display_name: 'East Stake Pine',
        kindoo_expected_site_name: 'East Stake Pine CS',
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
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertKindooSiteMutation(), { wrapper });
    await result.current.mutateAsync({
      id: 'east-stake-pine',
      display_name: 'East Stake Pine (renamed)',
      kindoo_expected_site_name: 'East Stake Pine CS',
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
      display_name: 'East Stake Pine',
      kindoo_expected_site_name: 'East Stake Pine CS',
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
      display_name: 'East Stake Pine',
      kindoo_expected_site_name: 'East Stake Pine CS',
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    expect(runTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('wraps the edit-path existence check + set in a single runTransaction', async () => {
    // Guards against the read-then-write race where another tab
    // deleted the site between the snapshot delivery and submit.
    // Without the transaction, `setDoc(..., { merge: true })` would
    // resurrect a tombstoned doc with a fresh `created_at`.
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertKindooSiteMutation(), { wrapper });
    await result.current.mutateAsync({
      id: 'east-stake-pine',
      display_name: 'East Stake Pine (renamed)',
      kindoo_expected_site_name: 'East Stake Pine CS',
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    expect(runTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to resurrect a tombstoned site on edit when the doc is missing', async () => {
    // Race: another tab/session deleted the site between the operator
    // opening the dialog and submitting. With a plain merge-write,
    // setDoc would re-create the doc with fresh created_at + lastActor.
    // The existence pre-check in the transaction blocks the resurrection.
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useUpsertKindooSiteMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        id: 'east-stake-pine',
        display_name: 'East Stake Pine (renamed)',
        kindoo_expected_site_name: 'East Stake Pine CS',
      }),
    ).rejects.toThrow(/Kindoo site no longer exists/i);
    expect(setDocMock).not.toHaveBeenCalled();
  });
});

describe('useDeleteKindooSiteMutation', () => {
  const refBuilding = (overrides: Partial<Building> = {}): Building =>
    ({
      building_id: 'pine',
      building_name: 'Pine Stake Center',
      kindoo_site_id: 'east-stake',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(overrides as any),
    }) as Building;

  it('deletes the site doc when no building still references it', async () => {
    const { result } = renderHook(() => useDeleteKindooSiteMutation(), { wrapper });
    await result.current.mutateAsync({
      kindooSiteId: 'east-stake',
      buildings: [refBuilding({ kindoo_site_id: null })],
    });
    await waitFor(() => expect(deleteDocMock).toHaveBeenCalled());
    const [ref] = deleteDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({ path: 'stakes/csnorth/kindooSites/east-stake' });
  });

  it('refuses to delete when a building still references the site', async () => {
    const { result } = renderHook(() => useDeleteKindooSiteMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        kindooSiteId: 'east-stake',
        buildings: [refBuilding()],
      }),
    ).rejects.toThrow(/Pine Stake Center/);
    expect(deleteDocMock).not.toHaveBeenCalled();
  });

  it('ignores buildings pointing at a different site', async () => {
    const { result } = renderHook(() => useDeleteKindooSiteMutation(), { wrapper });
    await result.current.mutateAsync({
      kindooSiteId: 'east-stake',
      buildings: [refBuilding({ kindoo_site_id: 'west-stake' })],
    });
    await waitFor(() => expect(deleteDocMock).toHaveBeenCalled());
  });
});

// ---- created_at preservation on edits ------------------------------
//
// `merge: true` overwrites every field present in the body — so a
// stamp of `created_at: serverTimestamp()` on edit silently loses the
// original creation timestamp. Each upsert mutation must stamp
// `created_at` ONLY on the create path. Tests assert the payload
// shape directly.

describe('useUpsertKindooSiteMutation created_at semantics', () => {
  it('stamps created_at on create', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useUpsertKindooSiteMutation(), { wrapper });
    await result.current.mutateAsync({
      display_name: 'East Stake Pine',
      kindoo_expected_site_name: 'East Stake Pine CS',
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [, body] = setDocMock.mock.calls[0]!;
    expect(body).toHaveProperty('created_at', '__server_timestamp__');
  });

  it('omits created_at on edit (preserves original timestamp)', async () => {
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertKindooSiteMutation(), { wrapper });
    await result.current.mutateAsync({
      id: 'east-stake-pine',
      display_name: 'East Stake Pine (renamed)',
      kindoo_expected_site_name: 'East Stake Pine CS',
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [, body] = setDocMock.mock.calls[0]!;
    expect(body).not.toHaveProperty('created_at');
    expect(body).toHaveProperty('last_modified_at', '__server_timestamp__');
  });
});

describe('useUpsertWardMutation', () => {
  it('derives the ward_code from the name via buildingSlug on create', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useUpsertWardMutation(), { wrapper });
    // No ward_code passed — the create path slugs the name.
    await result.current.mutateAsync({
      ward_name: '3rd Ward',
      building_id: 'main',
      building_name: 'Main',
      seat_cap: 20,
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [ref, body, options] = setDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({ path: 'stakes/csnorth/wards/3rd-ward' });
    expect(body).toMatchObject({
      ward_code: '3rd-ward',
      ward_name: '3rd Ward',
      // Both the immutable slug FK and the legacy name snapshot.
      building_id: 'main',
      building_name: 'Main',
      seat_cap: 20,
      created_at: '__server_timestamp__',
      lastActor: { email: 'mgr@example.com', canonical: 'mgr@example.com' },
    });
    // A ward's site now derives from its building — never written here.
    expect(body).not.toHaveProperty('kindoo_site_id');
    expect(options).toEqual({ merge: true });
  });

  it('rejects a create whose name slugs to an existing ward', async () => {
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertWardMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        ward_name: 'Maple Ward',
        building_id: 'main',
        building_name: 'Main',
        seat_cap: 20,
      }),
    ).rejects.toThrow(/already exists/i);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('rejects a create whose name matches a legacy 2-letter-coded ward (slug differs)', async () => {
    // No doc exists at the derived slug `maple`, but a legacy ward named
    // "Maple" lives at doc id `CO` — the name guard must still block it.
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useUpsertWardMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        ward_name: 'Maple',
        building_id: 'main',
        building_name: 'Main',
        seat_cap: 20,
        existingWards: [ward({ ward_code: 'CO', ward_name: 'Maple' })],
      }),
    ).rejects.toThrow(/Ward names must be unique/i);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('rejects a rename onto another existing ward name (edit path)', async () => {
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertWardMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        ward_code: 'PR',
        ward_name: 'Maple',
        building_id: 'main',
        building_name: 'Main',
        seat_cap: 20,
        existingWards: [
          ward({ ward_code: 'CO', ward_name: 'Maple' }),
          ward({ ward_code: 'PR', ward_name: 'Prairie' }),
        ],
      }),
    ).rejects.toThrow(/Ward names must be unique/i);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('leaves the existing code untouched on edit (no re-slug from the renamed name)', async () => {
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertWardMutation(), { wrapper });
    // Edit passes the existing immutable doc id; the renamed name must
    // NOT re-derive the code (which would orphan every reference).
    await result.current.mutateAsync({
      ward_code: 'CO',
      ward_name: 'Maple Renamed',
      building_id: 'main',
      building_name: 'Main',
      seat_cap: 22,
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [ref, body] = setDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({ path: 'stakes/csnorth/wards/CO' });
    expect(body).not.toHaveProperty('created_at');
    expect(body).toMatchObject({
      ward_code: 'CO',
      ward_name: 'Maple Renamed',
      last_modified_at: '__server_timestamp__',
    });
  });

  it('wraps the read + write in a runTransaction (race-safe)', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useUpsertWardMutation(), { wrapper });
    await result.current.mutateAsync({
      ward_name: 'Maple',
      building_id: 'main',
      building_name: 'Main',
      seat_cap: 20,
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    expect(runTransactionMock).toHaveBeenCalledTimes(1);
  });
});

describe('useUpsertBuildingMutation', () => {
  it('stamps created_at on create', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useUpsertBuildingMutation(), { wrapper });
    await result.current.mutateAsync({
      building_name: 'Maple Building',
      address: '123 Main',
      kindoo_site_id: null,
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [ref, body, options] = setDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({ path: 'stakes/csnorth/buildings/maple-building' });
    expect(body).toMatchObject({
      building_id: 'maple-building',
      building_name: 'Maple Building',
      address: '123 Main',
      kindoo_site_id: null,
      created_at: '__server_timestamp__',
      lastActor: { email: 'mgr@example.com', canonical: 'mgr@example.com' },
    });
    expect(options).toEqual({ merge: true });
  });

  it('omits created_at on edit (preserves original timestamp)', async () => {
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertBuildingMutation(), { wrapper });
    await result.current.mutateAsync({
      building_id: 'maple-building',
      building_name: 'Maple Building',
      address: '456 Other',
      kindoo_site_id: 'east-stake',
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [, body] = setDocMock.mock.calls[0]!;
    expect(body).not.toHaveProperty('created_at');
    expect(body).toMatchObject({
      building_name: 'Maple Building',
      address: '456 Other',
      last_modified_at: '__server_timestamp__',
    });
  });

  it('keeps the original slug on edit even when the display name changes', async () => {
    // The core defect this PR fixes: editing the display name must NOT
    // re-slug, or the write lands on a new doc and orphans the old one
    // plus every ward / seat reference keyed on the original slug.
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertBuildingMutation(), { wrapper });
    await result.current.mutateAsync({
      building_id: 'maple-building',
      building_name: 'Oak Building', // renamed
      address: '123 Main',
      kindoo_site_id: null,
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [ref, body] = setDocMock.mock.calls[0]!;
    // Same doc — slug is frozen at 'maple-building', not re-derived from
    // the new name ('oak-building').
    expect(ref).toMatchObject({ path: 'stakes/csnorth/buildings/maple-building' });
    expect(body).toMatchObject({ building_id: 'maple-building', building_name: 'Oak Building' });
  });

  it('blocks the save when another building already uses the chosen name', async () => {
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertBuildingMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        building_id: 'maple-building',
        building_name: 'Pine Building', // collides with another building
        address: '123 Main',
        kindoo_site_id: null,
        existingBuildings: [
          building({ building_id: 'pine-building', building_name: 'Pine Building' }),
        ],
      }),
    ).rejects.toThrow(/Building names must be unique/i);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('allows the save when the only name match is the building itself', async () => {
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertBuildingMutation(), { wrapper });
    await result.current.mutateAsync({
      building_id: 'maple-building',
      building_name: 'Maple Building', // unchanged name, same building
      address: '999 New',
      kindoo_site_id: null,
      existingBuildings: [
        building({ building_id: 'maple-building', building_name: 'Maple Building' }),
      ],
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
  });

  it('wraps the read + write in a runTransaction (race-safe)', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useUpsertBuildingMutation(), { wrapper });
    await result.current.mutateAsync({
      building_name: 'Maple Building',
      address: '123 Main',
      kindoo_site_id: null,
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    expect(runTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when the slug derived from building_name is empty', async () => {
    const { result } = renderHook(() => useUpsertBuildingMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        building_name: '   ',
        address: '123 Main',
        kindoo_site_id: null,
      }),
    ).rejects.toThrow(/Building name is required/i);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  // ---- Rename ref-guard (T-68 prevent-rename) -----------------------

  it('blocks a rename while an active seat references the old name', async () => {
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertBuildingMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        building_id: 'maple-building',
        building_name: 'Oak Building', // rename
        address: '123 Main',
        kindoo_site_id: null,
        previousBuildingName: 'Maple Building',
        seats: [seat({ building_names: ['Maple Building'] })],
        pendingRequests: [],
      }),
    ).rejects.toThrow(/Can't rename "Maple Building"/i);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('blocks a rename while a pending request references the old name', async () => {
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertBuildingMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        building_id: 'maple-building',
        building_name: 'Oak Building', // rename
        address: '123 Main',
        kindoo_site_id: null,
        previousBuildingName: 'Maple Building',
        seats: [],
        pendingRequests: [request({ status: 'pending', building_names: ['Maple Building'] })],
      }),
    ).rejects.toThrow(/1 pending request/i);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('allows an address-only edit even while seats reference the name (name unchanged)', async () => {
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertBuildingMutation(), { wrapper });
    await result.current.mutateAsync({
      building_id: 'maple-building',
      building_name: 'Maple Building', // unchanged
      address: '999 New Address',
      kindoo_site_id: null,
      previousBuildingName: 'Maple Building',
      seats: [seat({ building_names: ['Maple Building'] })],
      pendingRequests: [request({ status: 'pending', building_names: ['Maple Building'] })],
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [, body] = setDocMock.mock.calls[0]!;
    expect(body).toMatchObject({ building_name: 'Maple Building', address: '999 New Address' });
  });

  it('allows a rename when no active seat / pending request references the old name', async () => {
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertBuildingMutation(), { wrapper });
    await result.current.mutateAsync({
      building_id: 'maple-building',
      building_name: 'Oak Building', // rename
      address: '123 Main',
      kindoo_site_id: null,
      previousBuildingName: 'Maple Building',
      // Only a COMPLETED request references the old name — historical,
      // does not block.
      seats: [seat({ building_names: ['Pine Building'] })],
      pendingRequests: [request({ status: 'complete', building_names: ['Maple Building'] })],
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [, body] = setDocMock.mock.calls[0]!;
    expect(body).toMatchObject({ building_id: 'maple-building', building_name: 'Oak Building' });
  });
});

describe('useDeleteBuildingMutation — transitional OR ref-guard', () => {
  it('blocks the delete when a ward references the building by building_id', async () => {
    const { result } = renderHook(() => useDeleteBuildingMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        buildingId: 'maple-building',
        buildingName: 'Maple Building',
        // The ward's legacy name snapshot is stale (building was renamed),
        // but its slug FK still matches → delete must block.
        wards: [ward({ ward_code: 'CO', ward_name: 'Maple', building_id: 'maple-building' })],
      }),
    ).rejects.toThrow(/Cannot delete/i);
    expect(deleteDocMock).not.toHaveBeenCalled();
  });

  it('blocks the delete when a legacy ward references the building by name only', async () => {
    const { result } = renderHook(() => useDeleteBuildingMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        buildingId: 'maple-building',
        buildingName: 'Maple Building',
        wards: [ward({ ward_code: 'CO', ward_name: 'Maple', building_name: 'Maple Building' })],
      }),
    ).rejects.toThrow(/Cannot delete/i);
    expect(deleteDocMock).not.toHaveBeenCalled();
  });

  it('allows the delete when no ward references the building by id or name', async () => {
    const { result } = renderHook(() => useDeleteBuildingMutation(), { wrapper });
    await result.current.mutateAsync({
      buildingId: 'maple-building',
      buildingName: 'Maple Building',
      wards: [ward({ ward_code: 'CO', ward_name: 'Maple', building_id: 'pine-building' })],
    });
    await waitFor(() => expect(deleteDocMock).toHaveBeenCalled());
    const [ref] = deleteDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({ path: 'stakes/csnorth/buildings/maple-building' });
  });
});

describe('useUpsertOrganizationMutation', () => {
  it('derives the doc id from name via buildingSlug on create + stamps created_at', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useUpsertOrganizationMutation(), { wrapper });
    await result.current.mutateAsync({ name: 'Primary Children', seat_cap: 25 });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [ref, body, options] = setDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({
      path: 'stakes/csnorth/organizations/primary-children',
      id: 'primary-children',
    });
    expect(body).toMatchObject({
      organization_id: 'primary-children',
      name: 'Primary Children',
      seat_cap: 25,
      created_at: '__server_timestamp__',
      lastActor: { email: 'mgr@example.com', canonical: 'mgr@example.com' },
    });
    expect(options).toEqual({ merge: true });
  });

  it('keeps the original slug on edit even when the display name changes (no re-slug)', async () => {
    // The slug is the immutable doc id every seat / request references
    // via organization_id; re-slugging a renamed org would orphan them.
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertOrganizationMutation(), { wrapper });
    await result.current.mutateAsync({
      organization_id: 'primary-children',
      name: 'Primary Org Renamed',
      seat_cap: 30,
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [ref, body] = setDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({
      path: 'stakes/csnorth/organizations/primary-children',
      id: 'primary-children',
    });
    expect(body).toMatchObject({
      organization_id: 'primary-children',
      name: 'Primary Org Renamed',
    });
  });

  it('omits created_at on edit (preserves original timestamp)', async () => {
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertOrganizationMutation(), { wrapper });
    await result.current.mutateAsync({
      organization_id: 'primary-children',
      name: 'Primary Children',
      seat_cap: 30,
    });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    const [, body] = setDocMock.mock.calls[0]!;
    expect(body).not.toHaveProperty('created_at');
    expect(body).toHaveProperty('last_modified_at', '__server_timestamp__');
  });

  it('blocks the save when another organization already uses the chosen name', async () => {
    getDocMock.mockResolvedValue({ exists: () => true });
    const { result } = renderHook(() => useUpsertOrganizationMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        organization_id: 'primary-children',
        name: 'Scouts', // collides with another org
        seat_cap: 10,
        existingOrganizations: [organization({ organization_id: 'scouts', name: 'Scouts' })],
      }),
    ).rejects.toThrow(/Organization names must be unique/i);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('rejects when the slug derived from name is empty', async () => {
    const { result } = renderHook(() => useUpsertOrganizationMutation(), { wrapper });
    await expect(result.current.mutateAsync({ name: '   ', seat_cap: 5 })).rejects.toThrow(
      /Organization name is required/i,
    );
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it('wraps the read + write in a runTransaction (race-safe)', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const { result } = renderHook(() => useUpsertOrganizationMutation(), { wrapper });
    await result.current.mutateAsync({ name: 'Primary Children', seat_cap: 25 });
    await waitFor(() => expect(setDocMock).toHaveBeenCalled());
    expect(runTransactionMock).toHaveBeenCalledTimes(1);
  });
});

describe('useDeleteOrganizationMutation', () => {
  it('deletes the org doc when no seat references it', async () => {
    const { result } = renderHook(() => useDeleteOrganizationMutation(), { wrapper });
    await result.current.mutateAsync({
      organizationId: 'primary-children',
      seats: [seat({ organization_id: 'scouts' })],
    });
    await waitFor(() => expect(deleteDocMock).toHaveBeenCalled());
    const [ref] = deleteDocMock.mock.calls[0]!;
    expect(ref).toMatchObject({ path: 'stakes/csnorth/organizations/primary-children' });
  });

  it('refuses to delete when a seat references the org', async () => {
    const { result } = renderHook(() => useDeleteOrganizationMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        organizationId: 'primary-children',
        seats: [seat({ organization_id: 'primary-children' })],
      }),
    ).rejects.toThrow(/Cannot delete/i);
    expect(deleteDocMock).not.toHaveBeenCalled();
  });

  it('refuses to delete when a seat references the org via a duplicate grant', async () => {
    const dup: DuplicateGrant = {
      scope: 'stake',
      type: 'manual',
      organization_id: 'primary-children',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const { result } = renderHook(() => useDeleteOrganizationMutation(), { wrapper });
    await expect(
      result.current.mutateAsync({
        organizationId: 'primary-children',
        seats: [seat({ organization_id: 'scouts', duplicate_grants: [dup] })],
      }),
    ).rejects.toThrow(/Cannot delete/i);
    expect(deleteDocMock).not.toHaveBeenCalled();
  });
});
