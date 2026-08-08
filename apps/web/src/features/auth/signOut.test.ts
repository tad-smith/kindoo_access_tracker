// Unit tests for `signOut()`.

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

import { signOut } from './signOut';

beforeEach(() => {
  firebaseSignOutMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('signOut', () => {
  it('calls firebaseSignOut with the auth singleton', async () => {
    firebaseSignOutMock.mockResolvedValueOnce(undefined);

    await signOut();

    expect(firebaseSignOutMock).toHaveBeenCalledTimes(1);
    expect(firebaseSignOutMock).toHaveBeenCalledWith({ __mockAuth: true });
  });
});
