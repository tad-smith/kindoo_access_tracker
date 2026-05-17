// Unit tests for the SW-side Firestore writers.
//
// Firebase Firestore module surface is mocked at the module edge so
// these tests don't need a running Firestore instance. We capture the
// batch.update payloads to assert the wire-shape of each write — the
// only thing the writer code actually does on top of the SDK.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from 'firebase/auth/web-extension';

const updateMock = vi.fn();
const commitMock = vi.fn();
const writeBatchMock = vi.fn(() => ({ update: updateMock, commit: commitMock }));

const getDocMock = vi.fn();
const getDocsMock = vi.fn();
const updateDocMock = vi.fn();
const docMock = vi.fn((..._args: unknown[]) => ({ __doc: _args }));
const collectionMock = vi.fn((..._args: unknown[]) => ({ __coll: _args }));
const serverTimestampMock = vi.fn(() => '__ts__');

vi.mock('firebase/firestore', () => ({
  collection: (...args: unknown[]) => collectionMock(...args),
  doc: (...args: unknown[]) => docMock(...args),
  getDoc: (...args: unknown[]) => getDocMock(...args),
  getDocs: (...args: unknown[]) => getDocsMock(...args),
  serverTimestamp: () => serverTimestampMock(),
  updateDoc: (...args: unknown[]) => updateDocMock(...args),
  writeBatch: () => writeBatchMock(),
}));

vi.mock('../lib/firebase', () => ({
  firestore: () => ({ __firestore: true }),
}));

vi.mock('../lib/constants', () => ({
  STAKE_ID: 'test-stake',
}));

function actor(email = 'mgr@example.com'): User {
  return { email } as unknown as User;
}

describe('writeKindooConfig — home save site_name clobber guard', () => {
  beforeEach(() => {
    updateMock.mockReset();
    commitMock.mockReset();
    commitMock.mockResolvedValue(undefined);
    writeBatchMock.mockClear();
    getDocMock.mockReset();
    getDocsMock.mockReset();
    // Default: no foreign kindooSites — collision guard reads empty.
    getDocsMock.mockResolvedValue({ docs: [] });
    docMock.mockClear();
    collectionMock.mockClear();
    serverTimestampMock.mockClear();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('preserves existing kindoo_config.site_name when payload.siteName is empty', async () => {
    // Bug scenario: home re-configure runs but the active env was
    // missing from getEnvironments() (Kindoo transient/paginated edge),
    // so the panel sent siteName: ''. The writer must NOT clobber the
    // stake doc's recorded site_name with '' — it must read the
    // existing doc and reuse the value.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        kindoo_config: {
          site_id: 27994,
          site_name: 'Cordera Stake',
          configured_at: '__ts__',
          configured_by: { email: 'prev@example.com', canonical: 'prev@example.com' },
        },
      }),
    });
    const { writeKindooConfig } = await import('./data');
    await writeKindooConfig(
      {
        kindooSiteId: null,
        siteId: 27994,
        siteName: '',
        buildingRules: [],
      },
      actor(),
    );
    expect(getDocMock).toHaveBeenCalledTimes(1);
    // First batch.update call is the stake doc. Dotted-path keys
    // preserve unrelated kindoo_config.* subfields on partial-merge.
    const stakePayload = updateMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(stakePayload['kindoo_config.site_id']).toBe(27994);
    expect(stakePayload['kindoo_config.site_name']).toBe('Cordera Stake');
  });

  it('falls back to empty string when payload.siteName is empty AND stake doc is missing', async () => {
    // Defensive edge: stake doc somehow doesn't exist. Don't crash;
    // we still write something (caller can fix via re-configure).
    getDocMock.mockResolvedValue({ exists: () => false, data: () => ({}) });
    const { writeKindooConfig } = await import('./data');
    await writeKindooConfig(
      {
        kindooSiteId: null,
        siteId: 27994,
        siteName: '',
        buildingRules: [],
      },
      actor(),
    );
    const stakePayload = updateMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(stakePayload['kindoo_config.site_name']).toBe('');
  });

  it('writes the supplied siteName when non-empty (no defensive stake read needed)', async () => {
    // Happy path: env was present, panel passed a real name. The
    // home-collision guard always reads kindooSites to check for
    // FOREIGN_EID collision, but the defensive site_name read off the
    // stake doc is skipped because payload.siteName is already
    // non-empty.
    const { writeKindooConfig } = await import('./data');
    await writeKindooConfig(
      {
        kindooSiteId: null,
        siteId: 27994,
        siteName: 'Cordera Stake',
        buildingRules: [],
      },
      actor(),
    );
    expect(getDocMock).not.toHaveBeenCalled();
    expect(getDocsMock).toHaveBeenCalledTimes(1);
    const stakePayload = updateMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(stakePayload['kindoo_config.site_name']).toBe('Cordera Stake');
  });

  it('rejects when actor has no email', async () => {
    const { writeKindooConfig } = await import('./data');
    await expect(
      writeKindooConfig(
        {
          kindooSiteId: null,
          siteId: 27994,
          siteName: 'Cordera Stake',
          buildingRules: [],
        },
        { email: null } as unknown as User,
      ),
    ).rejects.toThrow(/no email/);
  });

  it('refuses a home save that would trap foreign kindoo_eid as the home kindoo_config.site_id', async () => {
    // Symmetric to the foreign-save collision guard. Scenario: a buggy
    // resolver classifies a foreign session as `home` (ambiguous-name
    // fallthrough) and the wizard calls writeKindooConfig with
    // payload.siteId = FOREIGN_EID. Without this guard, home's
    // site_id would be silently overwritten with FOREIGN_EID and every
    // home-scope provision check would refuse.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        kindoo_config: { site_id: 27994, site_name: 'Cordera Stake' },
      }),
    });
    getDocsMock.mockResolvedValue({
      docs: [
        {
          data: () => ({
            id: 'east-stake',
            display_name: 'East Stake (Foothills Building)',
            kindoo_expected_site_name: 'East Stake',
            kindoo_eid: 4321,
          }),
        },
      ],
    });
    const { writeKindooConfig } = await import('./data');
    await expect(
      writeKindooConfig(
        {
          kindooSiteId: null,
          siteId: 4321, // collides with foreign kindoo_eid
          siteName: 'East Stake',
          buildingRules: [],
        },
        actor(),
      ),
    ).rejects.toThrow(/FOREIGN_EID|foreign/i);
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('uses dotted-path updates on kindoo_config.* so unrelated subfields survive', async () => {
    // Bug the reviewer flagged: a top-level `kindoo_config: {…}` write
    // is a REPLACE not a merge. Any field under kindoo_config that the
    // literal doesn't enumerate gets dropped on every re-configure.
    // Dotted-path writes must scope to only the named subfields.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        kindoo_config: { site_id: 27994, site_name: 'Cordera Stake' },
      }),
    });
    getDocsMock.mockResolvedValue({ docs: [] });
    const { writeKindooConfig } = await import('./data');
    await writeKindooConfig(
      {
        kindooSiteId: null,
        siteId: 27994,
        siteName: 'Cordera Stake',
        buildingRules: [],
      },
      actor(),
    );
    const stakePayload = updateMock.mock.calls[0]?.[1] as Record<string, unknown>;
    // Must use dotted-path keys, NOT a nested kindoo_config object.
    expect(stakePayload['kindoo_config.site_id']).toBe(27994);
    expect(stakePayload['kindoo_config.site_name']).toBe('Cordera Stake');
    expect(stakePayload['kindoo_config.configured_at']).toBe('__ts__');
    expect(stakePayload['kindoo_config.configured_by']).toMatchObject({
      email: 'mgr@example.com',
    });
    // The write must NOT include a top-level kindoo_config key — that
    // would clobber the whole map.
    expect(stakePayload['kindoo_config']).toBeUndefined();
  });

  it('refuses a foreign save that would trap home kindoo_config.site_id on the foreign doc', async () => {
    // Footgun the reviewer flagged: a foreign-save with payload.siteId
    // equal to the home `kindoo_config.site_id` would persist HOME_EID
    // onto the foreign doc and let every subsequent foreign-ward
    // provision on a home session silently target home. Refuse before
    // committing the batch.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        kindoo_config: { site_id: 27994, site_name: 'Cordera Stake' },
      }),
    });
    const { writeKindooConfig } = await import('./data');
    await expect(
      writeKindooConfig(
        {
          kindooSiteId: 'east-stake',
          siteId: 27994, // collides with home's site_id
          siteName: 'East Stake',
          buildingRules: [],
        },
        actor(),
      ),
    ).rejects.toThrow(/HOME_EID|home/i);
    // Batch must not commit on refusal.
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('allows a foreign save when payload.siteId does not collide with home', async () => {
    // Happy path: the home-collision guard must not block legitimate
    // foreign saves where the EIDs are distinct.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        kindoo_config: { site_id: 27994, site_name: 'Cordera Stake' },
      }),
    });
    const { writeKindooConfig } = await import('./data');
    await writeKindooConfig(
      {
        kindooSiteId: 'east-stake',
        siteId: 4321,
        siteName: 'East Stake',
        buildingRules: [],
      },
      actor(),
    );
    expect(commitMock).toHaveBeenCalledTimes(1);
  });
});

describe('writeKindooSiteEid — home-collision guard', () => {
  beforeEach(() => {
    updateMock.mockReset();
    commitMock.mockReset();
    commitMock.mockResolvedValue(undefined);
    writeBatchMock.mockClear();
    getDocMock.mockReset();
    updateDocMock.mockReset();
    updateDocMock.mockResolvedValue(undefined);
    docMock.mockClear();
    serverTimestampMock.mockClear();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('refuses when the supplied EID equals the home kindoo_config.site_id', async () => {
    // Reviewer-flagged footgun: a buggy caller passes HOME_EID for a
    // foreign-site populate. Refuse before persisting — otherwise the
    // foreign doc would carry HOME_EID forever and Phase 3's
    // EID-match check would silently approve foreign-ward provisions
    // on home sessions.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        kindoo_config: { site_id: 27994, site_name: 'Cordera Stake' },
      }),
    });
    const { writeKindooSiteEid } = await import('./data');
    await expect(writeKindooSiteEid('east-stake', 27994, actor())).rejects.toThrow(
      /HOME_EID|home/i,
    );
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('writes when the supplied EID is distinct from the home site_id', async () => {
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        kindoo_config: { site_id: 27994, site_name: 'Cordera Stake' },
      }),
    });
    const { writeKindooSiteEid } = await import('./data');
    await writeKindooSiteEid('east-stake', 4321, actor());
    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const payload = updateDocMock.mock.calls[0]?.[1] as { kindoo_eid: number };
    expect(payload.kindoo_eid).toBe(4321);
  });

  it('writes when the stake has no kindoo_config (no home EID to collide with)', async () => {
    // Pre-Phase-5: stake.kindoo_config is unset. There's no home EID to
    // collide with, so the write proceeds. Phase 5 will set
    // kindoo_config before any foreign-site activity in practice, but
    // the guard must not block legitimate setups while it's unset.
    getDocMock.mockResolvedValue({ exists: () => true, data: () => ({}) });
    const { writeKindooSiteEid } = await import('./data');
    await writeKindooSiteEid('east-stake', 4321, actor());
    expect(updateDocMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when actor has no email', async () => {
    const { writeKindooSiteEid } = await import('./data');
    await expect(
      writeKindooSiteEid('east-stake', 4321, { email: null } as unknown as User),
    ).rejects.toThrow(/no email/);
  });

  it('writes when the existing kindoo_eid is null / undefined (legitimate first-populate)', async () => {
    // Happy path for the non-home overwrite guard: the foreign doc has
    // never been populated, so existingEid is null and the write
    // proceeds. Mirrors the orchestrator-entry path that only calls this
    // writer when the foreign doc has no EID recorded yet.
    getDocMock
      // First read: stake doc (home-collision guard).
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          kindoo_config: { site_id: 27994, site_name: 'Cordera Stake' },
        }),
      })
      // Second read: foreign site doc (overwrite guard) — no kindoo_eid yet.
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          id: 'east-stake',
          display_name: 'East Stake (Foothills Building)',
          kindoo_expected_site_name: 'East Stake',
          // kindoo_eid absent.
        }),
      });
    const { writeKindooSiteEid } = await import('./data');
    await writeKindooSiteEid('east-stake', 4321, actor());
    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const payload = updateDocMock.mock.calls[0]?.[1] as { kindoo_eid: number };
    expect(payload.kindoo_eid).toBe(4321);
  });

  it('refuses when the existing kindoo_eid differs from the incoming value (non-home overwrite)', async () => {
    // Defense-in-depth from PR #124 review: a buggy / future caller
    // could silently rewrite an established foreign-site `kindoo_eid`
    // and re-route door-access for the foreign ward. Refuse before
    // updating. The orchestrator-entry path only invokes this writer
    // when the foreign doc's `kindoo_eid` is null / undefined, so
    // legitimate callers stay green.
    getDocMock
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          kindoo_config: { site_id: 27994, site_name: 'Cordera Stake' },
        }),
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          id: 'east-stake',
          display_name: 'East Stake (Foothills Building)',
          kindoo_expected_site_name: 'East Stake',
          kindoo_eid: 1234, // already populated with a different EID
        }),
      });
    const { writeKindooSiteEid } = await import('./data');
    await expect(writeKindooSiteEid('east-stake', 5678, actor())).rejects.toThrow(
      /overwrite existing kindoo_eid/i,
    );
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('allows re-asserting an identical kindoo_eid (idempotent re-write)', async () => {
    // The wizard's foreign save can re-run against a site whose
    // kindoo_eid is already set — the new overwrite guard must not
    // block re-asserting the same value.
    getDocMock
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          kindoo_config: { site_id: 27994, site_name: 'Cordera Stake' },
        }),
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          id: 'east-stake',
          kindoo_eid: 4321,
        }),
      });
    const { writeKindooSiteEid } = await import('./data');
    await writeKindooSiteEid('east-stake', 4321, actor());
    expect(updateDocMock).toHaveBeenCalledTimes(1);
  });
});
