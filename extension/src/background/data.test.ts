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

const STAKE_ID = 'test-stake';

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
          site_name: 'Maple Stake',
          configured_at: '__ts__',
          configured_by: { email: 'prev@example.com', canonical: 'prev@example.com' },
        },
      }),
    });
    const { writeKindooConfig } = await import('./data');
    await writeKindooConfig(
      STAKE_ID,
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
    expect(stakePayload['kindoo_config.site_name']).toBe('Maple Stake');
  });

  it('falls back to empty string when payload.siteName is empty AND stake doc is missing', async () => {
    // Defensive edge: stake doc somehow doesn't exist. Don't crash;
    // we still write something (caller can fix via re-configure).
    getDocMock.mockResolvedValue({ exists: () => false, data: () => ({}) });
    const { writeKindooConfig } = await import('./data');
    await writeKindooConfig(
      STAKE_ID,
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
      STAKE_ID,
      {
        kindooSiteId: null,
        siteId: 27994,
        siteName: 'Maple Stake',
        buildingRules: [],
      },
      actor(),
    );
    expect(getDocMock).not.toHaveBeenCalled();
    expect(getDocsMock).toHaveBeenCalledTimes(1);
    const stakePayload = updateMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(stakePayload['kindoo_config.site_name']).toBe('Maple Stake');
  });

  it('rejects when actor has no email', async () => {
    const { writeKindooConfig } = await import('./data');
    await expect(
      writeKindooConfig(
        STAKE_ID,
        {
          kindooSiteId: null,
          siteId: 27994,
          siteName: 'Maple Stake',
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
        kindoo_config: { site_id: 27994, site_name: 'Maple Stake' },
      }),
    });
    getDocsMock.mockResolvedValue({
      docs: [
        {
          data: () => ({
            id: 'east-stake',
            display_name: 'East Stake (Pine Building)',
            kindoo_expected_site_name: 'East Stake',
            kindoo_eid: 4321,
          }),
        },
      ],
    });
    const { writeKindooConfig } = await import('./data');
    await expect(
      writeKindooConfig(
        STAKE_ID,
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
        kindoo_config: { site_id: 27994, site_name: 'Maple Stake' },
      }),
    });
    getDocsMock.mockResolvedValue({ docs: [] });
    const { writeKindooConfig } = await import('./data');
    await writeKindooConfig(
      STAKE_ID,
      {
        kindooSiteId: null,
        siteId: 27994,
        siteName: 'Maple Stake',
        buildingRules: [],
      },
      actor(),
    );
    const stakePayload = updateMock.mock.calls[0]?.[1] as Record<string, unknown>;
    // Must use dotted-path keys, NOT a nested kindoo_config object.
    expect(stakePayload['kindoo_config.site_id']).toBe(27994);
    expect(stakePayload['kindoo_config.site_name']).toBe('Maple Stake');
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
        kindoo_config: { site_id: 27994, site_name: 'Maple Stake' },
      }),
    });
    const { writeKindooConfig } = await import('./data');
    await expect(
      writeKindooConfig(
        STAKE_ID,
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
    // foreign saves where the EIDs are distinct. The mock returns the
    // same doc shape for the stake read AND the foreign-site read; the
    // foreign-site read sees no `kindoo_eid` in that shape, so the
    // non-home overwrite guard treats it as a first-populate and passes.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        kindoo_config: { site_id: 27994, site_name: 'Maple Stake' },
      }),
    });
    const { writeKindooConfig } = await import('./data');
    await writeKindooConfig(
      STAKE_ID,
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

  it('refuses a foreign save that would overwrite an established kindoo_eid with a different value', async () => {
    // PR #129 review follow-up: the wizard's foreign-save path was the
    // higher-volume entry that wasn't covered by the orchestrator-side
    // overwrite guard. Concrete scenario: foreign doc east-stake carries
    // kindoo_eid: X; a Kindoo-side rename causes resolveActiveKindooSite
    // to match by name and return populateEid: Y even though the doc
    // already has X. Without this guard the wizard would silently
    // overwrite X with Y and re-route door access for the foreign ward.
    getDocMock
      // First read: stake doc (home-collision guard).
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          kindoo_config: { site_id: 27994, site_name: 'Maple Stake' },
        }),
      })
      // Second read: foreign site doc (overwrite guard) — already populated.
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          id: 'east-stake',
          kindoo_eid: 1234,
        }),
      });
    const { writeKindooConfig } = await import('./data');
    await expect(
      writeKindooConfig(
        STAKE_ID,
        {
          kindooSiteId: 'east-stake',
          siteId: 5678, // differs from existing kindoo_eid 1234
          siteName: 'East Stake',
          buildingRules: [],
        },
        actor(),
      ),
    ).rejects.toThrow(/overwrite existing kindoo_eid/i);
    // Batch must not commit on refusal.
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('allows a foreign save that re-asserts the same kindoo_eid (idempotent)', async () => {
    // Wizard re-runs against the same site with the same session EID
    // must still go through. The non-home overwrite guard only blocks
    // value changes, never value re-assertions.
    getDocMock
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          kindoo_config: { site_id: 27994, site_name: 'Maple Stake' },
        }),
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          id: 'east-stake',
          kindoo_eid: 4321,
        }),
      });
    const { writeKindooConfig } = await import('./data');
    await writeKindooConfig(
      STAKE_ID,
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
        kindoo_config: { site_id: 27994, site_name: 'Maple Stake' },
      }),
    });
    const { writeKindooSiteEid } = await import('./data');
    await expect(writeKindooSiteEid(STAKE_ID, 'east-stake', 27994, actor())).rejects.toThrow(
      /HOME_EID|home/i,
    );
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('writes when the supplied EID is distinct from the home site_id', async () => {
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        kindoo_config: { site_id: 27994, site_name: 'Maple Stake' },
      }),
    });
    const { writeKindooSiteEid } = await import('./data');
    await writeKindooSiteEid(STAKE_ID, 'east-stake', 4321, actor());
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
    await writeKindooSiteEid(STAKE_ID, 'east-stake', 4321, actor());
    expect(updateDocMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when actor has no email', async () => {
    const { writeKindooSiteEid } = await import('./data');
    await expect(
      writeKindooSiteEid(STAKE_ID, 'east-stake', 4321, { email: null } as unknown as User),
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
          kindoo_config: { site_id: 27994, site_name: 'Maple Stake' },
        }),
      })
      // Second read: foreign site doc (overwrite guard) — no kindoo_eid yet.
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          id: 'east-stake',
          display_name: 'East Stake (Pine Building)',
          kindoo_expected_site_name: 'East Stake',
          // kindoo_eid absent.
        }),
      });
    const { writeKindooSiteEid } = await import('./data');
    await writeKindooSiteEid(STAKE_ID, 'east-stake', 4321, actor());
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
          kindoo_config: { site_id: 27994, site_name: 'Maple Stake' },
        }),
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          id: 'east-stake',
          display_name: 'East Stake (Pine Building)',
          kindoo_expected_site_name: 'East Stake',
          kindoo_eid: 1234, // already populated with a different EID
        }),
      });
    const { writeKindooSiteEid } = await import('./data');
    await expect(writeKindooSiteEid(STAKE_ID, 'east-stake', 5678, actor())).rejects.toThrow(
      /overwrite existing kindoo_eid/i,
    );
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('allows re-asserting an identical kindoo_eid (idempotent re-write)', async () => {
    // A concurrent populate race could call this writer twice with the
    // same EID — the new overwrite guard must not block re-asserting
    // the same value. (The wizard's foreign save goes through
    // writeKindooConfig, not this writer.)
    getDocMock
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          kindoo_config: { site_id: 27994, site_name: 'Maple Stake' },
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
    await writeKindooSiteEid(STAKE_ID, 'east-stake', 4321, actor());
    expect(updateDocMock).toHaveBeenCalledTimes(1);
  });
});

describe('resolveEidStakes — multi-stake candidate resolution', () => {
  beforeEach(() => {
    getDocMock.mockReset();
    getDocsMock.mockReset();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('returns an empty array when the caller manages no stakes', async () => {
    const { resolveEidStakes } = await import('./data');
    const out = await resolveEidStakes(27994, []);
    expect(out).toEqual({ candidates: [], failedStakes: [] });
    expect(getDocMock).not.toHaveBeenCalled();
  });

  it('returns the single home-match candidate when the EID is the stake home site', async () => {
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        stake_name: 'Colorado Springs North Stake',
        kindoo_config: { site_id: 27994 },
      }),
    });
    getDocsMock.mockResolvedValue({ docs: [] });
    const { resolveEidStakes } = await import('./data');
    const out = await resolveEidStakes(27994, ['csnorth']);
    expect(out).toEqual({
      candidates: [{ stakeId: 'csnorth', label: 'Colorado Springs North Stake', match: 'home' }],
      failedStakes: [],
    });
  });

  it('returns the single foreign-match candidate when the EID matches a kindooSite doc', async () => {
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        stake_name: 'East Colorado Stake',
        kindoo_config: { site_id: 11111 },
      }),
    });
    getDocsMock.mockResolvedValue({
      docs: [
        {
          data: () => ({
            id: 'pine',
            display_name: 'Pine Building',
            kindoo_eid: 27994,
          }),
        },
      ],
    });
    const { resolveEidStakes } = await import('./data');
    const out = await resolveEidStakes(27994, ['east-co']);
    expect(out).toEqual({
      candidates: [
        {
          stakeId: 'east-co',
          label: 'East Colorado Stake',
          match: 'foreign',
          siteLabel: 'Pine Building',
        },
      ],
      failedStakes: [],
    });
  });

  it('returns two candidates when the EID is home for one stake and foreign for another', async () => {
    // Operator-resolved decision #3's example: stake A's foreign-site
    // grant and stake B's home grant target the same Kindoo
    // environment. Both surface in the picker.
    //
    // The doc / collection mocks return tagged refs that carry the
    // original positional args under `__doc` / `__coll` (see top of
    // file). We use that to route each call to the right fixture.
    getDocMock.mockImplementation((ref: unknown) => {
      const args = (ref as { __doc: unknown[] }).__doc;
      const stakeId = args[2] as string;
      if (stakeId === 'csnorth') {
        return Promise.resolve({
          exists: () => true,
          data: () => ({
            stake_name: 'Colorado Springs North Stake',
            kindoo_config: { site_id: 27994 },
          }),
        });
      }
      return Promise.resolve({
        exists: () => true,
        data: () => ({
          stake_name: 'East Colorado Stake',
          kindoo_config: { site_id: 11111 },
        }),
      });
    });
    getDocsMock.mockImplementation((ref: unknown) => {
      const args = (ref as { __coll: unknown[] }).__coll;
      const stakeId = args[2] as string;
      if (stakeId === 'east-co') {
        return Promise.resolve({
          docs: [
            {
              data: () => ({
                id: 'pine',
                display_name: 'Pine Building',
                kindoo_eid: 27994,
              }),
            },
          ],
        });
      }
      return Promise.resolve({ docs: [] });
    });
    const { resolveEidStakes } = await import('./data');
    const out = await resolveEidStakes(27994, ['csnorth', 'east-co']);
    expect(out.candidates).toHaveLength(2);
    expect(out.failedStakes).toEqual([]);
    // Alphabetical sort by label — Colorado Springs ... < East Colorado.
    expect(out.candidates[0]?.stakeId).toBe('csnorth');
    expect(out.candidates[0]?.match).toBe('home');
    expect(out.candidates[1]?.stakeId).toBe('east-co');
    expect(out.candidates[1]?.match).toBe('foreign');
    expect(out.candidates[1]?.siteLabel).toBe('Pine Building');
  });

  it('returns an empty candidate list with failedStakes=[] when no managed stake has the EID configured', async () => {
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        stake_name: 'Colorado Springs North Stake',
        kindoo_config: { site_id: 11111 },
      }),
    });
    getDocsMock.mockResolvedValue({ docs: [] });
    const { resolveEidStakes } = await import('./data');
    const out = await resolveEidStakes(99999, ['csnorth']);
    expect(out).toEqual({ candidates: [], failedStakes: [] });
  });

  it('skips managed stakes whose parent doc no longer exists (not a failure)', async () => {
    // Defensive: rules could deny the read OR the stake was deleted.
    // The resolver returns whatever's resolvable, not an error. A
    // missing doc is NOT a per-stake failure (no exception thrown);
    // failedStakes stays empty.
    getDocMock.mockResolvedValue({ exists: () => false, data: () => ({}) });
    getDocsMock.mockResolvedValue({ docs: [] });
    const { resolveEidStakes } = await import('./data');
    const out = await resolveEidStakes(27994, ['ghost-stake']);
    expect(out).toEqual({ candidates: [], failedStakes: [] });
  });

  it('prefers a home match over a foreign match on the same stake', async () => {
    // Defensive: SBA config would be malformed if a stake's own foreign
    // site shared its home EID. Resolver returns home, not foreign.
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        stake_name: 'CSN',
        kindoo_config: { site_id: 27994 },
      }),
    });
    getDocsMock.mockResolvedValue({
      docs: [{ data: () => ({ id: 'weird', display_name: 'Weird', kindoo_eid: 27994 }) }],
    });
    const { resolveEidStakes } = await import('./data');
    const out = await resolveEidStakes(27994, ['csnorth']);
    expect(out).toEqual({
      candidates: [{ stakeId: 'csnorth', label: 'CSN', match: 'home' }],
      failedStakes: [],
    });
  });

  it('returns only the resolvable subset when one stake read rejects (Risk 1)', async () => {
    // Risk 1: a single stake's rules-denial or Firestore hiccup must
    // NOT nuke every other candidate via Promise.all rejection. The
    // per-stake try/catch isolates the failure to that one stake.
    getDocMock.mockImplementation((ref: unknown) => {
      const args = (ref as { __doc: unknown[] }).__doc;
      const stakeId = args[2] as string;
      if (stakeId === 'stake-a') {
        return Promise.reject(
          Object.assign(new Error('permission denied'), { code: 'permission-denied' }),
        );
      }
      return Promise.resolve({
        exists: () => true,
        data: () => ({
          stake_name: 'Stake B',
          kindoo_config: { site_id: 27994 },
        }),
      });
    });
    getDocsMock.mockImplementation((ref: unknown) => {
      const args = (ref as { __coll: unknown[] }).__coll;
      const stakeId = args[2] as string;
      if (stakeId === 'stake-a') {
        return Promise.reject(
          Object.assign(new Error('permission denied'), { code: 'permission-denied' }),
        );
      }
      return Promise.resolve({ docs: [] });
    });
    const { resolveEidStakes } = await import('./data');
    const out = await resolveEidStakes(27994, ['stake-a', 'stake-b']);
    expect(out).toEqual({
      candidates: [{ stakeId: 'stake-b', label: 'Stake B', match: 'home' }],
      failedStakes: ['stake-a'],
    });
  });

  it('drops every failing stake but returns the remainder when multiple stakes throw', async () => {
    // Belt-and-braces variant of the Risk 1 test: every stake but one
    // rejects. The resolvable stake still surfaces.
    getDocMock.mockImplementation((ref: unknown) => {
      const args = (ref as { __doc: unknown[] }).__doc;
      const stakeId = args[2] as string;
      if (stakeId === 'stake-good') {
        return Promise.resolve({
          exists: () => true,
          data: () => ({
            stake_name: 'Good Stake',
            kindoo_config: { site_id: 27994 },
          }),
        });
      }
      return Promise.reject(new Error('failed'));
    });
    getDocsMock.mockImplementation((ref: unknown) => {
      const args = (ref as { __coll: unknown[] }).__coll;
      const stakeId = args[2] as string;
      if (stakeId === 'stake-good') return Promise.resolve({ docs: [] });
      return Promise.reject(new Error('failed'));
    });
    const { resolveEidStakes } = await import('./data');
    const out = await resolveEidStakes(27994, ['stake-bad-1', 'stake-good', 'stake-bad-2']);
    expect(out).toEqual({
      candidates: [{ stakeId: 'stake-good', label: 'Good Stake', match: 'home' }],
      failedStakes: ['stake-bad-1', 'stake-bad-2'],
    });
  });

  it('returns empty candidates with both failures listed when every per-stake read throws (Item 2)', async () => {
    // Item 2: a transient Firestore-wide outage would surface as
    // every per-stake read rejecting. The resolver must report this
    // as a partial failure so App.tsx can route to wire-error
    // recovery (not the misleading no-candidates "reconfigure SBA"
    // copy).
    getDocMock.mockRejectedValue(new Error('unavailable'));
    getDocsMock.mockRejectedValue(new Error('unavailable'));
    const { resolveEidStakes } = await import('./data');
    const out = await resolveEidStakes(27994, ['stake-a', 'stake-b']);
    expect(out).toEqual({ candidates: [], failedStakes: ['stake-a', 'stake-b'] });
  });

  it('populates failedStakes with the exact stakeIds that failed alongside surviving candidates (T-48)', async () => {
    // T-48: a partial failure with surviving candidates must surface
    // which stakeIds caught so the panel can render a non-modal
    // partial-failure banner. The aggregate `partialFailure` boolean
    // is the SW handler's wire convenience; the resolver itself emits
    // the precise ID list.
    getDocMock.mockImplementation((ref: unknown) => {
      const args = (ref as { __doc: unknown[] }).__doc;
      const stakeId = args[2] as string;
      if (stakeId === 'stake-ok') {
        return Promise.resolve({
          exists: () => true,
          data: () => ({
            stake_name: 'OK Stake',
            kindoo_config: { site_id: 27994 },
          }),
        });
      }
      return Promise.reject(new Error('rules denied'));
    });
    getDocsMock.mockImplementation((ref: unknown) => {
      const args = (ref as { __coll: unknown[] }).__coll;
      const stakeId = args[2] as string;
      if (stakeId === 'stake-ok') return Promise.resolve({ docs: [] });
      return Promise.reject(new Error('rules denied'));
    });
    const { resolveEidStakes } = await import('./data');
    const out = await resolveEidStakes(27994, ['stake-fail-1', 'stake-ok', 'stake-fail-2']);
    expect(out.candidates).toEqual([{ stakeId: 'stake-ok', label: 'OK Stake', match: 'home' }]);
    // Order tracks `managerStakes` input order (Promise.all preserves
    // index ordering); the test pins both IDs surface.
    expect(out.failedStakes).toEqual(['stake-fail-1', 'stake-fail-2']);
  });
});

describe('loadStakeConfig — stake parameterisation', () => {
  beforeEach(() => {
    getDocMock.mockReset();
    getDocsMock.mockReset();
    docMock.mockClear();
    collectionMock.mockClear();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('reads against the supplied stakeId path, not a hardcoded constant', async () => {
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({ stake_id: 'east-co', stake_name: 'East CO' }),
    });
    getDocsMock.mockResolvedValue({ docs: [] });
    const { loadStakeConfig } = await import('./data');
    await loadStakeConfig('east-co');
    // First docMock call is `doc(db, 'stakes', 'east-co')` for the
    // parent doc; collectionMock calls cover the three sub-collections.
    expect(docMock).toHaveBeenCalledWith(expect.anything(), 'stakes', 'east-co');
    expect(collectionMock).toHaveBeenCalledWith(
      expect.anything(),
      'stakes',
      'east-co',
      'buildings',
    );
    expect(collectionMock).toHaveBeenCalledWith(expect.anything(), 'stakes', 'east-co', 'wards');
    expect(collectionMock).toHaveBeenCalledWith(
      expect.anything(),
      'stakes',
      'east-co',
      'kindooSites',
    );
  });
});

describe('loadSeatByEmail — stake parameterisation', () => {
  beforeEach(() => {
    getDocMock.mockReset();
    docMock.mockClear();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('reads the seat under the supplied stakeId, not a hardcoded constant', async () => {
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({ member_canonical: 'a@example.com' }),
    });
    const { loadSeatByEmail } = await import('./data');
    await loadSeatByEmail('east-co', 'a@example.com');
    expect(docMock).toHaveBeenCalledWith(
      expect.anything(),
      'stakes',
      'east-co',
      'seats',
      'a@example.com',
    );
  });
});
