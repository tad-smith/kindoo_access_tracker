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
// Liveness is **per Kindoo site**, not per manager: a stake can run
// more than one Kindoo site and a tab can only provision for the site
// it is inside. So the opt-in lives on the mailbox parent and one
// `desktops/{siteKey}` doc exists per live tab, and whether a request
// can be applied is a question about *that request's* site.
//
//   - `useRemoteApplyPresence()` — the opt-in plus every live tab, and
//     `desktopForSite()` to ask about one request's target site key.
//   - `useRemoteApplyJobsByRequest()` — the mailbox's jobs, reduced to
//     the one job per request a card should render, so a reload doesn't
//     lose track of an in-flight apply.
//   - `useQueueRemoteApplyJob()` / `useCancelRemoteApplyJob()` — the two
//     writes.
//   - `useRemoteApplyPickupTimeout()` — cancels a job the desktop never
//     claimed.
//   - `useKindooSites()` / `useQueueWards()` / `useQueueBuildings()` /
//     `useQueueStakeDoc()` — the catalogues a request's target site is
//     derived and named from.

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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  REMOTE_APPLY_PICKUP_TIMEOUT_MS,
  canonicalEmail,
  freshRemoteApplyDesktops,
  isRemoteApplyEnabled,
  remoteApplyDesktopForRequest,
  type AccessRequest,
  type Building,
  type KindooSite,
  type RemoteApplyDesktopWithId,
  type RemoteApplyJob,
  type RemoteApplyPresence,
  type Stake,
  type TimestampLike,
  type Ward,
} from '@kindoo/shared';
import { useFirestoreCollection, useFirestoreDoc } from '../../../lib/data';
import { db } from '../../../lib/firebase';
import {
  buildingsCol,
  kindooSitesCol,
  remoteApplyDesktopsCol,
  remoteApplyJobRef,
  remoteApplyJobsCol,
  remoteApplyRef,
  requestsCol,
  stakeRef,
  wardsCol,
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

// A request's target Kindoo site is derived — scope → ward → building →
// site — so remote apply needs the three catalogues that derivation and
// its labelling walk through. All small (12 wards, a handful of
// buildings, 0–2 foreign sites) and already live elsewhere in the app.

/** The stake's foreign Kindoo sites, for naming a site key. */
export function useKindooSites() {
  const activeStakeId = useActiveStake();
  const col = useMemo(
    () => (activeStakeId ? kindooSitesCol(db, activeStakeId) : null),
    [activeStakeId],
  );
  return useFirestoreCollection<KindooSite>(col);
}

/** Wards, for resolving a ward-scope request to its building. */
export function useQueueWards() {
  const activeStakeId = useActiveStake();
  const col = useMemo(() => (activeStakeId ? wardsCol(db, activeStakeId) : null), [activeStakeId]);
  return useFirestoreCollection<Ward>(col);
}

/** Buildings, which carry the `kindoo_site_id` the target key comes from. */
export function useQueueBuildings() {
  const activeStakeId = useActiveStake();
  const col = useMemo(
    () => (activeStakeId ? buildingsCol(db, activeStakeId) : null),
    [activeStakeId],
  );
  return useFirestoreCollection<Building>(col);
}

/** The stake parent doc — the only place the home site has a name. */
export function useQueueStakeDoc() {
  const activeStakeId = useActiveStake();
  const ref = useMemo(() => (activeStakeId ? stakeRef(db, activeStakeId) : null), [activeStakeId]);
  return useFirestoreDoc<Stake>(ref);
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
 * What the manager's desktop can do for this stake right now.
 *   `loading`     — a subscription hasn't resolved yet; render nothing.
 *   `live`        — opted in, with at least one fresh tab in this stake.
 *                   WHICH requests can be applied is still per-site — ask
 *                   {@link RemoteApplyPresenceResult.desktopForSite}.
 *   `stale`       — opted in, but no tab anywhere is heartbeating (Kindoo
 *                   tab closed, computer asleep, signed out of Kindoo).
 *   `other-stake` — tabs are alive, all of them in another stake, so none
 *                   can apply what's on this screen.
 *   `off`         — no opt-in doc, or the extension toggle is off. Also the
 *                   fallback when the read errors, since the advice ("turn it
 *                   on over there") is the same.
 */
export type RemoteApplyPresenceState = 'loading' | 'live' | 'stale' | 'other-stake' | 'off';

export interface RemoteApplyPresenceResult {
  state: RemoteApplyPresenceState;
  /**
   * Every fresh tab in the active stake, one per Kindoo site. This is
   * what the queue header describes — with two sites live it names
   * both, because naming one would be a lie about the other.
   */
  desktops: RemoteApplyDesktopWithId[];
  /**
   * The tab that can run a request whose target site key is
   * `targetSiteKey`, or `null` when none can. A `null` key — the caller
   * couldn't derive the request's site — never matches, which is the
   * fail-closed behaviour: an unknown target can't be routed anywhere.
   */
  desktopForSite: (targetSiteKey: string | null) => RemoteApplyDesktopWithId | null;
  presence: RemoteApplyPresence | undefined;
}

/**
 * Live remote-apply presence for the signed-in manager: the profile-wide
 * opt-in on the mailbox parent, plus one `desktops/{siteKey}` doc per
 * Kindoo site they have a live tab on.
 *
 * Two subscriptions because the two facts have different lifetimes — the
 * opt-in survives every tab closing, and a tab's liveness is scoped to
 * the site it is inside. Freshness comes from the shared predicates
 * against a clock that ticks every {@link PRESENCE_RECHECK_MS}: a closed
 * tab simply stops writing, which produces no snapshot to react to, so
 * the page has to age it out itself.
 */
export function useRemoteApplyPresence(): RemoteApplyPresenceResult {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const ref = useMemo(
    () => (principal.canonical ? remoteApplyRef(db, principal.canonical) : null),
    [principal.canonical],
  );
  const desktopsQuery = useMemo(
    () =>
      principal.canonical
        ? (remoteApplyDesktopsCol(
            db,
            principal.canonical,
          ) as unknown as Query<RemoteApplyDesktopWithId>)
        : null,
    [principal.canonical],
  );
  const presenceDoc = useFirestoreDoc<RemoteApplyPresence>(ref);
  const desktopsCol = useFirestoreCollection<RemoteApplyDesktopWithId>(desktopsQuery, {
    idField: 'site_key',
  });
  const now = useNowTick(PRESENCE_RECHECK_MS);

  const presence = presenceDoc.data;
  const allDesktops = desktopsCol.data;

  const desktops = useMemo(
    () => freshRemoteApplyDesktops(presence, allDesktops, activeStakeId ?? '', now),
    [presence, allDesktops, activeStakeId, now],
  );

  // Tabs alive somewhere else. Told apart from "no tab at all" because
  // the advice differs: a manager whose desktop is heartbeating fine
  // should switch stakes in Kindoo, not go hunting for a dead tab.
  // Evaluated by re-running the same freshness predicate per stake, so
  // the staleness window stays defined in exactly one place.
  const liveElsewhere = useMemo(() => {
    const stakes = new Set((allDesktops ?? []).map((d) => d.stake_id));
    stakes.delete(activeStakeId ?? '');
    return [...stakes].some(
      (stakeId) => freshRemoteApplyDesktops(presence, allDesktops, stakeId, now).length > 0,
    );
  }, [presence, allDesktops, activeStakeId, now]);

  const state: RemoteApplyPresenceState = (() => {
    if (!ref) return 'off';
    if (presenceDoc.isLoading || desktopsCol.isLoading) return 'loading';
    if (!isRemoteApplyEnabled(presence)) return 'off';
    if (!activeStakeId) return 'off';
    if (desktops.length > 0) return 'live';
    return liveElsewhere ? 'other-stake' : 'stale';
  })();

  const desktopForSite = useCallback(
    (targetSiteKey: string | null) =>
      targetSiteKey === null
        ? null
        : remoteApplyDesktopForRequest(
            presence,
            allDesktops,
            activeStakeId ?? '',
            targetSiteKey,
            now,
          ),
    [presence, allDesktops, activeStakeId, now],
  );

  return { state, desktops, desktopForSite, presence };
}

/** A `RemoteApplyJob` body plus its Firestore doc id (read-layer only). */
export type RemoteApplyJobWithId = RemoteApplyJob & { job_id: string };

export interface RemoteApplyJobsResult {
  /** The job each request's card should render, by `request_id`. */
  byRequest: Map<string, RemoteApplyJobWithId>;
  /**
   * The same jobs as a list — one per request, already reduced by
   * {@link pickRemoteApplyJob}. This is what the page-level result
   * dialog selects an outcome across, and it deliberately spans the
   * whole mailbox rather than the pending list: a successful apply ends
   * by marking its request complete, so by the time there is an outcome
   * to announce the request is gone. Selecting over the reduced set
   * rather than the raw jobs also inherits the duplicate rule — the
   * `failed` orphan of a duplicate never raises a dialog claiming a
   * request failed that in fact applied.
   */
  resolved: readonly RemoteApplyJobWithId[];
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
  const byRequest = useMemo<Map<string, RemoteApplyJobWithId>>(() => {
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
  // Memoised so the result dialog's selection doesn't recompute (and its
  // localStorage reads don't re-run) on every unrelated page render.
  const resolved = useMemo(() => [...byRequest.values()], [byRequest]);
  return { byRequest, resolved, isLoading: jobs.isLoading };
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

export interface QueueRemoteApplyJobInput {
  requestId: string;
  /**
   * The site key this request must be provisioned on, derived by
   * `remoteApplyTargetSiteKey`. Required — only a tab inside this site
   * may claim the job, and a request whose site we couldn't derive
   * never got a button to tap in the first place.
   */
  targetSiteKey: string;
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
    mutationFn: async (input: QueueRemoteApplyJobInput): Promise<string> => {
      if (!principal.canonical) throw new Error('Not signed in.');
      if (!activeStakeId) throw new Error('No active stake.');
      const created = await addDoc(remoteApplyJobsCol(db, principal.canonical), {
        request_id: input.requestId,
        stake_id: activeStakeId,
        target_site_key: input.targetSiteKey,
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
