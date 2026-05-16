// Unit tests for the SW message dispatcher. The Chrome / Firebase
// boundary is mocked at the module edge so the handler logic can be
// exercised under jsdom without a running browser or Firebase
// project.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signInMock = vi.fn();
const signOutMock = vi.fn();
const currentUserMock = vi.fn();
const waitForAuthHydratedMock = vi.fn(() => Promise.resolve(null));

vi.mock('../lib/auth', async () => {
  const actual = await vi.importActual<typeof import('../lib/auth')>('../lib/auth');
  return {
    ...actual,
    signIn: () => signInMock(),
    signOut: () => signOutMock(),
    currentUser: () => currentUserMock(),
    waitForAuthHydrated: () => waitForAuthHydratedMock(),
  };
});

const getMyPendingRequestsMock = vi.fn();
const markRequestCompleteMock = vi.fn();
const syncApplyFixMock = vi.fn();
vi.mock('../lib/api', () => ({
  getMyPendingRequests: (...args: unknown[]) => getMyPendingRequestsMock(...args),
  markRequestComplete: (...args: unknown[]) => markRequestCompleteMock(...args),
  syncApplyFix: (...args: unknown[]) => syncApplyFixMock(...args),
}));

const loadStakeConfigMock = vi.fn();
const writeKindooConfigMock = vi.fn();
const loadSeatByEmailMock = vi.fn();
const loadSyncDataMock = vi.fn();
vi.mock('./data', () => ({
  loadStakeConfig: (...args: unknown[]) => loadStakeConfigMock(...args),
  writeKindooConfig: (...args: unknown[]) => writeKindooConfigMock(...args),
  loadSeatByEmail: (...args: unknown[]) => loadSeatByEmailMock(...args),
  loadSyncData: (...args: unknown[]) => loadSyncDataMock(...args),
}));

describe('handleRequest', () => {
  beforeEach(() => {
    signInMock.mockReset();
    signOutMock.mockReset();
    currentUserMock.mockReset();
    waitForAuthHydratedMock.mockReset();
    waitForAuthHydratedMock.mockResolvedValue(null);
    getMyPendingRequestsMock.mockReset();
    markRequestCompleteMock.mockReset();
    syncApplyFixMock.mockReset();
    loadStakeConfigMock.mockReset();
    writeKindooConfigMock.mockReset();
    loadSeatByEmailMock.mockReset();
    loadSyncDataMock.mockReset();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('auth.getState returns signed-out when no user is hydrated', async () => {
    currentUserMock.mockReturnValue(null);
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'auth.getState' });
    expect(result).toEqual({ ok: true, data: { status: 'signed-out' } });
  });

  it('auth.getState returns the principal snapshot when a user is hydrated', async () => {
    currentUserMock.mockReturnValue({
      uid: 'u1',
      email: 'mgr@example.com',
      displayName: 'Manager',
    });
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'auth.getState' });
    expect(result).toEqual({
      ok: true,
      data: {
        status: 'signed-in',
        user: { uid: 'u1', email: 'mgr@example.com', displayName: 'Manager' },
      },
    });
  });

  it('auth.signIn returns the signed-in snapshot on success', async () => {
    signInMock.mockResolvedValue({ uid: 'u1', email: 'mgr@example.com', displayName: null });
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'auth.signIn' });
    expect(result).toEqual({
      ok: true,
      data: {
        status: 'signed-in',
        user: { uid: 'u1', email: 'mgr@example.com', displayName: null },
      },
    });
  });

  it('auth.signIn wraps a thrown AuthError as a WireError', async () => {
    const { AuthError } = await import('../lib/auth');
    signInMock.mockRejectedValue(new AuthError('consent_dismissed', 'user dismissed'));
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'auth.signIn' });
    expect(result).toEqual({
      ok: false,
      error: { code: 'consent_dismissed', message: 'user dismissed' },
    });
  });

  it('auth.signOut returns ok on success', async () => {
    signOutMock.mockResolvedValue(undefined);
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'auth.signOut' });
    expect(result).toEqual({ ok: true, data: { done: true } });
  });

  it('api.getMyPendingRequests forwards the payload and unwraps the data', async () => {
    getMyPendingRequestsMock.mockResolvedValue({ requests: [{ request_id: 'r1' }] });
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({
      type: 'api.getMyPendingRequests',
      payload: { stakeId: 'csnorth' },
    });
    expect(getMyPendingRequestsMock).toHaveBeenCalledWith({ stakeId: 'csnorth' });
    expect(result).toEqual({ ok: true, data: { requests: [{ request_id: 'r1' }] } });
  });

  it('api.getMyPendingRequests surfaces httpsCallable error codes', async () => {
    const denied = Object.assign(new Error('nope'), { code: 'permission-denied' });
    getMyPendingRequestsMock.mockRejectedValue(denied);
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({
      type: 'api.getMyPendingRequests',
      payload: { stakeId: 'csnorth' },
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'permission-denied', message: 'nope' },
    });
  });

  it('api.markRequestComplete forwards the full payload', async () => {
    markRequestCompleteMock.mockResolvedValue({ ok: true });
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({
      type: 'api.markRequestComplete',
      payload: { stakeId: 'csnorth', requestId: 'r1', completionNote: 'note' },
    });
    expect(markRequestCompleteMock).toHaveBeenCalledWith({
      stakeId: 'csnorth',
      requestId: 'r1',
      completionNote: 'note',
    });
    expect(result).toEqual({ ok: true, data: { ok: true } });
  });

  it('data.getStakeConfig returns the loaded bundle', async () => {
    const fakeBundle = {
      stake: { stake_id: 'csnorth', stake_name: 'CSN' },
      buildings: [{ building_id: 'b1', building_name: 'B1' }],
    };
    loadStakeConfigMock.mockResolvedValue(fakeBundle);
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'data.getStakeConfig' });
    expect(loadStakeConfigMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, data: fakeBundle });
  });

  it('data.getStakeConfig surfaces loader errors as a wire error', async () => {
    loadStakeConfigMock.mockRejectedValue(
      Object.assign(new Error('rules blocked the read'), { code: 'permission-denied' }),
    );
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'data.getStakeConfig' });
    expect(result).toEqual({
      ok: false,
      error: { code: 'permission-denied', message: 'rules blocked the read' },
    });
  });

  it('data.writeKindooConfig rejects with unauthenticated when no user is signed in', async () => {
    currentUserMock.mockReturnValue(null);
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({
      type: 'data.writeKindooConfig',
      payload: { siteId: 27994, siteName: 'CSN', buildingRules: [] },
    });
    expect(writeKindooConfigMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: { code: 'unauthenticated', message: 'sign in before saving config' },
    });
  });

  it('data.writeKindooConfig forwards the payload + current user to the writer', async () => {
    const user = { uid: 'u1', email: 'mgr@example.com', displayName: 'Manager' };
    currentUserMock.mockReturnValue(user);
    writeKindooConfigMock.mockResolvedValue(undefined);
    const payload = {
      siteId: 27994,
      siteName: 'Colorado Springs North Stake',
      buildingRules: [{ buildingId: 'cordera', ruleId: 6248, ruleName: 'Cordera Doors' }],
    };
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'data.writeKindooConfig', payload });
    expect(writeKindooConfigMock).toHaveBeenCalledWith(payload, user);
    expect(result).toEqual({ ok: true, data: { ok: true } });
  });

  it('data.writeKindooConfig surfaces writer rejections as wire errors', async () => {
    currentUserMock.mockReturnValue({
      uid: 'u1',
      email: 'mgr@example.com',
      displayName: null,
    });
    writeKindooConfigMock.mockRejectedValue(
      Object.assign(new Error('rules denied write'), { code: 'permission-denied' }),
    );
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({
      type: 'data.writeKindooConfig',
      payload: { siteId: 27994, siteName: 'CSN', buildingRules: [] },
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'permission-denied', message: 'rules denied write' },
    });
  });

  it('data.getSeatByEmail forwards the canonical and returns the seat doc', async () => {
    const seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'CO',
      type: 'auto',
      callings: ['Sunday School Teacher'],
      building_names: ['Cordera Building'],
      duplicate_grants: [],
    };
    loadSeatByEmailMock.mockResolvedValue(seat);
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({
      type: 'data.getSeatByEmail',
      canonical: 'tad.e.smith@gmail.com',
    });
    expect(loadSeatByEmailMock).toHaveBeenCalledWith('tad.e.smith@gmail.com');
    expect(result).toEqual({ ok: true, data: seat });
  });

  it('data.getSeatByEmail returns null data when no seat exists (first-add case)', async () => {
    loadSeatByEmailMock.mockResolvedValue(null);
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({
      type: 'data.getSeatByEmail',
      canonical: 'unknown@example.com',
    });
    expect(result).toEqual({ ok: true, data: null });
  });

  it('data.getSeatByEmail surfaces loader rejections as wire errors', async () => {
    loadSeatByEmailMock.mockRejectedValue(
      Object.assign(new Error('rules blocked the read'), { code: 'permission-denied' }),
    );
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({
      type: 'data.getSeatByEmail',
      canonical: 'x@example.com',
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'permission-denied', message: 'rules blocked the read' },
    });
  });

  it('data.getSyncData returns the loaded sync bundle', async () => {
    const bundle = {
      stake: { stake_id: 'csnorth', stake_name: 'CSN' },
      wards: [{ ward_code: 'CO' }],
      buildings: [{ building_id: 'b1' }],
      seats: [{ member_canonical: 'a@x.com' }],
      wardCallingTemplates: [{ calling_name: 'X' }],
      stakeCallingTemplates: [],
      kindooSites: [],
    };
    loadSyncDataMock.mockResolvedValue(bundle);
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'data.getSyncData' });
    expect(loadSyncDataMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, data: bundle });
  });

  it('data.getSyncData surfaces loader rejections as wire errors', async () => {
    loadSyncDataMock.mockRejectedValue(
      Object.assign(new Error('rules blocked the read'), { code: 'permission-denied' }),
    );
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'data.getSyncData' });
    expect(result).toEqual({
      ok: false,
      error: { code: 'permission-denied', message: 'rules blocked the read' },
    });
  });

  it('data.syncApplyFix forwards the payload and unwraps the callable result', async () => {
    syncApplyFixMock.mockResolvedValue({ success: true, seatId: 'a@example.com' });
    const { handleRequest } = await import('./messages');
    const payload = {
      stakeId: 'csnorth',
      fix: { code: 'scope-mismatch' as const, payload: { memberEmail: 'a@x.com', newScope: 'CO' } },
    };
    const result = await handleRequest({ type: 'data.syncApplyFix', payload });
    expect(syncApplyFixMock).toHaveBeenCalledWith(payload);
    expect(result).toEqual({ ok: true, data: { success: true, seatId: 'a@example.com' } });
  });

  it('data.syncApplyFix surfaces callable HttpsError codes as wire errors', async () => {
    syncApplyFixMock.mockRejectedValue(
      Object.assign(new Error('not a manager'), { code: 'permission-denied' }),
    );
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({
      type: 'data.syncApplyFix',
      payload: {
        stakeId: 'csnorth',
        fix: { code: 'scope-mismatch', payload: { memberEmail: 'a@x.com', newScope: 'CO' } },
      },
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'permission-denied', message: 'not a manager' },
    });
  });
});

describe('registerMessageHandlers', () => {
  it('routes a known request through handleRequest and calls sendResponse async', async () => {
    currentUserMock.mockReturnValue(null);
    const { registerMessageHandlers } = await import('./messages');
    const listener = registerMessageHandlers();
    const sendResponse = vi.fn();
    const returned = listener(
      { type: 'auth.getState' },
      {} as chrome.runtime.MessageSender,
      sendResponse,
    );
    expect(returned).toBe(true);
    // The listener returns true (async); wait for the promise chain.
    await new Promise((r) => setTimeout(r, 0));
    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      data: { status: 'signed-out' },
    });
  });

  it('rejects unknown message shapes synchronously', async () => {
    const { registerMessageHandlers } = await import('./messages');
    const listener = registerMessageHandlers();
    const sendResponse = vi.fn();
    const returned = listener('not-an-object', {} as chrome.runtime.MessageSender, sendResponse);
    expect(returned).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'bad-request', message: 'unknown message type' },
    });
  });
});
