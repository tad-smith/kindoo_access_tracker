// Unit tests for the SW message dispatcher. The Chrome / Firebase
// boundary is mocked at the module edge so the handler logic can be
// exercised under jsdom without a running browser or Firebase
// project.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signInMock = vi.fn();
const signOutMock = vi.fn();
const currentUserMock = vi.fn();
const waitForAuthHydratedMock = vi.fn(() => Promise.resolve(null));
const readManagerStakesMock = vi.fn(() => Promise.resolve<string[]>([]));

vi.mock('../lib/auth', async () => {
  const actual = await vi.importActual<typeof import('../lib/auth')>('../lib/auth');
  return {
    ...actual,
    signIn: () => signInMock(),
    signOut: () => signOutMock(),
    currentUser: () => currentUserMock(),
    waitForAuthHydrated: () => waitForAuthHydratedMock(),
    readManagerStakes: (..._args: unknown[]) => readManagerStakesMock(),
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
const writeKindooSiteEidMock = vi.fn();
const resolveEidStakesMock = vi.fn();
vi.mock('./data', () => ({
  loadStakeConfig: (...args: unknown[]) => loadStakeConfigMock(...args),
  writeKindooConfig: (...args: unknown[]) => writeKindooConfigMock(...args),
  loadSeatByEmail: (...args: unknown[]) => loadSeatByEmailMock(...args),
  loadSyncData: (...args: unknown[]) => loadSyncDataMock(...args),
  writeKindooSiteEid: (...args: unknown[]) => writeKindooSiteEidMock(...args),
  resolveEidStakes: (...args: unknown[]) => resolveEidStakesMock(...args),
}));

describe('handleRequest', () => {
  beforeEach(() => {
    signInMock.mockReset();
    signOutMock.mockReset();
    currentUserMock.mockReset();
    waitForAuthHydratedMock.mockReset();
    waitForAuthHydratedMock.mockResolvedValue(null);
    readManagerStakesMock.mockReset();
    readManagerStakesMock.mockResolvedValue([]);
    getMyPendingRequestsMock.mockReset();
    markRequestCompleteMock.mockReset();
    syncApplyFixMock.mockReset();
    loadStakeConfigMock.mockReset();
    writeKindooConfigMock.mockReset();
    loadSeatByEmailMock.mockReset();
    loadSyncDataMock.mockReset();
    writeKindooSiteEidMock.mockReset();
    resolveEidStakesMock.mockReset();
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
        user: {
          uid: 'u1',
          email: 'mgr@example.com',
          displayName: 'Manager',
        },
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
        user: {
          uid: 'u1',
          email: 'mgr@example.com',
          displayName: null,
        },
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
    const result = await handleRequest({ type: 'data.getStakeConfig', stakeId: 'csnorth' });
    expect(loadStakeConfigMock).toHaveBeenCalledWith('csnorth');
    expect(result).toEqual({ ok: true, data: fakeBundle });
  });

  it('data.getStakeConfig surfaces loader errors as a wire error', async () => {
    loadStakeConfigMock.mockRejectedValue(
      Object.assign(new Error('rules blocked the read'), { code: 'permission-denied' }),
    );
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'data.getStakeConfig', stakeId: 'csnorth' });
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
      stakeId: 'csnorth',
      payload: { kindooSiteId: null, siteId: 27994, siteName: 'CSN', buildingRules: [] },
    });
    expect(writeKindooConfigMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: { code: 'unauthenticated', message: 'sign in before saving config' },
    });
  });

  it('data.writeKindooConfig forwards the home payload + current user to the writer', async () => {
    const user = { uid: 'u1', email: 'mgr@example.com', displayName: 'Manager' };
    currentUserMock.mockReturnValue(user);
    writeKindooConfigMock.mockResolvedValue(undefined);
    const payload = {
      kindooSiteId: null,
      siteId: 27994,
      siteName: 'Colorado Springs North Stake',
      buildingRules: [{ buildingId: 'maple', ruleId: 6248, ruleName: 'Maple Doors' }],
    };
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({
      type: 'data.writeKindooConfig',
      stakeId: 'csnorth',
      payload,
    });
    expect(writeKindooConfigMock).toHaveBeenCalledWith('csnorth', payload, user);
    expect(result).toEqual({ ok: true, data: { ok: true } });
  });

  it('data.writeKindooConfig forwards a foreign-site payload through to the writer', async () => {
    const user = { uid: 'u1', email: 'mgr@example.com', displayName: 'Manager' };
    currentUserMock.mockReturnValue(user);
    writeKindooConfigMock.mockResolvedValue(undefined);
    const payload = {
      kindooSiteId: 'east-stake',
      siteId: 4321,
      siteName: 'East Stake',
      buildingRules: [{ buildingId: 'pine', ruleId: 8001, ruleName: 'Pine Doors' }],
    };
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({
      type: 'data.writeKindooConfig',
      stakeId: 'csnorth',
      payload,
    });
    expect(writeKindooConfigMock).toHaveBeenCalledWith('csnorth', payload, user);
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
      stakeId: 'csnorth',
      payload: { kindooSiteId: null, siteId: 27994, siteName: 'CSN', buildingRules: [] },
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'permission-denied', message: 'rules denied write' },
    });
  });

  it('data.writeKindooSiteEid rejects with unauthenticated when no user is signed in', async () => {
    currentUserMock.mockReturnValue(null);
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({
      type: 'data.writeKindooSiteEid',
      stakeId: 'csnorth',
      payload: { kindooSiteId: 'east-stake', kindooEid: 4321 },
    });
    expect(writeKindooSiteEidMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: { code: 'unauthenticated', message: 'sign in before writing site eid' },
    });
  });

  it('data.writeKindooSiteEid forwards the payload + current user to the writer', async () => {
    const user = { uid: 'u1', email: 'mgr@example.com', displayName: 'Manager' };
    currentUserMock.mockReturnValue(user);
    writeKindooSiteEidMock.mockResolvedValue(undefined);
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({
      type: 'data.writeKindooSiteEid',
      stakeId: 'csnorth',
      payload: { kindooSiteId: 'east-stake', kindooEid: 4321 },
    });
    expect(writeKindooSiteEidMock).toHaveBeenCalledWith('csnorth', 'east-stake', 4321, user);
    expect(result).toEqual({ ok: true, data: { ok: true } });
  });

  it('data.getSeatByEmail forwards the canonical and returns the seat doc', async () => {
    const seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Test User',
      scope: 'CO',
      type: 'auto',
      callings: ['Sunday School Teacher'],
      building_names: ['Maple Building'],
      duplicate_grants: [],
    };
    loadSeatByEmailMock.mockResolvedValue(seat);
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({
      type: 'data.getSeatByEmail',
      stakeId: 'csnorth',
      canonical: 'tad.e.smith@gmail.com',
    });
    expect(loadSeatByEmailMock).toHaveBeenCalledWith('csnorth', 'tad.e.smith@gmail.com');
    expect(result).toEqual({ ok: true, data: seat });
  });

  it('data.getSeatByEmail returns null data when no seat exists (first-add case)', async () => {
    loadSeatByEmailMock.mockResolvedValue(null);
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({
      type: 'data.getSeatByEmail',
      stakeId: 'csnorth',
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
      stakeId: 'csnorth',
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
    const result = await handleRequest({ type: 'data.getSyncData', stakeId: 'csnorth' });
    expect(loadSyncDataMock).toHaveBeenCalledWith('csnorth');
    expect(result).toEqual({ ok: true, data: bundle });
  });

  it('data.getSyncData surfaces loader rejections as wire errors', async () => {
    loadSyncDataMock.mockRejectedValue(
      Object.assign(new Error('rules blocked the read'), { code: 'permission-denied' }),
    );
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'data.getSyncData', stakeId: 'csnorth' });
    expect(result).toEqual({
      ok: false,
      error: { code: 'permission-denied', message: 'rules blocked the read' },
    });
  });

  it('data.resolveEidStakes reads claims, fans out per managed stake, returns candidates + managedStakeCount + failedStakes + partialFailure', async () => {
    currentUserMock.mockReturnValue({ uid: 'u1', email: 'mgr@example.com' });
    readManagerStakesMock.mockResolvedValue(['csnorth', 'east-co']);
    resolveEidStakesMock.mockResolvedValue({
      candidates: [
        { stakeId: 'csnorth', label: 'CSN', match: 'home' },
        {
          stakeId: 'east-co',
          label: 'East CO',
          match: 'foreign',
          siteLabel: 'Pine Building',
        },
      ],
      failedStakes: [],
    });
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'data.resolveEidStakes', eid: 27994 });
    expect(resolveEidStakesMock).toHaveBeenCalledWith(27994, ['csnorth', 'east-co']);
    expect(result).toEqual({
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
  });

  it('data.resolveEidStakes returns an unauthenticated wire error when no user is signed in', async () => {
    // SW cold-start fix: after `waitForAuthHydrated()` returns and
    // `currentUser()` is still null, the user truly is signed out.
    // Return an unauthenticated wire error rather than
    // `managedStakeCount: 0` so the panel routes to wire-error
    // (with retry), NOT to NotAuthorized (which would be a dead-end
    // for a still-signed-in operator caught by the SW cold-start
    // race).
    currentUserMock.mockReturnValue(null);
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'data.resolveEidStakes', eid: 27994 });
    expect(resolveEidStakesMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: { code: 'unauthenticated', message: 'sign in before resolving stakes' },
    });
  });

  it('data.resolveEidStakes awaits waitForAuthHydrated before reading currentUser (SW cold-start race)', async () => {
    // Concrete scenario: SW had idle-suspended, operator clicks Retry
    // on the slide-over's error panel, the SW wakes but Firebase Auth
    // has not finished rehydrating from IndexedDB. Without the
    // `waitForAuthHydrated()` gate, `currentUser()` would still be null
    // and the handler would surface "no user" — sending the panel to
    // NotAuthorized for a still-signed-in operator. With the gate, the
    // handler waits, sees the hydrated user, and resolves normally.
    let releaseHydration: (() => void) | undefined;
    waitForAuthHydratedMock.mockReturnValue(
      new Promise<null>((resolve) => {
        releaseHydration = () => resolve(null);
      }),
    );
    currentUserMock.mockReturnValue(null);
    readManagerStakesMock.mockResolvedValue(['csnorth']);
    resolveEidStakesMock.mockResolvedValue({ candidates: [], failedStakes: [] });
    const { handleRequest } = await import('./messages');
    const pending = handleRequest({ type: 'data.resolveEidStakes', eid: 27994 });
    // Resolver must not have been invoked yet — we are still waiting on
    // auth to hydrate.
    expect(resolveEidStakesMock).not.toHaveBeenCalled();
    // Now hydration "completes" and the user becomes visible.
    currentUserMock.mockReturnValue({ uid: 'u1', email: 'mgr@example.com' });
    releaseHydration?.();
    const result = await pending;
    expect(resolveEidStakesMock).toHaveBeenCalledWith(27994, ['csnorth']);
    expect(result).toEqual({
      ok: true,
      data: { candidates: [], managedStakeCount: 1, failedStakes: [], partialFailure: false },
    });
  });

  it('data.resolveEidStakes returns managedStakeCount=0 + empty candidates when claims carry no manager roles', async () => {
    // Risk 3: signed-in user with `stakes === {}` claims must surface
    // `managedStakeCount: 0` so the panel routes to NotAuthorized
    // rather than the reconfigure-copy no-candidates branch.
    currentUserMock.mockReturnValue({ uid: 'u1', email: 'nonmgr@example.com' });
    readManagerStakesMock.mockResolvedValue([]);
    resolveEidStakesMock.mockResolvedValue({ candidates: [], failedStakes: [] });
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'data.resolveEidStakes', eid: 27994 });
    expect(resolveEidStakesMock).toHaveBeenCalledWith(27994, []);
    expect(result).toEqual({
      ok: true,
      data: { candidates: [], managedStakeCount: 0, failedStakes: [], partialFailure: false },
    });
  });

  it('data.resolveEidStakes returns managedStakeCount>0 + empty candidates when EID is not configured under any managed stake', async () => {
    currentUserMock.mockReturnValue({ uid: 'u1', email: 'mgr@example.com' });
    readManagerStakesMock.mockResolvedValue(['csnorth', 'east-co']);
    resolveEidStakesMock.mockResolvedValue({ candidates: [], failedStakes: [] });
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'data.resolveEidStakes', eid: 99999 });
    expect(result).toEqual({
      ok: true,
      data: { candidates: [], managedStakeCount: 2, failedStakes: [], partialFailure: false },
    });
  });

  it('data.resolveEidStakes propagates failedStakes from the resolver and derives partialFailure (Item 2)', async () => {
    // Item 2: when every per-stake closure throws, the resolver
    // reports the failed stakeIds alongside empty candidates. The
    // dispatcher must thread those through to the wire response and
    // surface a `partialFailure: true` convenience flag so App.tsx
    // can route to wire-error instead of no-candidates.
    currentUserMock.mockReturnValue({ uid: 'u1', email: 'mgr@example.com' });
    readManagerStakesMock.mockResolvedValue(['csnorth', 'east-co']);
    resolveEidStakesMock.mockResolvedValue({
      candidates: [],
      failedStakes: ['csnorth', 'east-co'],
    });
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'data.resolveEidStakes', eid: 27994 });
    expect(result).toEqual({
      ok: true,
      data: {
        candidates: [],
        managedStakeCount: 2,
        failedStakes: ['csnorth', 'east-co'],
        partialFailure: true,
      },
    });
  });

  it('data.resolveEidStakes surfaces a partial failure with surviving candidates (T-48)', async () => {
    // T-48: when one stake fails but others succeed, the dispatcher
    // must carry the failed-stake list through to the wire response
    // so App.tsx can render a non-modal partial-failure banner above
    // the picker / resolved view. The convenience `partialFailure`
    // boolean is `failedStakes.length > 0`.
    currentUserMock.mockReturnValue({ uid: 'u1', email: 'mgr@example.com' });
    readManagerStakesMock.mockResolvedValue(['csnorth', 'east-co']);
    resolveEidStakesMock.mockResolvedValue({
      candidates: [{ stakeId: 'csnorth', label: 'CSN', match: 'home' }],
      failedStakes: ['east-co'],
    });
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'data.resolveEidStakes', eid: 27994 });
    expect(result).toEqual({
      ok: true,
      data: {
        candidates: [{ stakeId: 'csnorth', label: 'CSN', match: 'home' }],
        managedStakeCount: 2,
        failedStakes: ['east-co'],
        partialFailure: true,
      },
    });
  });

  it('data.resolveEidStakes surfaces readManagerStakes throws as a wire error (Risk 2)', async () => {
    // The CS-side App.tsx routes wire errors to a distinct
    // "Couldn't reach SBA" state, not to no-candidates.
    currentUserMock.mockReturnValue({ uid: 'u1', email: 'mgr@example.com' });
    readManagerStakesMock.mockRejectedValue(
      Object.assign(new Error('token refresh failed'), { code: 'network-error' }),
    );
    const { handleRequest } = await import('./messages');
    const result = await handleRequest({ type: 'data.resolveEidStakes', eid: 27994 });
    expect(result).toEqual({
      ok: false,
      error: { code: 'network-error', message: 'token refresh failed' },
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
