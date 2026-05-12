// Unit tests for the content-script-side messaging wrappers. Verify
// the request envelopes hitting chrome.runtime.sendMessage and the
// unwrap path that turns a WireError into a typed ExtensionApiError.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ChromeStub {
  runtime: {
    sendMessage: ReturnType<typeof vi.fn>;
    onMessage: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
    lastError: { message: string } | undefined;
  };
}

function chromeStub(): ChromeStub {
  return globalThis.chrome as unknown as ChromeStub;
}

type SendMessageCallback = (response: unknown) => void;

describe('extensionApi', () => {
  beforeEach(() => {
    chromeStub().runtime.sendMessage.mockReset();
    chromeStub().runtime.lastError = undefined;
  });
  afterEach(() => {
    chromeStub().runtime.lastError = undefined;
  });

  it('signIn posts auth.signIn and unwraps the AuthSnapshot', async () => {
    chromeStub().runtime.sendMessage.mockImplementation(
      (_req: unknown, cb: SendMessageCallback) => {
        cb({
          ok: true,
          data: {
            status: 'signed-in',
            user: { uid: 'u1', email: 'mgr@example.com', displayName: null },
          },
        });
      },
    );
    const { signIn } = await import('./extensionApi');
    const result = await signIn();
    expect(chromeStub().runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'auth.signIn' },
      expect.any(Function),
    );
    expect(result).toEqual({
      status: 'signed-in',
      user: { uid: 'u1', email: 'mgr@example.com', displayName: null },
    });
  });

  it('signIn throws ExtensionApiError carrying the wire error code', async () => {
    chromeStub().runtime.sendMessage.mockImplementation(
      (_req: unknown, cb: SendMessageCallback) => {
        cb({
          ok: false,
          error: { code: 'consent_dismissed', message: 'dismissed' },
        });
      },
    );
    const { signIn, ExtensionApiError } = await import('./extensionApi');
    await expect(signIn()).rejects.toBeInstanceOf(ExtensionApiError);
    await expect(signIn()).rejects.toMatchObject({ code: 'consent_dismissed' });
  });

  it('getMyPendingRequests posts the right payload + name', async () => {
    chromeStub().runtime.sendMessage.mockImplementation(
      (_req: unknown, cb: SendMessageCallback) => {
        cb({ ok: true, data: { requests: [] } });
      },
    );
    const { getMyPendingRequests } = await import('./extensionApi');
    const result = await getMyPendingRequests({ stakeId: 'csnorth' });
    expect(chromeStub().runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'api.getMyPendingRequests', payload: { stakeId: 'csnorth' } },
      expect.any(Function),
    );
    expect(result).toEqual({ requests: [] });
  });

  it('markRequestComplete posts the right payload + name', async () => {
    chromeStub().runtime.sendMessage.mockImplementation(
      (_req: unknown, cb: SendMessageCallback) => {
        cb({ ok: true, data: { ok: true } });
      },
    );
    const { markRequestComplete } = await import('./extensionApi');
    await markRequestComplete({ stakeId: 'csnorth', requestId: 'r1', completionNote: 'note' });
    expect(chromeStub().runtime.sendMessage).toHaveBeenCalledWith(
      {
        type: 'api.markRequestComplete',
        payload: { stakeId: 'csnorth', requestId: 'r1', completionNote: 'note' },
      },
      expect.any(Function),
    );
  });

  it('rejects with ExtensionApiError(sw-unreachable) when chrome.runtime.lastError fires', async () => {
    chromeStub().runtime.sendMessage.mockImplementation(
      (_req: unknown, cb: SendMessageCallback) => {
        chromeStub().runtime.lastError = { message: 'SW asleep' };
        cb(undefined);
      },
    );
    const { signIn } = await import('./extensionApi');
    await expect(signIn()).rejects.toMatchObject({ code: 'sw-unreachable' });
  });
});
