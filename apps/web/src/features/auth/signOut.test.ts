// Unit tests for `signOut()`. The Firebase SDK is mocked at the module
// boundary so we can assert:
//   - it clears BOTH `kindoo.activeStake` storage tiers (B-19: prevents
//     a stale entry from permanently shadowing the next sign-in's
//     resolution, and from leaking one user's stake selection into the
//     next user's session on a shared browser),
//   - storage is cleared even when the underlying `firebaseSignOut`
//     call rejects,
//   - it delegates to `firebaseSignOut` with the `auth` singleton.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const firebaseSignOutMock = vi.fn();

vi.mock('firebase/auth', async () => {
  const actual = await vi.importActual<typeof import('firebase/auth')>('firebase/auth');
  return {
    ...actual,
    signOut: (...args: unknown[]) => firebaseSignOutMock(...args),
  };
});

vi.mock('../../lib/firebase', () => ({
  auth: { __mockAuth: true },
}));

import { ACTIVE_STAKE_LOCAL_KEY, ACTIVE_STAKE_SESSION_KEY } from '../../lib/activeStake';
import { signOut } from './signOut';

beforeEach(() => {
  firebaseSignOutMock.mockReset();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('signOut', () => {
  it('clears both kindoo.activeStake storage tiers', async () => {
    window.sessionStorage.setItem(ACTIVE_STAKE_SESSION_KEY, 'csnorth');
    window.localStorage.setItem(ACTIVE_STAKE_LOCAL_KEY, 'csnorth');
    firebaseSignOutMock.mockResolvedValueOnce(undefined);

    await signOut();

    expect(window.sessionStorage.getItem(ACTIVE_STAKE_SESSION_KEY)).toBeNull();
    expect(window.localStorage.getItem(ACTIVE_STAKE_LOCAL_KEY)).toBeNull();
  });

  it('calls firebaseSignOut with the auth singleton', async () => {
    firebaseSignOutMock.mockResolvedValueOnce(undefined);

    await signOut();

    expect(firebaseSignOutMock).toHaveBeenCalledTimes(1);
    expect(firebaseSignOutMock).toHaveBeenCalledWith({ __mockAuth: true });
  });

  it('still clears storage when firebaseSignOut rejects', async () => {
    window.sessionStorage.setItem(ACTIVE_STAKE_SESSION_KEY, 'csnorth');
    window.localStorage.setItem(ACTIVE_STAKE_LOCAL_KEY, 'csnorth');
    firebaseSignOutMock.mockRejectedValueOnce(new Error('network error'));

    await expect(signOut()).rejects.toThrow(/network error/);

    expect(window.sessionStorage.getItem(ACTIVE_STAKE_SESSION_KEY)).toBeNull();
    expect(window.localStorage.getItem(ACTIVE_STAKE_LOCAL_KEY)).toBeNull();
  });
});
