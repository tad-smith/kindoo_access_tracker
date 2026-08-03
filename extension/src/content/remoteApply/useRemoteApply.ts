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
import { readKindooSession } from '../kindoo/auth';
import { startRemoteApplyLoop } from './loop';

export interface RemoteApplyState {
  /** The phone-initiated job this tab is executing right now, or null. */
  running: { jobId: string; requestId: string } | null;
  /** Bumped every time a job reaches a terminal status on this tab.
   * The queue watches it to refetch, so the desktop never sits showing
   * a request the phone just completed. */
  finishedCount: number;
}

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
  const [finishedCount, setFinishedCount] = useState(0);
  /** Whether the opt-in was on the last time this effect ran. Only a
   * true → false transition warrants the disable write; publishing
   * `enabled: false` on a first mount would create a presence doc for a
   * manager who never opted in. */
  const wasEnabled = useRef(false);

  const publishDisabled = useCallback(async () => {
    const session = readKindooSession();
    try {
      await writeRemotePresence({
        stakeId,
        kindooEid: session.ok ? session.session.eid : null,
        kindooSiteName: null,
        extVersion: extensionVersion(),
        enabled: false,
      });
    } catch (err) {
      // Worst case the phone waits out the staleness window instead of
      // losing the button immediately. Not worth surfacing.
      console.warn('[sba-ext] remote apply: could not clear presence', err);
    }
  }, [stakeId]);

  useEffect(() => {
    if (!loaded) return;
    if (!enabled) {
      if (wasEnabled.current) {
        wasEnabled.current = false;
        void publishDisabled();
      }
      return;
    }
    wasEnabled.current = true;
    const handle = startRemoteApplyLoop({
      stakeId,
      bundle,
      extVersion: extensionVersion(),
      onJobStart: (job) => setRunning({ jobId: job.jobId, requestId: job.requestId }),
      onJobEnd: () => {
        setRunning(null);
        setFinishedCount((n) => n + 1);
      },
    });
    return () => handle.stop();
  }, [enabled, loaded, stakeId, bundle, publishDisabled]);

  return { running, finishedCount };
}
