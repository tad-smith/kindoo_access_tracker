// Manager Queue data hooks.
//
//   - `usePendingRequests()` — live list of requests with status='pending',
//     ordered FIFO (oldest first). Indexed via the
//     `(status ASC, requested_at ASC)` composite from
//     `firestore.indexes.json`.
//
// Remote apply (D27) adds the queue's only write path. The manager's
// desktop extension publishes presence to `remoteApply/{canonical}`;
// the phone writes a job doc into its `jobs` subcollection and watches
// the extension drive it to a terminal status. The phone may only
// create a job at `queued` and may only move `queued → cancelled`
// (the no-pickup timeout) — every other transition belongs to the
// extension and is rules-enforced.
//
//   - `useRemoteApplyPresence()` — is the desktop usable right now?
//   - `useRemoteApplyJobsByRequest()` — the mailbox's jobs, reduced to
//     the one job per request a card should render, so a reload doesn't
//     lose track of an in-flight apply.
//   - `useQueueRemoteApplyJob()` / `useCancelRemoteApplyJob()` — the two
//     writes.
//   - `useRemoteApplyPickupTimeout()` — cancels a job the desktop never
//     claimed.

import { useMutation } from '@tanstack/react-query';
import {
  addDoc,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type Query,
} from 'firebase/firestore';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  REMOTE_APPLY_PICKUP_TIMEOUT_MS,
  canonicalEmail,
  isRemoteApplyOnline,
  type AccessRequest,
  type RemoteApplyJob,
  type RemoteApplyPresence,
  type TimestampLike,
} from '@kindoo/shared';
import { useFirestoreCollection, useFirestoreDoc } from '../../../lib/data';
import { db } from '../../../lib/firebase';
import {
  remoteApplyJobRef,
  remoteApplyJobsCol,
  remoteApplyRef,
  requestsCol,
} from '../../../lib/docs';
import { usePrincipal, type Principal } from '../../../lib/principal';
import { useActiveStake } from '../../../lib/useActiveStake';
import { getDeviceId } from '../../notifications/lib';

/** Live FIFO pending-requests list. */
export function usePendingRequests() {
  const activeStakeId = useActiveStake();
  const q = useMemo(
    () =>
      activeStakeId
        ? query(
            requestsCol(db, activeStakeId),
            where('status', '==', 'pending'),
            orderBy('requested_at', 'asc'),
          )
        : null,
    [activeStakeId],
  );
  return useFirestoreCollection<AccessRequest>(q);
}

/**
 * How often the presence badge re-evaluates freshness. Presence goes
 * stale by the clock, not by a write: a desktop that closes its Kindoo
 * tab simply stops heartbeating, which produces no new snapshot. Without
 * a tick the badge would sit on "online" indefinitely. This is a UI
 * refresh cadence, not part of the extension contract — the contract
 * timings live in `@kindoo/shared`.
 */
const PRESENCE_RECHECK_MS = 30_000;

/**
 * Why the desktop can (or can't) act right now.
 *   `loading`     — presence subscription hasn't resolved yet; render nothing.
 *   `online`      — opted in, fresh heartbeat, same stake. Show the button.
 *   `stale`       — opted in but the heartbeat aged out (Kindoo tab closed,
 *                   computer asleep, signed out of Kindoo).
 *   `other-stake` — fresh, but the desktop is in a different stake's Kindoo
 *                   site, so it can't apply what's on this screen.
 *   `off`         — no presence doc, or the extension toggle is off. Also the
 *                   fallback when the read errors, since the advice ("turn it
 *                   on over there") is the same.
 */
export type RemoteApplyPresenceState = 'loading' | 'online' | 'stale' | 'other-stake' | 'off';

export interface RemoteApplyPresenceResult {
  state: RemoteApplyPresenceState;
  /** Convenience: `state === 'online'`. Gates the Apply button. */
  online: boolean;
  /** Kindoo site the desktop is sitting in, when it published one. */
  siteName: string | null;
  presence: RemoteApplyPresence | undefined;
}

/**
 * Live presence for the signed-in manager's own desktop extension.
 *
 * Freshness is derived from `isRemoteApplyOnline` (shared with the
 * extension) against a clock that ticks every {@link PRESENCE_RECHECK_MS},
 * so an abandoned heartbeat ages out on its own.
 */
export function useRemoteApplyPresence(): RemoteApplyPresenceResult {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const ref = useMemo(
    () => (principal.canonical ? remoteApplyRef(db, principal.canonical) : null),
    [principal.canonical],
  );
  const presenceDoc = useFirestoreDoc<RemoteApplyPresence>(ref);
  const now = useNowTick(PRESENCE_RECHECK_MS);

  const presence = presenceDoc.data;
  const state: RemoteApplyPresenceState = (() => {
    if (!ref) return 'off';
    if (presenceDoc.isLoading) return 'loading';
    if (!presence || presence.remote_apply_enabled !== true) return 'off';
    if (!activeStakeId) return 'off';
    if (isRemoteApplyOnline(presence, activeStakeId, now)) return 'online';
    // Opted in but unusable. Distinguish "wrong stake" from "not there"
    // — telling a manager whose desktop is heartbeating fine to go open
    // Kindoo sends them chasing the wrong problem. Freshness alone is
    // `isRemoteApplyOnline` evaluated against the presence's own stake,
    // so the staleness window stays defined in exactly one place.
    const heartbeatFresh = isRemoteApplyOnline(presence, presence.stake_id, now);
    return heartbeatFresh ? 'other-stake' : 'stale';
  })();

  return {
    state,
    online: state === 'online',
    siteName: presence?.kindoo_site_name ?? null,
    presence,
  };
}

/** A `RemoteApplyJob` body plus its Firestore doc id (read-layer only). */
export type RemoteApplyJobWithId = RemoteApplyJob & { job_id: string };

export interface RemoteApplyJobsResult {
  /** The job each request's card should render, by `request_id`. */
  byRequest: Map<string, RemoteApplyJobWithId>;
  /**
   * The subscription hasn't resolved yet, so "no job for this request"
   * is not yet a fact. The card withholds the Apply button until it is —
   * tapping into an unresolved mailbox is one of the ways a request ends
   * up with two jobs.
   */
  isLoading: boolean;
}

/**
 * Every job in the manager's mailbox, reduced to the one job per
 * `request_id` a card should render. Reload-safe: a manager who taps
 * Apply and then reloads still sees the running job — and still can't
 * queue a second one for the same request.
 *
 * The query is deliberately unconstrained, on both axes:
 *
 *   - **No status filter.** Terminal jobs have to stay visible. The
 *     reason one request can hold several jobs is a duplicate, and a
 *     duplicate always ends the same way — the desktop claims the loser,
 *     finds the request no longer pending, and marks it `failed`.
 *     Filtering to `queued`/`running` would leave the card holding that
 *     orphan and reporting a failure on work that landed.
 *   - **No `orderBy` / `limit`.** A just-written job carries an
 *     unresolved `serverTimestamp()`, which reads as null locally and so
 *     sorts *last* under `orderBy('created_at','desc')` — it would fall
 *     out of a limited window during exactly the seconds the duplicate
 *     guard needs it.
 *
 * It's one manager's own jobs at 1–2 requests a week, so reading the lot
 * costs less than either filter would.
 */
export function useRemoteApplyJobsByRequest(): RemoteApplyJobsResult {
  const principal = usePrincipal();
  const q = useMemo(() => {
    if (!principal.canonical) return null;
    return remoteApplyJobsCol(db, principal.canonical) as unknown as Query<RemoteApplyJobWithId>;
  }, [principal.canonical]);
  const jobs = useFirestoreCollection<RemoteApplyJobWithId>(q, { idField: 'job_id' });
  const byRequest = useMemo(() => {
    const grouped = new Map<string, RemoteApplyJobWithId[]>();
    for (const job of jobs.data ?? []) {
      const forRequest = grouped.get(job.request_id);
      if (forRequest) forRequest.push(job);
      else grouped.set(job.request_id, [job]);
    }
    const resolved = new Map<string, RemoteApplyJobWithId>();
    for (const [requestId, forRequest] of grouped) {
      const best = pickRemoteApplyJob(forRequest);
      if (best) resolved.set(requestId, best);
    }
    return resolved;
  }, [jobs.data]);
  return { byRequest, isLoading: jobs.isLoading };
}

/**
 * The job that speaks for a request when it has more than one.
 *
 * Duplicates are rare — the card blocks a second tap — but the create
 * rule permits them, so the display has to survive one. Precedence is by
 * how conclusive the status is, NOT by recency: the orphan of a
 * duplicate is claimed *after* the job that succeeded and comes back
 * `failed`, so ranking on recency alone would report a failure on a
 * request that was in fact applied. That is the single worst thing this
 * surface can say — the manager's correct response to it is to go redo
 * work that's already done.
 *
 * Within one rank, newest wins; an unresolved `created_at` counts as
 * newest, since it belongs to a job this device just wrote.
 */
export function pickRemoteApplyJob(
  jobs: readonly RemoteApplyJobWithId[],
): RemoteApplyJobWithId | undefined {
  let best: RemoteApplyJobWithId | undefined;
  for (const job of jobs) {
    if (!best || outranks(job, best)) best = job;
  }
  return best;
}

function outranks(job: RemoteApplyJobWithId, incumbent: RemoteApplyJobWithId): boolean {
  const byStatus = statusRank(job.status) - statusRank(incumbent.status);
  if (byStatus !== 0) return byStatus > 0;
  return createdAtRank(job) > createdAtRank(incumbent);
}

/**
 * How much a status settles the question. `applied` and `partial` both
 * mean the Kindoo write happened, so neither may ever be displaced by a
 * sibling that failed; `applied` outranks `partial` because a later
 * `applied` means the request did get closed out after all. `running`
 * outranks `queued` — of two live jobs, the claimed one is the one doing
 * the work.
 */
function statusRank(status: RemoteApplyJob['status']): number {
  switch (status) {
    case 'applied':
      return 5;
    case 'partial':
      return 4;
    case 'running':
      return 3;
    case 'queued':
      return 2;
    case 'failed':
    case 'cancelled':
      return 1;
  }
}

function createdAtRank(job: RemoteApplyJobWithId): number {
  return toMillis(job.created_at) ?? Number.POSITIVE_INFINITY;
}

/**
 * Queue one apply for the desktop. Resolves to the new job id, which
 * the card holds so it keeps rendering the outcome once the job goes
 * terminal — see {@link useRemoteApplyJobsByRequest} for how a request
 * with several jobs resolves to the one shown.
 *
 * Creates at `queued` and nothing else — rules reject any other status
 * on create, and every later transition except `cancelled` belongs to
 * the extension.
 */
export function useQueueRemoteApplyJob() {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  // No cache invalidation on success: the job lands in the live jobs
  // subscription from the local cache on the next tick, and the card
  // subscribes to the new doc directly.
  return useMutation({
    mutationFn: async (requestId: string): Promise<string> => {
      if (!principal.canonical) throw new Error('Not signed in.');
      if (!activeStakeId) throw new Error('No active stake.');
      const created = await addDoc(remoteApplyJobsCol(db, principal.canonical), {
        request_id: requestId,
        stake_id: activeStakeId,
        status: 'queued',
        created_at: serverTimestamp(),
        created_by_device: getDeviceId(),
        lastActor: actorOf(principal),
      } as unknown as RemoteApplyJob);
      return created.id;
    },
  });
}

/**
 * Give up on a job the desktop never claimed. `queued → cancelled` is
 * the only transition rules permit from the phone.
 *
 * This write races the extension's claim, and rules settle it: if the
 * desktop moved the job to `running` a moment before the timer fired,
 * the write comes back `permission-denied` (the before-status no longer
 * matches). That denial means "the desktop picked it up after all" — the
 * live snapshot is already showing `running` — so it's swallowed rather
 * than surfaced.
 */
export function useCancelRemoteApplyJob() {
  const principal = usePrincipal();
  return useMutation({
    mutationFn: async (jobId: string): Promise<void> => {
      if (!principal.canonical) throw new Error('Not signed in.');
      try {
        await updateDoc(remoteApplyJobRef(db, principal.canonical, jobId), {
          status: 'cancelled',
          finished_at: serverTimestamp(),
          lastActor: actorOf(principal),
        });
      } catch (err) {
        if ((err as { code?: string } | null)?.code === 'permission-denied') return;
        throw err;
      }
    },
  });
}

/**
 * Cancel a job that sat in `queued` past
 * `REMOTE_APPLY_PICKUP_TIMEOUT_MS`. The desktop polls; if it hasn't
 * claimed by now it isn't going to (asleep, Kindoo tab closed between
 * the heartbeat and the tap), and leaving the row spinning forever is
 * worse than saying so.
 *
 * `queuedAtFallbackMs` covers the window where `created_at` is still an
 * unresolved `serverTimestamp()` in the local snapshot.
 */
export function useRemoteApplyPickupTimeout(
  jobId: string | null,
  job: RemoteApplyJob | undefined,
  queuedAtFallbackMs: number | null,
): void {
  const cancel = useCancelRemoteApplyJob();
  // The mutation object is fresh each render; read it through a ref so
  // the timer effect doesn't reset on every parent render.
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  const status = job?.status;
  const createdAtMs = toMillis(job?.created_at) ?? queuedAtFallbackMs;

  useEffect(() => {
    if (!jobId || status !== 'queued' || createdAtMs === null) return;
    const delay = Math.max(0, createdAtMs + REMOTE_APPLY_PICKUP_TIMEOUT_MS - Date.now());
    const timer = window.setTimeout(() => {
      cancelRef.current.mutate(jobId);
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [jobId, status, createdAtMs]);
}

/** Millisecond reading of a Firestore timestamp that may not have resolved yet. */
export function toMillis(ts: TimestampLike | undefined | null): number | null {
  if (!ts || typeof ts.toMillis !== 'function') return null;
  try {
    return ts.toMillis();
  } catch {
    return null;
  }
}

/**
 * `Date.now()` that re-renders every `periodMs`. Used where a value
 * goes stale with the clock rather than with a snapshot.
 */
function useNowTick(periodMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), periodMs);
    return () => {
      window.clearInterval(id);
    };
  }, [periodMs]);
  return now;
}

function actorOf(principal: Principal): { email: string; canonical: string } {
  return {
    email: principal.email ?? '',
    canonical: principal.canonical ?? canonicalEmail(principal.email ?? ''),
  };
}
