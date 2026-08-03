// Execute one phone-queued job on this Kindoo tab.
//
// The job doc names only a `request_id` — deliberately. The phone
// cannot be trusted to describe what should happen (it is a second
// device with a snapshot that may be minutes stale), so the desktop
// re-resolves the request from `getMyPendingRequests` and refuses if it
// is no longer pending. That single check also covers the double-tap
// case and the "someone else already handled it on the web" case.
//
// From there the work is `applyRequest` — the exact function the
// desktop's own button calls. This module only translates its outcome
// into the job-doc shape the phone renders.

import type { RemoteApplyJobStatus, RemoteApplyOutcome } from '@kindoo/shared';
import type { RemoteApplyJobRef, StakeConfigBundle } from '../../lib/extensionApi';
import { getMyPendingRequests } from '../../lib/extensionApi';
import { applyRequest, type ApplyRequestResult } from '../kindoo/applyRequest';

/** Terminal statuses the extension is allowed to write. `cancelled`
 * belongs to the phone's no-pickup timeout. */
export type RemoteApplyTerminalStatus = Extract<
  RemoteApplyJobStatus,
  'applied' | 'partial' | 'failed'
>;

export interface RemoteApplyJobResult {
  status: RemoteApplyTerminalStatus;
  outcome: RemoteApplyOutcome;
}

export interface RunRemoteApplyJobArgs {
  stakeId: string;
  bundle: StakeConfigBundle;
  job: RemoteApplyJobRef;
  /** Injection seam for tests; production uses the real modules. */
  deps?: {
    getMyPendingRequests?: typeof getMyPendingRequests;
    applyRequest?: typeof applyRequest;
  };
}

/**
 * Translate an `applyRequest` outcome into the job-doc status +
 * outcome the phone reads.
 *
 * The `partial` mapping is the one that matters: Kindoo access HAS been
 * granted or revoked and only the SBA bookkeeping is missing. Reporting
 * that as `failed` would send the manager back to re-apply something
 * that already happened.
 */
export function toJobResult(result: ApplyRequestResult): RemoteApplyJobResult {
  if (result.status === 'applied') {
    return {
      status: 'applied',
      outcome: {
        code: 'applied',
        message: result.note,
        ...(result.kindooUid ? { kindoo_uid: result.kindooUid } : {}),
        provisioning_note: result.note,
      },
    };
  }
  if (result.status === 'partial') {
    return {
      status: 'partial',
      outcome: {
        code: 'sba_incomplete',
        message:
          `Applied in Kindoo, but Stake Building Access could not be marked complete: ` +
          `${result.message} Finish it on your desktop.`,
        ...(result.kindooUid ? { kindoo_uid: result.kindooUid } : {}),
        provisioning_note: result.note,
      },
    };
  }
  return {
    status: 'failed',
    outcome: { code: result.code, message: result.message },
  };
}

/**
 * Resolve the request, run the shared provisioning flow, and report.
 * Never throws — an unexpected error still has to reach the phone as a
 * terminal status, or the job sits `running` forever with nothing to
 * show for it.
 */
export async function runRemoteApplyJob({
  stakeId,
  bundle,
  job,
  deps,
}: RunRemoteApplyJobArgs): Promise<RemoteApplyJobResult> {
  const fetchPending = deps?.getMyPendingRequests ?? getMyPendingRequests;
  const apply = deps?.applyRequest ?? applyRequest;

  let pending: Awaited<ReturnType<typeof getMyPendingRequests>>;
  try {
    pending = await fetchPending({ stakeId });
  } catch (err) {
    return {
      status: 'failed',
      outcome: {
        code: 'error',
        message: `Could not read the request queue: ${describe(err)}`,
      },
    };
  }

  const request = pending.requests.find((r) => r.request_id === job.requestId);
  if (!request) {
    return {
      status: 'failed',
      outcome: {
        code: 'request_not_pending',
        message:
          'This request is no longer pending — it was completed, rejected, or cancelled before your desktop picked it up.',
      },
    };
  }

  try {
    return toJobResult(await apply({ stakeId, request, bundle }));
  } catch (err) {
    // `applyRequest` is documented not to throw; if it ever does, the
    // job still has to terminate.
    console.error('[sba-ext] remote apply: unexpected failure applying a job', err);
    return { status: 'failed', outcome: { code: 'error', message: describe(err) } };
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
