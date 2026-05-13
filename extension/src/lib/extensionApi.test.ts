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

  it('getStakeConfig posts data.getStakeConfig and unwraps the bundle', async () => {
    const bundle = {
      stake: { stake_id: 'csnorth', stake_name: 'CSN' },
      buildings: [{ building_id: 'b1', building_name: 'B1' }],
    };
    chromeStub().runtime.sendMessage.mockImplementation(
      (_req: unknown, cb: SendMessageCallback) => {
        cb({ ok: true, data: bundle });
      },
    );
    const { getStakeConfig } = await import('./extensionApi');
    const result = await getStakeConfig();
    expect(chromeStub().runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'data.getStakeConfig' },
      expect.any(Function),
    );
    expect(result).toEqual(bundle);
  });

  it('writeKindooConfig posts data.writeKindooConfig with the payload', async () => {
    chromeStub().runtime.sendMessage.mockImplementation(
      (_req: unknown, cb: SendMessageCallback) => {
        cb({ ok: true, data: { ok: true } });
      },
    );
    const { writeKindooConfig } = await import('./extensionApi');
    const payload = {
      siteId: 27994,
      siteName: 'CSN',
      buildingRules: [{ buildingId: 'b1', ruleId: 6248, ruleName: 'Doors' }],
    };
    await writeKindooConfig(payload);
    expect(chromeStub().runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'data.writeKindooConfig', payload },
      expect.any(Function),
    );
  });

  it('writeKindooConfig throws on a wire-level error', async () => {
    chromeStub().runtime.sendMessage.mockImplementation(
      (_req: unknown, cb: SendMessageCallback) => {
        cb({ ok: false, error: { code: 'permission-denied', message: 'no' } });
      },
    );
    const { writeKindooConfig } = await import('./extensionApi');
    await expect(
      writeKindooConfig({ siteId: 1, siteName: 'X', buildingRules: [] }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('getSeatByEmail posts data.getSeatByEmail with the canonical and unwraps the Seat', async () => {
    const seat = { member_canonical: 'x@example.com', building_names: ['B1'] };
    chromeStub().runtime.sendMessage.mockImplementation(
      (_req: unknown, cb: SendMessageCallback) => {
        cb({ ok: true, data: seat });
      },
    );
    const { getSeatByEmail } = await import('./extensionApi');
    const result = await getSeatByEmail('x@example.com');
    expect(chromeStub().runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'data.getSeatByEmail', canonical: 'x@example.com' },
      expect.any(Function),
    );
    expect(result).toEqual(seat);
  });

  it('getSeatByEmail returns null when no seat exists', async () => {
    chromeStub().runtime.sendMessage.mockImplementation(
      (_req: unknown, cb: SendMessageCallback) => {
        cb({ ok: true, data: null });
      },
    );
    const { getSeatByEmail } = await import('./extensionApi');
    const result = await getSeatByEmail('nobody@example.com');
    expect(result).toBeNull();
  });
});
