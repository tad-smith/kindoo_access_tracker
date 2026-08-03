// Hook tests for remote apply (D27). Firestore is fully mocked — these
// are unit-scope tests of the gating logic and the two writes the phone
// is allowed to make, not integration tests against the emulator.
//
// Coverage:
//   - `useRemoteApplyPresence` across the four gating states, plus the
//     wrong-stake case and — the one that can't be covered by a
//     snapshot — a desktop that goes stale purely with the passage of
//     time, producing no new snapshot at all.
//   - `useRemoteApplyJobsByRequest` / `pickRemoteApplyJob` reduce a
//     request's jobs to the one the card speaks with — the half of the
//     duplicate defence that decides what a manager reads when a
//     request ends up with two jobs anyway.
//   - `useQueueRemoteApplyJob` writes exactly the six fields rules
//     allow, at `queued`.
//   - `useCancelRemoteApplyJob` writes `cancelled`, and swallows the
//     permission-denied that means the desktop claimed the job first.
//   - `useRemoteApplyPickupTimeout` cancels a job the desktop never
//     picked up, and leaves a running job alone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  REMOTE_APPLY_HOME_SITE_KEY,
  REMOTE_APPLY_PICKUP_TIMEOUT_MS,
  REMOTE_APPLY_STALE_MS,
  type RemoteApplyDesktopWithId,
  type RemoteApplyJob,
  type RemoteApplyPresence,
  type TimestampLike,
} from '@kindoo/shared';

const addDocMock = vi.fn();
const updateDocMock = vi.fn();
const serverTimestampSentinel = { __serverTimestamp: true };

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore');
  return {
    ...actual,
    addDoc: (...args: unknown[]) => addDocMock(...args),
    updateDoc: (...args: unknown[]) => updateDocMock(...args),
    serverTimestamp: () => serverTimestampSentinel,
  };
});

const usePrincipalMock = vi.fn();
vi.mock('../../../lib/principal', () => ({
  usePrincipal: () => usePrincipalMock(),
}));

const useActiveStakeMock = vi.fn();
vi.mock('../../../lib/useActiveStake', () => ({
  useActiveStake: () => useActiveStakeMock(),
}));

const useFirestoreDocMock = vi.fn();
const useFirestoreCollectionMock = vi.fn();
vi.mock('../../../lib/data', () => ({
  useFirestoreDoc: (...args: unknown[]) => useFirestoreDocMock(...args),
  useFirestoreCollection: (...args: unknown[]) => useFirestoreCollectionMock(...args),
}));

vi.mock('../../../lib/firebase', () => ({
  db: { __db: true },
}));

vi.mock('../../../lib/docs', () => ({
  remoteApplyRef: (db: unknown, canonical: string) => ({ __ref: 'remoteApply', canonical, db }),
  remoteApplyDesktopsCol: (db: unknown, canonical: string) => ({
    __col: 'desktops',
    canonical,
    db,
  }),
  remoteApplyJobsCol: (db: unknown, canonical: string) => ({ __col: 'jobs', canonical, db }),
  remoteApplyJobRef: (db: unknown, canonical: string, jobId: string) => ({
    __ref: 'job',
    canonical,
    jobId,
    db,
  }),
  requestsCol: (db: unknown, stakeId: string) => ({ __col: 'requests', stakeId, db }),
  kindooSitesCol: (db: unknown, stakeId: string) => ({ __col: 'kindooSites', stakeId, db }),
  wardsCol: (db: unknown, stakeId: string) => ({ __col: 'wards', stakeId, db }),
  buildingsCol: (db: unknown, stakeId: string) => ({ __col: 'buildings', stakeId, db }),
  stakeRef: (db: unknown, stakeId: string) => ({ __ref: 'stake', stakeId, db }),
}));

import {
  pickRemoteApplyJob,
  useCancelRemoteApplyJob,
  useQueueRemoteApplyJob,
  useRemoteApplyJobsByRequest,
  useRemoteApplyPickupTimeout,
  useRemoteApplyPresence,
  type RemoteApplyJobWithId,
} from './hooks';

const T0 = new Date('2026-08-03T18:00:00.000Z').getTime();

function ts(atMs: number): TimestampLike {
  return {
    seconds: Math.floor(atMs / 1000),
    nanoseconds: 0,
    toDate: () => new Date(atMs),
    toMillis: () => atMs,
  };
}

/** The mailbox parent: the profile-wide opt-in, and nothing else. */
function presenceDoc(overrides: Partial<RemoteApplyPresence> = {}): RemoteApplyPresence {
  return {
    remote_apply_enabled: true,
    ext_version: '2.5.0',
    lastActor: { email: 'Mgr@gmail.com', canonical: 'mgr@gmail.com' },
    ...overrides,
  };
}

/** One live Kindoo tab, on one site. Doc id is the site key. */
function desktopDoc(
  siteKey: string,
  overrides: Partial<RemoteApplyDesktopWithId> = {},
): RemoteApplyDesktopWithId {
  return {
    site_key: siteKey,
    stake_id: 'csnorth',
    kindoo_site_id: siteKey === REMOTE_APPLY_HOME_SITE_KEY ? null : siteKey,
    last_seen_at: ts(T0),
    kindoo_eid: 4242,
    kindoo_site_name: siteKey === REMOTE_APPLY_HOME_SITE_KEY ? 'Colorado Springs North' : siteKey,
    ext_version: '2.5.0',
    lastActor: { email: 'Mgr@gmail.com', canonical: 'mgr@gmail.com' },
    ...overrides,
  };
}

function docResult(data: unknown, isLoading = false) {
  return {
    data,
    error: null,
    status: isLoading ? 'pending' : 'success',
    isPending: isLoading,
    isLoading,
    isSuccess: !isLoading,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: {} } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  localStorage.clear();
  usePrincipalMock.mockReturnValue({ email: 'Mgr@gmail.com', canonical: 'mgr@gmail.com' });
  useActiveStakeMock.mockReturnValue('csnorth');
  useFirestoreDocMock.mockReturnValue(docResult(undefined));
  useFirestoreCollectionMock.mockReturnValue(docResult([]));
  addDocMock.mockResolvedValue({ id: 'job-1' });
  updateDocMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRemoteApplyPresence', () => {
  it('reports live, and lists a fresh tab per Kindoo site', () => {
    useFirestoreDocMock.mockReturnValue(docResult(presenceDoc()));
    useFirestoreCollectionMock.mockReturnValue(
      docResult([desktopDoc(REMOTE_APPLY_HOME_SITE_KEY), desktopDoc('east')]),
    );
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.state).toBe('live');
    expect(result.current.desktops.map((d) => d.site_key)).toEqual(['home', 'east']);
  });

  it('reads the desktops subcollection, keyed by site so two tabs coexist', () => {
    renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    const [q, options] = useFirestoreCollectionMock.mock.calls[0] as [unknown, unknown];
    expect(q).toEqual({ __col: 'desktops', canonical: 'mgr@gmail.com', db: { __db: true } });
    expect(options).toEqual({ idField: 'site_key' });
  });

  it('serves a request only from the tab that is on its site', () => {
    // The whole point of the split: a tab on the home site cannot
    // provision for a foreign site, however alive it is.
    useFirestoreDocMock.mockReturnValue(docResult(presenceDoc()));
    useFirestoreCollectionMock.mockReturnValue(docResult([desktopDoc(REMOTE_APPLY_HOME_SITE_KEY)]));
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.desktopForSite(REMOTE_APPLY_HOME_SITE_KEY)?.site_key).toBe('home');
    expect(result.current.desktopForSite('east')).toBeNull();
  });

  it('offers no desktop for a request whose target site could not be resolved', () => {
    useFirestoreDocMock.mockReturnValue(docResult(presenceDoc()));
    useFirestoreCollectionMock.mockReturnValue(docResult([desktopDoc(REMOTE_APPLY_HOME_SITE_KEY)]));
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.desktopForSite(null)).toBeNull();
  });

  it('reports stale when every tab heartbeat has aged past the staleness window', () => {
    useFirestoreDocMock.mockReturnValue(docResult(presenceDoc()));
    useFirestoreCollectionMock.mockReturnValue(
      docResult([
        desktopDoc(REMOTE_APPLY_HOME_SITE_KEY, {
          last_seen_at: ts(T0 - REMOTE_APPLY_STALE_MS - 1000),
        }),
      ]),
    );
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.state).toBe('stale');
    expect(result.current.desktops).toEqual([]);
  });

  it('reports stale when the manager opted in but never had a Kindoo tab open', () => {
    useFirestoreDocMock.mockReturnValue(docResult(presenceDoc()));
    useFirestoreCollectionMock.mockReturnValue(docResult([]));
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.state).toBe('stale');
  });

  it('reports off when the extension opt-in has not been turned on', () => {
    useFirestoreDocMock.mockReturnValue(docResult(presenceDoc({ remote_apply_enabled: false })));
    useFirestoreCollectionMock.mockReturnValue(docResult([desktopDoc(REMOTE_APPLY_HOME_SITE_KEY)]));
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.state).toBe('off');
    // A live tab without consent must not leak into the gate either.
    expect(result.current.desktops).toEqual([]);
  });

  it('reports off when the manager has no opt-in doc at all', () => {
    useFirestoreDocMock.mockReturnValue(docResult(undefined));
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.state).toBe('off');
  });

  it('reports other-stake when every fresh tab is sitting in a different stake', () => {
    useFirestoreDocMock.mockReturnValue(docResult(presenceDoc()));
    useFirestoreCollectionMock.mockReturnValue(
      docResult([desktopDoc(REMOTE_APPLY_HOME_SITE_KEY, { stake_id: 'otherstake' })]),
    );
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.state).toBe('other-stake');
    expect(result.current.desktops).toEqual([]);
  });

  it('renders nothing-yet (loading) until both subscriptions resolve', () => {
    useFirestoreDocMock.mockReturnValue(docResult(undefined, true));
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.state).toBe('loading');

    useFirestoreDocMock.mockReturnValue(docResult(presenceDoc()));
    useFirestoreCollectionMock.mockReturnValue(docResult(undefined, true));
    const second = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(second.result.current.state).toBe('loading');
  });

  it('goes stale on the clock alone, with no new snapshot to trigger it', () => {
    // A desktop that closes its Kindoo tab stops writing. There is no
    // further snapshot, so the badge has to age itself out.
    useFirestoreDocMock.mockReturnValue(docResult(presenceDoc()));
    useFirestoreCollectionMock.mockReturnValue(docResult([desktopDoc(REMOTE_APPLY_HOME_SITE_KEY)]));
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.state).toBe('live');

    act(() => {
      vi.advanceTimersByTime(REMOTE_APPLY_STALE_MS + 30_000);
    });

    expect(result.current.state).toBe('stale');
    expect(result.current.desktopForSite(REMOTE_APPLY_HOME_SITE_KEY)).toBeNull();
  });

  it('drops only the tab that went quiet, keeping its live sibling', () => {
    useFirestoreDocMock.mockReturnValue(docResult(presenceDoc()));
    useFirestoreCollectionMock.mockReturnValue(
      docResult([
        desktopDoc(REMOTE_APPLY_HOME_SITE_KEY, {
          last_seen_at: ts(T0 - REMOTE_APPLY_STALE_MS - 1000),
        }),
        desktopDoc('east'),
      ]),
    );
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.state).toBe('live');
    expect(result.current.desktops.map((d) => d.site_key)).toEqual(['east']);
    expect(result.current.desktopForSite(REMOTE_APPLY_HOME_SITE_KEY)).toBeNull();
  });
});

describe('pickRemoteApplyJob', () => {
  function jobDoc(
    jobId: string,
    status: RemoteApplyJob['status'],
    createdAtMs: number | null = T0,
  ): RemoteApplyJobWithId {
    return {
      job_id: jobId,
      request_id: 'req-7',
      stake_id: 'csnorth',
      target_site_key: REMOTE_APPLY_HOME_SITE_KEY,
      status,
      created_at: (createdAtMs === null ? null : ts(createdAtMs)) as TimestampLike,
      created_by_device: 'device-1',
      lastActor: { email: 'Mgr@gmail.com', canonical: 'mgr@gmail.com' },
    };
  }

  it('keeps the applied job when a later duplicate came back failed', () => {
    // The duplicate's loser is always claimed second and always fails
    // with `request_not_pending`. Reporting that as the request's
    // outcome tells a manager to redo a provision that already landed.
    const best = pickRemoteApplyJob([
      jobDoc('job-a', 'applied', T0),
      jobDoc('job-b', 'failed', T0 + 30_000),
    ]);
    expect(best?.job_id).toBe('job-a');
  });

  it('keeps a partial job over a later failed duplicate', () => {
    const best = pickRemoteApplyJob([
      jobDoc('job-a', 'partial', T0),
      jobDoc('job-b', 'failed', T0 + 30_000),
    ]);
    expect(best?.job_id).toBe('job-a');
  });

  it('prefers the job the desktop actually claimed over one still queued', () => {
    const best = pickRemoteApplyJob([
      jobDoc('job-a', 'running', T0),
      jobDoc('job-b', 'queued', T0 + 30_000),
    ]);
    expect(best?.job_id).toBe('job-a');
  });

  it('prefers a fresh attempt over the failure it is retrying', () => {
    const best = pickRemoteApplyJob([
      jobDoc('job-a', 'failed', T0),
      jobDoc('job-b', 'queued', T0 + 30_000),
    ]);
    expect(best?.job_id).toBe('job-b');
  });

  it('takes the newest of two jobs that say the same thing', () => {
    const best = pickRemoteApplyJob([
      jobDoc('job-a', 'cancelled', T0),
      jobDoc('job-b', 'failed', T0 + 30_000),
    ]);
    expect(best?.job_id).toBe('job-b');
  });

  it('treats a job whose created_at has not resolved yet as the newest', () => {
    // A `serverTimestamp()` reads as null in the writing device's own
    // first snapshot — that job is the one just tapped.
    const best = pickRemoteApplyJob([
      jobDoc('job-a', 'queued', T0),
      jobDoc('job-b', 'queued', null),
    ]);
    expect(best?.job_id).toBe('job-b');
  });

  it('has nothing to say about a request with no jobs', () => {
    expect(pickRemoteApplyJob([])).toBeUndefined();
  });
});

describe('useRemoteApplyJobsByRequest', () => {
  function jobDoc(
    jobId: string,
    requestId: string,
    status: RemoteApplyJob['status'],
    createdAtMs = T0,
  ): RemoteApplyJobWithId {
    return {
      job_id: jobId,
      request_id: requestId,
      stake_id: 'csnorth',
      target_site_key: REMOTE_APPLY_HOME_SITE_KEY,
      status,
      created_at: ts(createdAtMs),
      created_by_device: 'device-1',
      lastActor: { email: 'Mgr@gmail.com', canonical: 'mgr@gmail.com' },
    };
  }

  it('reads the whole mailbox, so a terminal job is still there to be read', () => {
    // A status filter would drop the `applied` job and leave the card
    // holding its failed duplicate.
    renderHook(() => useRemoteApplyJobsByRequest(), { wrapper: Wrapper });
    const [q] = useFirestoreCollectionMock.mock.calls[0] as [unknown];
    expect(q).toEqual({ __col: 'jobs', canonical: 'mgr@gmail.com', db: { __db: true } });
  });

  it('renders a request that applied as applied, not as its failed duplicate', () => {
    useFirestoreCollectionMock.mockReturnValue(
      docResult([
        jobDoc('job-a', 'req-7', 'applied', T0),
        jobDoc('job-b', 'req-7', 'failed', T0 + 30_000),
      ]),
    );
    const { result } = renderHook(() => useRemoteApplyJobsByRequest(), { wrapper: Wrapper });
    expect(result.current.byRequest.get('req-7')?.status).toBe('applied');
  });

  it('keeps each request on its own job', () => {
    useFirestoreCollectionMock.mockReturnValue(
      docResult([jobDoc('job-a', 'req-7', 'running'), jobDoc('job-b', 'req-8', 'queued')]),
    );
    const { result } = renderHook(() => useRemoteApplyJobsByRequest(), { wrapper: Wrapper });
    expect(result.current.byRequest.get('req-7')?.job_id).toBe('job-a');
    expect(result.current.byRequest.get('req-8')?.job_id).toBe('job-b');
  });

  it('reports itself unresolved so the card withholds the button', () => {
    useFirestoreCollectionMock.mockReturnValue(docResult(undefined, true));
    const { result } = renderHook(() => useRemoteApplyJobsByRequest(), { wrapper: Wrapper });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.byRequest.size).toBe(0);
  });
});

describe('useQueueRemoteApplyJob', () => {
  it('creates the job at queued with only the fields the rules allow', async () => {
    const { result } = renderHook(() => useQueueRemoteApplyJob(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        requestId: 'req-7',
        targetSiteKey: REMOTE_APPLY_HOME_SITE_KEY,
      });
    });

    expect(addDocMock).toHaveBeenCalledTimes(1);
    const [col, body] = addDocMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(col).toMatchObject({ __col: 'jobs', canonical: 'mgr@gmail.com' });
    expect(Object.keys(body).sort()).toEqual([
      'created_at',
      'created_by_device',
      'lastActor',
      'request_id',
      'stake_id',
      'status',
      'target_site_key',
    ]);
    expect(body.status).toBe('queued');
    expect(body.request_id).toBe('req-7');
    expect(body.stake_id).toBe('csnorth');
    expect(body.created_at).toBe(serverTimestampSentinel);
    expect(body.created_by_device).toEqual(expect.any(String));
    expect(body.lastActor).toEqual({ email: 'Mgr@gmail.com', canonical: 'mgr@gmail.com' });
  });

  it('stamps the job with the Kindoo site it must be applied on', async () => {
    // Only a tab inside this site may claim it — that is what stops the
    // stake's other Kindoo tab taking work it cannot perform.
    const { result } = renderHook(() => useQueueRemoteApplyJob(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ requestId: 'req-7', targetSiteKey: 'east' });
    });
    const [, body] = addDocMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(body.target_site_key).toBe('east');
  });

  it('stamps the home key on a request that provisions on the home site', async () => {
    // Home is a site like any other here: a home job must not be
    // claimable by a tab parked on a foreign site.
    const { result } = renderHook(() => useQueueRemoteApplyJob(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        requestId: 'req-7',
        targetSiteKey: REMOTE_APPLY_HOME_SITE_KEY,
      });
    });
    const [, body] = addDocMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(body.target_site_key).toBe('home');
  });

  it('resolves to the new job id so the card can follow it', async () => {
    const { result } = renderHook(() => useQueueRemoteApplyJob(), { wrapper: Wrapper });
    let jobId = '';
    await act(async () => {
      jobId = await result.current.mutateAsync({
        requestId: 'req-7',
        targetSiteKey: REMOTE_APPLY_HOME_SITE_KEY,
      });
    });
    expect(jobId).toBe('job-1');
  });
});

describe('useCancelRemoteApplyJob', () => {
  it('moves the job to cancelled and stamps a finish time', async () => {
    const { result } = renderHook(() => useCancelRemoteApplyJob(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync('job-9');
    });
    const [ref, body] = updateDocMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(ref).toMatchObject({ __ref: 'job', jobId: 'job-9', canonical: 'mgr@gmail.com' });
    expect(body).toEqual({
      status: 'cancelled',
      finished_at: serverTimestampSentinel,
      lastActor: { email: 'Mgr@gmail.com', canonical: 'mgr@gmail.com' },
    });
  });

  it('treats a permission-denied cancel as the desktop having claimed the job first', async () => {
    updateDocMock.mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'permission-denied' }),
    );
    const { result } = renderHook(() => useCancelRemoteApplyJob(), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync('job-9')).resolves.toBeUndefined();
    });
  });
});

describe('useRemoteApplyPickupTimeout', () => {
  function queuedJob(overrides: Partial<RemoteApplyJob> = {}): RemoteApplyJob {
    return {
      request_id: 'req-7',
      stake_id: 'csnorth',
      target_site_key: REMOTE_APPLY_HOME_SITE_KEY,
      status: 'queued',
      created_at: ts(T0),
      created_by_device: 'device-1',
      lastActor: { email: 'Mgr@gmail.com', canonical: 'mgr@gmail.com' },
      ...overrides,
    };
  }

  it('cancels a job the desktop never picked up', async () => {
    renderHook(() => useRemoteApplyPickupTimeout('job-9', queuedJob(), null), {
      wrapper: Wrapper,
    });
    expect(updateDocMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(REMOTE_APPLY_PICKUP_TIMEOUT_MS + 1000);
    });

    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const [, body] = updateDocMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(body.status).toBe('cancelled');
  });

  it('counts from the tap when created_at has not come back from the server yet', async () => {
    // The first local snapshot of a `serverTimestamp()` write carries
    // null, so the timer falls back to the locally-recorded tap time.
    renderHook(
      () =>
        useRemoteApplyPickupTimeout(
          'job-9',
          queuedJob({ created_at: null as unknown as TimestampLike }),
          T0,
        ),
      { wrapper: Wrapper },
    );
    await act(async () => {
      vi.advanceTimersByTime(REMOTE_APPLY_PICKUP_TIMEOUT_MS + 1000);
    });
    expect(updateDocMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a job the desktop has already claimed alone', async () => {
    renderHook(() => useRemoteApplyPickupTimeout('job-9', queuedJob({ status: 'running' }), null), {
      wrapper: Wrapper,
    });
    await act(async () => {
      vi.advanceTimersByTime(REMOTE_APPLY_PICKUP_TIMEOUT_MS * 3);
    });
    expect(updateDocMock).not.toHaveBeenCalled();
  });
});
