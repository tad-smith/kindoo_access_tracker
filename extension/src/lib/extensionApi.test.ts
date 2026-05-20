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
  storage: {
    local: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
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

  it('getStakeConfig posts data.getStakeConfig with the stakeId and unwraps the bundle', async () => {
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
    const result = await getStakeConfig('csnorth');
    expect(chromeStub().runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'data.getStakeConfig', stakeId: 'csnorth' },
      expect.any(Function),
    );
    expect(result).toEqual(bundle);
  });

  it('writeKindooConfig posts data.writeKindooConfig with the stakeId + payload', async () => {
    chromeStub().runtime.sendMessage.mockImplementation(
      (_req: unknown, cb: SendMessageCallback) => {
        cb({ ok: true, data: { ok: true } });
      },
    );
    const { writeKindooConfig } = await import('./extensionApi');
    const payload = {
      kindooSiteId: null,
      siteId: 27994,
      siteName: 'CSN',
      buildingRules: [{ buildingId: 'b1', ruleId: 6248, ruleName: 'Doors' }],
    };
    await writeKindooConfig('csnorth', payload);
    expect(chromeStub().runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'data.writeKindooConfig', stakeId: 'csnorth', payload },
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
      writeKindooConfig('csnorth', {
        kindooSiteId: null,
        siteId: 1,
        siteName: 'X',
        buildingRules: [],
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('getSeatByEmail posts data.getSeatByEmail with stakeId + canonical and unwraps the Seat', async () => {
    const seat = { member_canonical: 'x@example.com', building_names: ['B1'] };
    chromeStub().runtime.sendMessage.mockImplementation(
      (_req: unknown, cb: SendMessageCallback) => {
        cb({ ok: true, data: seat });
      },
    );
    const { getSeatByEmail } = await import('./extensionApi');
    const result = await getSeatByEmail('csnorth', 'x@example.com');
    expect(chromeStub().runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'data.getSeatByEmail', stakeId: 'csnorth', canonical: 'x@example.com' },
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
    const result = await getSeatByEmail('csnorth', 'nobody@example.com');
    expect(result).toBeNull();
  });

  it('resolveEidStakes posts data.resolveEidStakes with the eid and unwraps the full payload', async () => {
    chromeStub().runtime.sendMessage.mockImplementation(
      (_req: unknown, cb: SendMessageCallback) => {
        cb({
          ok: true,
          data: {
            candidates: [
              { stakeId: 'csnorth', label: 'CSN', match: 'home' },
              {
                stakeId: 'east-co',
                label: 'East CO',
                match: 'foreign',
                siteLabel: 'Pine Building',
              },
            ],
            managedStakeCount: 2,
            failedStakes: [],
            partialFailure: false,
          },
        });
      },
    );
    const { resolveEidStakes } = await import('./extensionApi');
    const result = await resolveEidStakes(27994);
    expect(chromeStub().runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'data.resolveEidStakes', eid: 27994 },
      expect.any(Function),
    );
    expect(result).toEqual({
      candidates: [
        { stakeId: 'csnorth', label: 'CSN', match: 'home' },
        {
          stakeId: 'east-co',
          label: 'East CO',
          match: 'foreign',
          siteLabel: 'Pine Building',
        },
      ],
      managedStakeCount: 2,
      failedStakes: [],
      partialFailure: false,
    });
  });

  it('resolveEidStakes throws ExtensionApiError on wire-level failure (Risk 2)', async () => {
    chromeStub().runtime.sendMessage.mockImplementation(
      (_req: unknown, cb: SendMessageCallback) => {
        cb({ ok: false, error: { code: 'network-error', message: 'token refresh failed' } });
      },
    );
    const { resolveEidStakes, ExtensionApiError } = await import('./extensionApi');
    await expect(resolveEidStakes(27994)).rejects.toBeInstanceOf(ExtensionApiError);
    await expect(resolveEidStakes(27994)).rejects.toMatchObject({ code: 'network-error' });
  });

  it('syncApplyFix posts the discriminated payload + unwraps the callable result', async () => {
    chromeStub().runtime.sendMessage.mockImplementation(
      (_req: unknown, cb: SendMessageCallback) => {
        cb({ ok: true, data: { success: true, seatId: 'a@example.com' } });
      },
    );
    const { syncApplyFix } = await import('./extensionApi');
    const input = {
      stakeId: 'csnorth',
      fix: {
        code: 'scope-mismatch' as const,
        payload: { memberEmail: 'a@example.com', newScope: 'CO' },
      },
    };
    const result = await syncApplyFix(input);
    expect(chromeStub().runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'data.syncApplyFix', payload: input },
      expect.any(Function),
    );
    expect(result).toEqual({ success: true, seatId: 'a@example.com' });
  });

  it('syncApplyFix throws on a wire-level error envelope', async () => {
    chromeStub().runtime.sendMessage.mockImplementation(
      (_req: unknown, cb: SendMessageCallback) => {
        cb({ ok: false, error: { code: 'permission-denied', message: 'no' } });
      },
    );
    const { syncApplyFix } = await import('./extensionApi');
    await expect(
      syncApplyFix({
        stakeId: 'csnorth',
        fix: {
          code: 'scope-mismatch',
          payload: { memberEmail: 'a@example.com', newScope: 'CO' },
        },
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('eidStakeChoice — per-EID picker persistence', () => {
  beforeEach(() => {
    chromeStub().storage.local.get.mockReset();
    chromeStub().storage.local.set.mockReset();
    chromeStub().storage.local.get.mockResolvedValue({});
    chromeStub().storage.local.set.mockResolvedValue(undefined);
  });

  it('readEidStakeChoice returns null when no choice has been persisted', async () => {
    chromeStub().storage.local.get.mockResolvedValue({});
    const { readEidStakeChoice } = await import('./extensionApi');
    expect(await readEidStakeChoice(27994)).toBeNull();
  });

  it('readEidStakeChoice returns the stored stakeId for the given EID', async () => {
    chromeStub().storage.local.get.mockResolvedValue({
      'sba.eidStakeChoice': { '27994': 'east-co', '4321': 'csnorth' },
    });
    const { readEidStakeChoice } = await import('./extensionApi');
    expect(await readEidStakeChoice(27994)).toBe('east-co');
    expect(await readEidStakeChoice(4321)).toBe('csnorth');
    expect(await readEidStakeChoice(9999)).toBeNull();
  });

  it('writeEidStakeChoice merges into the existing map under the single canonical key', async () => {
    chromeStub().storage.local.get.mockResolvedValue({
      'sba.eidStakeChoice': { '4321': 'csnorth' },
    });
    const { writeEidStakeChoice } = await import('./extensionApi');
    await writeEidStakeChoice(27994, 'east-co');
    expect(chromeStub().storage.local.set).toHaveBeenCalledWith({
      'sba.eidStakeChoice': { '4321': 'csnorth', '27994': 'east-co' },
    });
  });

  it('clearEidStakeChoice drops the entry but leaves others intact', async () => {
    chromeStub().storage.local.get.mockResolvedValue({
      'sba.eidStakeChoice': { '27994': 'east-co', '4321': 'csnorth' },
    });
    const { clearEidStakeChoice } = await import('./extensionApi');
    await clearEidStakeChoice(27994);
    expect(chromeStub().storage.local.set).toHaveBeenCalledWith({
      'sba.eidStakeChoice': { '4321': 'csnorth' },
    });
  });

  it('clearEidStakeChoice is a no-op when the EID has no stored choice', async () => {
    chromeStub().storage.local.get.mockResolvedValue({
      'sba.eidStakeChoice': { '4321': 'csnorth' },
    });
    const { clearEidStakeChoice } = await import('./extensionApi');
    await clearEidStakeChoice(99999);
    expect(chromeStub().storage.local.set).not.toHaveBeenCalled();
  });

  it('readEidStakeChoice rejects when chrome.storage.local.get rejects (T-49)', async () => {
    // T-49: previous behavior swallowed the rejection and returned {},
    // which let writeEidStakeChoice persist a single-entry map and
    // silently erase every other EID's choice. Read failures now
    // propagate.
    chromeStub().storage.local.get.mockRejectedValue(new Error('storage unavailable'));
    const { readEidStakeChoice } = await import('./extensionApi');
    await expect(readEidStakeChoice(27994)).rejects.toThrow(/storage unavailable/);
  });

  it('writeEidStakeChoice rejects and does NOT write when the prior read fails (T-49)', async () => {
    // T-49: the footgun the reviewer flagged. Without read-rejection
    // propagation, a single transient `get` failure would have caused
    // the writer to persist `{ <eid>: <stakeId> }` and wipe every other
    // stored choice. With propagation, the write is refused.
    chromeStub().storage.local.get.mockRejectedValue(new Error('storage unavailable'));
    const { writeEidStakeChoice } = await import('./extensionApi');
    await expect(writeEidStakeChoice(27994, 'east-co')).rejects.toThrow(/storage unavailable/);
    expect(chromeStub().storage.local.set).not.toHaveBeenCalled();
  });

  it('clearEidStakeChoice rejects and does NOT write when the prior read fails (T-49)', async () => {
    // Same footgun as writeEidStakeChoice — clearing relies on the same
    // read-then-write merge shape, so the same guard applies.
    chromeStub().storage.local.get.mockRejectedValue(new Error('storage unavailable'));
    const { clearEidStakeChoice } = await import('./extensionApi');
    await expect(clearEidStakeChoice(27994)).rejects.toThrow(/storage unavailable/);
    expect(chromeStub().storage.local.set).not.toHaveBeenCalled();
  });
});
