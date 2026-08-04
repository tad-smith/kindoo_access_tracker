// Single owner of `STORAGE_KEYS.remoteApplyEnabled` — the "Allow
// requests from my phone" opt-in.
//
// Per `extension/CLAUDE.md`, every chrome.storage key has exactly one
// owning module and all other readers / writers route through it. Two
// components need this value in the same page (the toggle row in
// `panel/QueuePanel` and the heartbeat/poll loop hosted by
// `panel/TabbedShell`), so this module also owns the fan-out:
//
//   - an in-process subscriber set, notified synchronously on write, so
//     flipping the toggle stops the heartbeat on the SAME tick rather
//     than whenever the storage event happens to land;
//   - `chrome.storage.onChanged`, so a second Kindoo tab (or the same
//     tab after a reload) converges without a page refresh.
//
// Default is OFF. Absent value ⇒ off, deliberately: the toggle hands a
// second device authority to provision building access, and a profile
// that predates the feature has not consented to that.

import { useCallback, useEffect, useState } from 'react';
import { STORAGE_KEYS } from './messaging';

type Listener = (enabled: boolean) => void;

const listeners = new Set<Listener>();

/** Last value this context read or wrote. Lets the loop read the
 * current setting synchronously mid-tick without an await. */
let cached = false;

function broadcast(enabled: boolean): void {
  cached = enabled;
  for (const listener of listeners) {
    try {
      listener(enabled);
    } catch (err) {
      console.warn('[sba-ext] remote-apply pref listener threw', err);
    }
  }
}

/** Read the persisted opt-in. Any storage failure resolves to `false` —
 * failing closed is the only safe direction for a consent flag. */
export async function readRemoteApplyEnabled(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.remoteApplyEnabled]);
    const enabled = result?.[STORAGE_KEYS.remoteApplyEnabled] === true;
    cached = enabled;
    return enabled;
  } catch (err) {
    console.warn('[sba-ext] could not read the remote-apply opt-in; treating as off', err);
    return false;
  }
}

/**
 * Persist the opt-in and notify this context immediately. Rejects on a
 * storage failure so the toggle can surface it instead of showing a
 * state that didn't survive.
 */
export async function writeRemoteApplyEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.remoteApplyEnabled]: enabled });
  broadcast(enabled);
}

/** Synchronous view of the last-known value; `false` until first read. */
export function remoteApplyEnabledSnapshot(): boolean {
  return cached;
}

/** Subscribe to opt-in changes from any context. Returns an unsubscribe. */
export function subscribeRemoteApplyEnabled(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Cross-context convergence. Registered once at module load; the
// listener is cheap and the module lives for the page's lifetime.
// Optional-chained because `chrome.storage.onChanged` is absent under
// the jsdom stub in unit tests.
chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
  if (areaName !== 'local') return;
  const change = changes[STORAGE_KEYS.remoteApplyEnabled];
  if (!change) return;
  const next = change.newValue === true;
  if (next === cached) return;
  broadcast(next);
});

export interface RemoteApplyToggle {
  enabled: boolean;
  /** False until the first storage read resolves. The toggle renders
   * disabled meanwhile so it can't be clicked into a value that the
   * pending read then overwrites. */
  loaded: boolean;
  /** Rejects if the write fails; caller surfaces the error. */
  setEnabled: (next: boolean) => Promise<void>;
}

/** React binding over the opt-in. Safe to mount in several components
 * at once — they all observe the same value. */
export function useRemoteApplyEnabled(): RemoteApplyToggle {
  const [enabled, setEnabledState] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readRemoteApplyEnabled().then((value) => {
      if (cancelled) return;
      setEnabledState(value);
      setLoaded(true);
    });
    const unsubscribe = subscribeRemoteApplyEnabled((value) => {
      if (cancelled) return;
      setEnabledState(value);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const setEnabled = useCallback(async (next: boolean) => {
    await writeRemoteApplyEnabled(next);
  }, []);

  return { enabled, loaded, setEnabled };
}
