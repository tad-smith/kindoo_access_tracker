// Hook tests for remote apply (D27). Firestore is fully mocked — these
// are unit-scope tests of the gating logic and the two writes the phone
// is allowed to make, not integration tests against the emulator.
//
// Coverage:
//   - `useRemoteApplyPresence` across the four gating states, plus the
//     wrong-stake case and — the one that can't be covered by a
//     snapshot — a desktop that goes stale purely with the passage of
//     time, producing no new snapshot at all.
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
  REMOTE_APPLY_PICKUP_TIMEOUT_MS,
  REMOTE_APPLY_STALE_MS,
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
  remoteApplyJobsCol: (db: unknown, canonical: string) => ({ __col: 'jobs', canonical, db }),
  remoteApplyJobRef: (db: unknown, canonical: string, jobId: string) => ({
    __ref: 'job',
    canonical,
    jobId,
    db,
  }),
  requestsCol: (db: unknown, stakeId: string) => ({ __col: 'requests', stakeId, db }),
}));

import {
  useCancelRemoteApplyJob,
  useQueueRemoteApplyJob,
  useRemoteApplyPickupTimeout,
  useRemoteApplyPresence,
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

function presenceDoc(overrides: Partial<RemoteApplyPresence> = {}): RemoteApplyPresence {
  return {
    remote_apply_enabled: true,
    last_seen_at: ts(T0),
    stake_id: 'csnorth',
    kindoo_eid: 4242,
    kindoo_site_name: 'Colorado Springs North',
    ext_version: '2.4.0',
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
  it('reports the desktop online, with its Kindoo site name, on a fresh opted-in heartbeat', () => {
    useFirestoreDocMock.mockReturnValue(docResult(presenceDoc()));
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.state).toBe('online');
    expect(result.current.online).toBe(true);
    expect(result.current.siteName).toBe('Colorado Springs North');
  });

  it('reports stale when the heartbeat has aged past the staleness window', () => {
    useFirestoreDocMock.mockReturnValue(
      docResult(presenceDoc({ last_seen_at: ts(T0 - REMOTE_APPLY_STALE_MS - 1000) })),
    );
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.state).toBe('stale');
    expect(result.current.online).toBe(false);
  });

  it('reports off when the extension opt-in has not been turned on', () => {
    useFirestoreDocMock.mockReturnValue(docResult(presenceDoc({ remote_apply_enabled: false })));
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.state).toBe('off');
  });

  it('reports off when the manager has no presence doc at all', () => {
    useFirestoreDocMock.mockReturnValue(docResult(undefined));
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.state).toBe('off');
  });

  it('reports other-stake when a fresh desktop is sitting in a different stake', () => {
    useFirestoreDocMock.mockReturnValue(docResult(presenceDoc({ stake_id: 'otherstake' })));
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.state).toBe('other-stake');
    expect(result.current.online).toBe(false);
  });

  it('renders nothing-yet (loading) until the presence subscription resolves', () => {
    useFirestoreDocMock.mockReturnValue(docResult(undefined, true));
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.state).toBe('loading');
  });

  it('goes stale on the clock alone, with no new snapshot to trigger it', () => {
    // A desktop that closes its Kindoo tab stops writing. There is no
    // further snapshot, so the badge has to age itself out.
    useFirestoreDocMock.mockReturnValue(docResult(presenceDoc()));
    const { result } = renderHook(() => useRemoteApplyPresence(), { wrapper: Wrapper });
    expect(result.current.state).toBe('online');

    act(() => {
      vi.advanceTimersByTime(REMOTE_APPLY_STALE_MS + 30_000);
    });

    expect(result.current.state).toBe('stale');
    expect(result.current.online).toBe(false);
  });
});

describe('useQueueRemoteApplyJob', () => {
  it('creates the job at queued with only the fields the rules allow', async () => {
    const { result } = renderHook(() => useQueueRemoteApplyJob(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync('req-7');
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
    ]);
    expect(body.status).toBe('queued');
    expect(body.request_id).toBe('req-7');
    expect(body.stake_id).toBe('csnorth');
    expect(body.created_at).toBe(serverTimestampSentinel);
    expect(body.created_by_device).toEqual(expect.any(String));
    expect(body.lastActor).toEqual({ email: 'Mgr@gmail.com', canonical: 'mgr@gmail.com' });
  });

  it('resolves to the new job id so the card can follow it', async () => {
    const { result } = renderHook(() => useQueueRemoteApplyJob(), { wrapper: Wrapper });
    let jobId = '';
    await act(async () => {
      jobId = await result.current.mutateAsync('req-7');
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
