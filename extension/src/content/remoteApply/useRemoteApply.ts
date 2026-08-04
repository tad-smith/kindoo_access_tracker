// React binding for the remote-apply loop.
//
// Hosted by `panel/TabbedShell` rather than `panel/QueuePanel`, for two
// reasons:
//
//   1. The panel mounts on every web.kindoo.tech page load whether or
//      not the slide-over is open (`content/mount.tsx`). Hosting the
//      loop inside the React tree therefore gets us a background worker
//      with a closed panel and no extra manifest permissions — which is
//      the entire reason polling beat push for this feature.
//   2. QueuePanel unmounts when the operator switches to the Sync tab.
//      A manager who left the panel on Sync would silently stop being
//      reachable from their phone.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRemoteApplyEnabled } from '../../lib/remoteApplyPrefs';
import { writeRemotePresence, type StakeConfigBundle } from '../../lib/extensionApi';
import { startRemoteApplyLoop } from './loop';

export interface RemoteApplyState {
  /** The phone-initiated job this tab is executing right now, or null. */
  running: { jobId: string; requestId: string } | null;
  /**
   * `request_id`s a phone-initiated job holds as of the last poll —
   * still `queued` in the mailbox, `running` on another of the manager's
   * Kindoo tabs, or claimed by this tab and not yet written terminal.
   * `running` below covers only this tab's own claim and only while it
   * ends cleanly, which is a fraction of the window in which a second
   * provision would double-write Kindoo. Gate the provision button on
   * both; see the loop's `onBusyRequestIds`.
   */
  busyRequestIds: readonly string[];
  /** Bumped every time a job reaches a terminal status on this tab.
   * The queue watches it to refetch, so the desktop never sits showing
   * a request the phone just completed. */
  finishedCount: number;
}

/** Stable identity for "nothing in hand", so the common case never
 * re-renders the host on a fresh array. */
const NO_BUSY_IDS: readonly string[] = [];

export interface UseRemoteApplyArgs {
  stakeId: string;
  bundle: StakeConfigBundle;
}

/** Manifest version, for the presence doc + the job's `claimed_by`.
 * Optional-chained: `getManifest` is absent under the jsdom test stub. */
function extensionVersion(): string {
  return chrome.runtime?.getManifest?.()?.version ?? '0.0.0';
}

export function useRemoteApply({ stakeId, bundle }: UseRemoteApplyArgs): RemoteApplyState {
  const { enabled, loaded } = useRemoteApplyEnabled();
  const [running, setRunning] = useState<RemoteApplyState['running']>(null);
  const [busyRequestIds, setBusyRequestIds] = useState<readonly string[]>(NO_BUSY_IDS);
  const [finishedCount, setFinishedCount] = useState(0);
  /** Whether the opt-in was on the last time this effect ran. Only a
   * true → false transition warrants the disable write; publishing
   * `enabled: false` on a first mount would create a presence doc for a
   * manager who never opted in. */
  const wasEnabled = useRef(false);
  /**
   * Site key of the desktop doc this tab last published, so opting out
   * can delete it. Held here rather than read off the loop because the
   * loop is already stopped by the time the disable write runs — and
   * because resolving it afresh would need a live Kindoo session, which
   * revoking consent must never depend on.
   */
  const publishedSiteKey = useRef<string | null>(null);
  /**
   * The loop reads `bundle` at tick time, so it must NOT be an effect
   * dependency: keying on its identity means every re-render that
   * rebuilds the object tears the loop down and starts a fresh one.
   * TabbedShell re-renders on every queue fetch, and a restart cadence
   * faster than the loop's first (0ms macrotask) tick means no tick ever
   * completes: `startRemoteApplyLoop` defers that first tick with
   * `setTimeout(…, 0)` and `teardown` clears the timer, so a loop torn
   * down before the macrotask runs does no work at all. Nor does the
   * next one start any further along — every gate the loop times against
   * is closure state (`lastResolveAt`, `lastSweepAt`, `lastBusyReadAt`,
   * `publishedBusyIds`), so each construction begins from nothing.
   * No error, no log; the manager's phone just never sees a desktop.
   * Reading through a ref also means a reconfigure reaches the next tick
   * without a teardown.
   *
   * Deliberate belt-and-braces — do NOT collapse this back into the dep
   * array on the grounds that `bundle` happens to be stable today. It is
   * (App holds it in state and TabbedShell passes it straight through),
   * and that is exactly what makes the revert look safe. The starvation
   * is silent, so nothing would fail loudly if the invariant were ever
   * broken upstream; the same host also re-renders on every queue fetch
   * AND on every `setFinishedCount`, so its render cadence is set by
   * traffic rather than by anything visible here.
   */
  const bundleRef = useRef(bundle);
  bundleRef.current = bundle;

  const publishDisabled = useCallback(async () => {
    try {
      await writeRemotePresence({
        enabled: false,
        // Clears the flag AND this tab's desktop doc. Flipping the
        // profile-wide flag alone would leave the phone still naming a
        // Kindoo site as covered for a full staleness window — a dead
        // button with a confident label under it. Deleting is safe
        // precisely because the flag is profile-wide: with it off, no
        // sibling tab is serving that site either.
        siteKey: publishedSiteKey.current,
        extVersion: extensionVersion(),
      });
    } catch (err) {
      // Worst case the phone waits out the staleness window instead of
      // losing the button immediately. Not worth surfacing.
      console.warn('[sba-ext] remote apply: could not clear presence', err);
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    if (!enabled) {
      // No loop means nothing left to refresh the busy set, and a set
      // that stands after the loop dies gates the provision button on a
      // job nothing is going to run.
      setBusyRequestIds(NO_BUSY_IDS);
      if (wasEnabled.current) {
        wasEnabled.current = false;
        void publishDisabled();
      }
      return;
    }
    wasEnabled.current = true;
    const handle = startRemoteApplyLoop({
      stakeId,
      // Getter, not a snapshot: the loop reads this per tick, so a
      // reconfigure lands on the next tick with no restart. See
      // `bundleRef`.
      get bundle() {
        return bundleRef.current;
      },
      extVersion: extensionVersion(),
      onJobStart: (job) => setRunning({ jobId: job.jobId, requestId: job.requestId }),
      onJobEnd: () => {
        setRunning(null);
        setFinishedCount((n) => n + 1);
      },
      // Already de-duplicated by the loop, which only calls this when
      // the set moves — so this is not a per-tick re-render.
      onBusyRequestIds: setBusyRequestIds,
      // Sticky on purpose. A tab that moves to a second Kindoo site
      // publishes the new site and leaves the old doc to go stale — a
      // sibling tab may still be serving it, so deleting on a site
      // switch would blank a live desktop. Only opt-out, which kills
      // every tab in the profile, gets to delete.
      onSitePublished: (siteKey) => {
        publishedSiteKey.current = siteKey;
      },
    });
    // `stop()` cancels the scheduler but cannot abort a tick already
    // awaiting the network, so this cleanup does NOT by itself order the
    // loop's presence write before `publishDisabled()`. The loop re-reads
    // the opt-in immediately before every presence write for exactly that
    // reason — see `heartbeatIfDue`.
    return () => handle.stop();
    // `bundle` is deliberately absent — see `bundleRef`.
  }, [enabled, loaded, stakeId, publishDisabled]);

  return { running, busyRequestIds, finishedCount };
}
