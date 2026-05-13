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
vi.mock('../lib/api', () => ({
  getMyPendingRequests: (...args: unknown[]) => getMyPendingRequestsMock(...args),
  markRequestComplete: (...args: unknown[]) => markRequestCompleteMock(...args),
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
