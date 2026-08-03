// Unit tests for the remote-apply opt-in — the single owner of
// `STORAGE_KEYS.remoteApplyEnabled`.
//
// The load-bearing property is the default: absent ⇒ off. This flag
// grants a second device authority to provision building access, so a
// profile that predates the feature (or a chrome.storage read that
// failed) must never read as consent.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from './messaging';

const KEY = STORAGE_KEYS.remoteApplyEnabled;

interface LocalStorageStub {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

function storage(): LocalStorageStub {
  return globalThis.chrome.storage.local as unknown as LocalStorageStub;
}

describe('remoteApplyPrefs', () => {
  beforeEach(() => {
    storage().get.mockReset();
    storage().set.mockReset();
    storage().get.mockResolvedValue({});
    storage().set.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('defaults to off when the key has never been written', async () => {
    const { readRemoteApplyEnabled } = await import('./remoteApplyPrefs');
    await expect(readRemoteApplyEnabled()).resolves.toBe(false);
    expect(storage().get).toHaveBeenCalledWith([KEY]);
  });

  it('round-trips the flag through chrome.storage.local', async () => {
    const { readRemoteApplyEnabled, writeRemoteApplyEnabled } = await import('./remoteApplyPrefs');

    await writeRemoteApplyEnabled(true);
    expect(storage().set).toHaveBeenCalledWith({ [KEY]: true });

    storage().get.mockResolvedValue({ [KEY]: true });
    await expect(readRemoteApplyEnabled()).resolves.toBe(true);

    await writeRemoteApplyEnabled(false);
    expect(storage().set).toHaveBeenLastCalledWith({ [KEY]: false });
    storage().get.mockResolvedValue({ [KEY]: false });
    await expect(readRemoteApplyEnabled()).resolves.toBe(false);
  });

  it('reads a non-boolean stored value as off', async () => {
    // Anything that isn't literally `true` fails closed.
    storage().get.mockResolvedValue({ [KEY]: 'yes' });
    const { readRemoteApplyEnabled } = await import('./remoteApplyPrefs');
    await expect(readRemoteApplyEnabled()).resolves.toBe(false);
  });

  it('fails closed when chrome.storage rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    storage().get.mockRejectedValue(new Error('storage unavailable'));
    const { readRemoteApplyEnabled } = await import('./remoteApplyPrefs');
    await expect(readRemoteApplyEnabled()).resolves.toBe(false);
  });

  it('notifies in-process subscribers on write so the loop stops on the same tick', async () => {
    const { subscribeRemoteApplyEnabled, writeRemoteApplyEnabled } =
      await import('./remoteApplyPrefs');
    const seen: boolean[] = [];
    const unsubscribe = subscribeRemoteApplyEnabled((value) => seen.push(value));

    await writeRemoteApplyEnabled(true);
    await writeRemoteApplyEnabled(false);
    expect(seen).toEqual([true, false]);

    unsubscribe();
    await writeRemoteApplyEnabled(true);
    expect(seen).toEqual([true, false]);
  });

  it('propagates a write failure instead of pretending the toggle stuck', async () => {
    storage().set.mockRejectedValue(new Error('quota'));
    const { writeRemoteApplyEnabled } = await import('./remoteApplyPrefs');
    await expect(writeRemoteApplyEnabled(true)).rejects.toThrow('quota');
  });
});
