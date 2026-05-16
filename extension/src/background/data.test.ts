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
    docMock.mockClear();
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
    // First batch.update call is the stake doc.
    const stakePayload = updateMock.mock.calls[0]?.[1] as {
      kindoo_config: { site_id: number; site_name: string };
    };
    expect(stakePayload.kindoo_config.site_id).toBe(27994);
    expect(stakePayload.kindoo_config.site_name).toBe('Cordera Stake');
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
    const stakePayload = updateMock.mock.calls[0]?.[1] as {
      kindoo_config: { site_name: string };
    };
    expect(stakePayload.kindoo_config.site_name).toBe('');
  });

  it('writes the supplied siteName when non-empty (no defensive read needed)', async () => {
    // Happy path: env was present, panel passed a real name. Writer
    // should skip the getDoc round-trip.
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
    const stakePayload = updateMock.mock.calls[0]?.[1] as {
      kindoo_config: { site_name: string };
    };
    expect(stakePayload.kindoo_config.site_name).toBe('Cordera Stake');
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

  it('does not consult the stake doc on a foreign-site save', async () => {
    // Foreign save never touches stake.kindoo_config — the defensive
    // read is home-only.
    const { writeKindooConfig } = await import('./data');
    await writeKindooConfig(
      {
        kindooSiteId: 'east-stake',
        siteId: 4321,
        siteName: '',
        buildingRules: [],
      },
      actor(),
    );
    expect(getDocMock).not.toHaveBeenCalled();
  });
});
