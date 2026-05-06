// Unit tests for the bounded poll-and-refresh added to `signIn` to
// mitigate the first-login claims race (B-4). The Firebase popup flow
// and Auth instance are mocked at the module boundary so we exercise:
//   - `getIdToken(true)` is called once up-front, then once per
//     polling iteration that observes a claims-less token.
//   - Polling stops as soon as `claims.canonical` is present.
//   - If claims never arrive (10 iterations all return claims-less),
//     `signIn` still resolves with the user and does not throw.
//   - The polling interval is 500ms (asserted under fake timers).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const signInWithPopupMock = vi.fn();
const getIdTokenMock = vi.fn();
const getIdTokenResultMock = vi.fn();

vi.mock('firebase/auth', async () => {
  const actual = await vi.importActual<typeof import('firebase/auth')>('firebase/auth');
  return {
    ...actual,
    GoogleAuthProvider: actual.GoogleAuthProvider,
    signInWithPopup: (...args: unknown[]) => signInWithPopupMock(...args),
  };
});

vi.mock('../../lib/firebase', () => ({
  auth: {},
}));

import { signIn } from './signIn';

function makeUser() {
  return {
    uid: 'u1',
    email: 'zach.q.mortensen@gmail.com',
    getIdToken: getIdTokenMock,
    getIdTokenResult: getIdTokenResultMock,
  };
}

beforeEach(() => {
  signInWithPopupMock.mockReset();
  getIdTokenMock.mockReset();
  getIdTokenResultMock.mockReset();
  getIdTokenMock.mockResolvedValue('id-token');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('signIn — bounded poll for canonical claim (B-4)', () => {
  it('returns immediately after the first refresh when claims are already present', async () => {
    const user = makeUser();
    signInWithPopupMock.mockResolvedValueOnce({ user });
    getIdTokenResultMock.mockResolvedValueOnce({
      claims: { canonical: 'zachqmortensen@gmail.com' },
    });

    const returned = await signIn();

    expect(returned).toBe(user);
    // One up-front refresh, then one probe of getIdTokenResult that
    // sees the canonical claim and breaks the loop. No second refresh.
    expect(getIdTokenMock).toHaveBeenCalledTimes(1);
    expect(getIdTokenMock).toHaveBeenCalledWith(true);
    expect(getIdTokenResultMock).toHaveBeenCalledTimes(1);
  });

  it('polls until the canonical claim arrives and stops at the first iteration that sees it', async () => {
    vi.useFakeTimers();
    const user = makeUser();
    signInWithPopupMock.mockResolvedValueOnce({ user });
    // Three claims-less probes, then claims arrive.
    getIdTokenResultMock
      .mockResolvedValueOnce({ claims: {} })
      .mockResolvedValueOnce({ claims: {} })
      .mockResolvedValueOnce({ claims: {} })
      .mockResolvedValueOnce({ claims: { canonical: 'zachqmortensen@gmail.com' } });

    const promise = signIn();
    // Run all pending microtasks + timers until the polling resolves.
    await vi.runAllTimersAsync();
    const returned = await promise;

    expect(returned).toBe(user);
    // 1 up-front refresh + 3 retry refreshes (one after each
    // claims-less probe). The 4th probe sees the claim and breaks
    // before scheduling another refresh.
    expect(getIdTokenMock).toHaveBeenCalledTimes(4);
    expect(getIdTokenResultMock).toHaveBeenCalledTimes(4);
  });

  it('resolves without throwing when claims never arrive within the 10-iteration ceiling', async () => {
    vi.useFakeTimers();
    const user = makeUser();
    signInWithPopupMock.mockResolvedValueOnce({ user });
    // Every probe returns a claims-less token.
    getIdTokenResultMock.mockResolvedValue({ claims: {} });

    const promise = signIn();
    await vi.runAllTimersAsync();
    const returned = await promise;

    expect(returned).toBe(user);
    // 10 probes; 1 up-front refresh + 10 retry refreshes (one after
    // each claims-less probe, including the last iteration).
    expect(getIdTokenResultMock).toHaveBeenCalledTimes(10);
    expect(getIdTokenMock).toHaveBeenCalledTimes(11);
  });

  it('waits 500ms between polling iterations', async () => {
    vi.useFakeTimers();
    const user = makeUser();
    signInWithPopupMock.mockResolvedValueOnce({ user });
    getIdTokenResultMock
      .mockResolvedValueOnce({ claims: {} })
      .mockResolvedValueOnce({ claims: { canonical: 'zachqmortensen@gmail.com' } });

    const promise = signIn();

    // Drain the microtask queue so the first probe (claims-less)
    // completes and the 500ms timer is scheduled.
    await vi.advanceTimersByTimeAsync(0);
    expect(getIdTokenResultMock).toHaveBeenCalledTimes(1);
    // Refresh count so far: one up-front. The retry refresh has not
    // yet been issued because the timer has not advanced.
    expect(getIdTokenMock).toHaveBeenCalledTimes(1);

    // Advance just under the interval — still no second probe.
    await vi.advanceTimersByTimeAsync(499);
    expect(getIdTokenResultMock).toHaveBeenCalledTimes(1);

    // Cross the 500ms boundary; the retry refresh fires and the
    // second probe sees the canonical claim.
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(getIdTokenMock).toHaveBeenCalledTimes(2);
    expect(getIdTokenResultMock).toHaveBeenCalledTimes(2);
  });

  it('propagates a rejection from signInWithPopup', async () => {
    signInWithPopupMock.mockRejectedValueOnce(new Error('popup blocked'));
    await expect(signIn()).rejects.toThrow(/popup blocked/);
    expect(getIdTokenMock).not.toHaveBeenCalled();
    expect(getIdTokenResultMock).not.toHaveBeenCalled();
  });
});
