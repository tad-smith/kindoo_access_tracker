// Unit tests for the callable wrappers. Mocks `firebase/functions` at
// the module boundary so we can assert the callable name, payload
// shape, and result-passthrough behaviour without touching the
// emulator.

import { afterEach, describe, expect, it, vi } from 'vitest';

const callableFn = vi.fn();
const httpsCallableMock = vi.fn(() => callableFn);

vi.mock('firebase/functions', () => ({
  httpsCallable: httpsCallableMock,
}));

vi.mock('./firebase', () => ({
  functions: () => ({ __tag: 'mock-functions' }),
}));

describe('api wrappers', () => {
  afterEach(() => {
    callableFn.mockReset();
    httpsCallableMock.mockClear();
  });

  it('getMyPendingRequests calls the named callable with the stakeId payload', async () => {
    callableFn.mockResolvedValue({ data: { requests: [] } });
    const { getMyPendingRequests } = await import('./api');

    const result = await getMyPendingRequests({ stakeId: 'csnorth' });

    expect(httpsCallableMock).toHaveBeenCalledWith(
      { __tag: 'mock-functions' },
      'getMyPendingRequests',
    );
    expect(callableFn).toHaveBeenCalledWith({ stakeId: 'csnorth' });
    expect(result).toEqual({ requests: [] });
  });

  it('getMyPendingRequests returns the unwrapped request list', async () => {
    const fakeRequest = {
      request_id: 'r1',
      type: 'add_manual',
      scope: 'CO',
      member_email: 'a@b.com',
      member_canonical: 'a@b.com',
      member_name: 'A',
      reason: 'EQ',
      comment: '',
      building_names: [],
      status: 'pending',
      requester_email: 'r@b.com',
      requester_canonical: 'r@b.com',
      requested_at: { seconds: 1, nanoseconds: 0 },
      lastActor: { email: 'r@b.com', canonical: 'r@b.com' },
    };
    callableFn.mockResolvedValue({ data: { requests: [fakeRequest] } });
    const { getMyPendingRequests } = await import('./api');

    const result = await getMyPendingRequests({ stakeId: 'csnorth' });

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]?.request_id).toBe('r1');
  });

  it('markRequestComplete calls the named callable with the full payload', async () => {
    callableFn.mockResolvedValue({ data: { ok: true } });
    const { markRequestComplete } = await import('./api');

    await markRequestComplete({
      stakeId: 'csnorth',
      requestId: 'r1',
      completionNote: 'done',
    });

    expect(httpsCallableMock).toHaveBeenCalledWith(
      { __tag: 'mock-functions' },
      'markRequestComplete',
    );
    expect(callableFn).toHaveBeenCalledWith({
      stakeId: 'csnorth',
      requestId: 'r1',
      completionNote: 'done',
    });
  });

  it('markRequestComplete propagates callable rejections', async () => {
    const httpsError = Object.assign(new Error('not a manager'), { code: 'permission-denied' });
    callableFn.mockRejectedValue(httpsError);
    const { markRequestComplete } = await import('./api');

    await expect(markRequestComplete({ stakeId: 'csnorth', requestId: 'r1' })).rejects.toBe(
      httpsError,
    );
  });
});
