// Hook tests for the push-notifications feature. The Firebase
// messaging SDK is fully mocked — these are unit-scope tests of the
// userIndex write surface, not integration tests of FCM itself.
//
// Coverage:
//   - `useEnablePushMutation` writes the deviceId-keyed token + flips
//     newRequest pref to true; refuses cleanly when VAPID is unset.
//   - `useDisablePushMutation` clears the deviceId slot via deleteField
//     and flips newRequest pref to false.
//   - `useUpdateNewRequestPrefMutation` updates only the pref.
//   - `useIsThisDeviceSubscribed` + `getNewRequestPref` derive correctly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { UserIndexEntry } from '@kindoo/shared';

const setDocMock = vi.fn();
const deleteFieldSentinel = { __deleteField: true };

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore');
  return {
    ...actual,
    setDoc: (...args: unknown[]) => setDocMock(...args),
    deleteField: () => deleteFieldSentinel,
  };
});

const getTokenMock = vi.fn();
const deleteTokenMock = vi.fn();
const getMessagingMock = vi.fn();

vi.mock('firebase/messaging', () => ({
  getToken: (...args: unknown[]) => getTokenMock(...args),
  deleteToken: (...args: unknown[]) => deleteTokenMock(...args),
  getMessaging: (...args: unknown[]) => getMessagingMock(...args),
}));

const usePrincipalMock = vi.fn();

vi.mock('../../../lib/principal', () => ({
  usePrincipal: () => usePrincipalMock(),
}));

vi.mock('../../../lib/data', () => ({
  useFirestoreDoc: vi.fn(),
}));

vi.mock('../../../lib/firebase', () => ({
  db: { __db: true },
  firebaseApp: { __app: true },
}));

vi.mock('../../../lib/docs', () => ({
  userIndexRef: (db: unknown, canonical: string) => ({ __ref: 'userIndex', canonical, db }),
}));

import {
  getNewRequestPref,
  useDisablePushMutation,
  useEnablePushMutation,
  useIsThisDeviceSubscribed,
  useUpdateNewRequestPrefMutation,
} from '../hooks';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubEnv('VITE_FCM_VAPID_PUBLIC_KEY', 'test-vapid-key');

  usePrincipalMock.mockReturnValue({
    email: 'Mgr@gmail.com',
    canonical: 'mgr@gmail.com',
  });

  // Stub Notification API
  (globalThis as { Notification?: unknown }).Notification = {
    requestPermission: () => Promise.resolve('granted' as NotificationPermission),
    permission: 'default',
  };

  // The hooks no longer call `navigator.serviceWorker.register` — the
  // FCM SDK auto-registers the baked-in SW. We don't stub
  // navigator.serviceWorker here; if the production code path
  // regresses and tries to register, jsdom will throw and the test
  // will fail loudly.

  getMessagingMock.mockReturnValue({ __messaging: true });
  getTokenMock.mockResolvedValue('fcm-token-aaa');
  deleteTokenMock.mockResolvedValue(true);
  setDocMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as { Notification?: unknown }).Notification;
});

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: {} } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useIsThisDeviceSubscribed', () => {
  it('returns false when fcmTokens is absent', () => {
    const { result } = renderHook(() => useIsThisDeviceSubscribed(undefined), {
      wrapper: Wrapper,
    });
    expect(result.current).toBe(false);
  });

  it('returns true when this deviceId is registered', () => {
    // Seed the deviceId in localStorage so the hook reads a stable value.
    localStorage.setItem('kindoo:fcmDeviceId', 'device-fixed-1');
    const entry: UserIndexEntry = {
      uid: 'u',
      typedEmail: 'a@b.com',
      lastSignIn: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
      fcmTokens: { 'device-fixed-1': 'tok' },
    };
    const { result } = renderHook(() => useIsThisDeviceSubscribed(entry), { wrapper: Wrapper });
    expect(result.current).toBe(true);
  });
});

describe('getNewRequestPref', () => {
  it('returns false when prefs absent', () => {
    expect(getNewRequestPref(undefined)).toBe(false);
  });

  it('reads the nested boolean', () => {
    const entry: UserIndexEntry = {
      uid: 'u',
      typedEmail: 'a@b.com',
      lastSignIn: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
      notificationPrefs: { push: { newRequest: true } },
    };
    expect(getNewRequestPref(entry)).toBe(true);
  });
});

describe('useEnablePushMutation', () => {
  it('writes deviceId-keyed token + flips pref to true on success', async () => {
    localStorage.setItem('kindoo:fcmDeviceId', 'device-stable-1');
    const { result } = renderHook(() => useEnablePushMutation(), { wrapper: Wrapper });

    let outcome: 'granted' | 'denied' | undefined;
    await act(async () => {
      outcome = await result.current.mutateAsync();
    });
    expect(outcome).toBe('granted');

    // Token registration was called with the vapid key only —
    // letting the FCM SDK auto-register the baked-in SW. A
    // `serviceWorkerRegistration` arg here would re-introduce the
    // bare-vs-parameterized URL mismatch that broke deleteToken in
    // staging.
    expect(getTokenMock).toHaveBeenCalledTimes(1);
    expect(getTokenMock.mock.calls[0]?.[1]).toEqual({ vapidKey: 'test-vapid-key' });
    expect(getTokenMock.mock.calls[0]?.[1]).not.toHaveProperty('serviceWorkerRegistration');

    // userIndex write carried the deviceId-keyed token + newRequest=true.
    expect(setDocMock).toHaveBeenCalledTimes(1);
    const writtenBody = setDocMock.mock.calls[0]?.[1] as {
      fcmTokens: Record<string, string>;
      notificationPrefs: { push: { newRequest: boolean } };
    };
    expect(writtenBody.fcmTokens).toEqual({ 'device-stable-1': 'fcm-token-aaa' });
    expect(writtenBody.notificationPrefs.push.newRequest).toBe(true);
  });

  it('returns "denied" without writing when the user blocks the prompt', async () => {
    (globalThis as { Notification?: unknown }).Notification = {
      requestPermission: () => Promise.resolve('denied' as NotificationPermission),
      permission: 'default',
    };
    const { result } = renderHook(() => useEnablePushMutation(), { wrapper: Wrapper });

    let outcome: 'granted' | 'denied' | undefined;
    await act(async () => {
      outcome = await result.current.mutateAsync();
    });
    expect(outcome).toBe('denied');
    expect(setDocMock).not.toHaveBeenCalled();
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it('throws a clear error when the VAPID key is unset', async () => {
    vi.stubEnv('VITE_FCM_VAPID_PUBLIC_KEY', '');
    const { result } = renderHook(() => useEnablePushMutation(), { wrapper: Wrapper });

    await expect(
      act(async () => {
        await result.current.mutateAsync();
      }),
    ).rejects.toThrow(/VAPID key not configured/);
    expect(setDocMock).not.toHaveBeenCalled();
  });
});

describe('useDisablePushMutation', () => {
  it('removes the deviceId slot via deleteField and flips pref to false', async () => {
    localStorage.setItem('kindoo:fcmDeviceId', 'device-stable-1');
    const { result } = renderHook(() => useDisablePushMutation(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(deleteTokenMock).toHaveBeenCalledTimes(1);
    expect(setDocMock).toHaveBeenCalledTimes(1);
    const writtenBody = setDocMock.mock.calls[0]?.[1] as {
      fcmTokens: Record<string, unknown>;
      notificationPrefs: { push: { newRequest: boolean } };
    };
    expect(writtenBody.fcmTokens['device-stable-1']).toBe(deleteFieldSentinel);
    expect(writtenBody.notificationPrefs.push.newRequest).toBe(false);
  });

  it('still writes the userIndex update when the SDK deleteToken throws', async () => {
    deleteTokenMock.mockRejectedValueOnce(new Error('no token'));
    const { result } = renderHook(() => useDisablePushMutation(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(setDocMock).toHaveBeenCalledTimes(1);
  });
});

describe('useUpdateNewRequestPrefMutation', () => {
  it('writes only the pref slot, leaving fcmTokens untouched', async () => {
    const { result } = renderHook(() => useUpdateNewRequestPrefMutation(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync(false);
    });
    expect(setDocMock).toHaveBeenCalledTimes(1);
    const writtenBody = setDocMock.mock.calls[0]?.[1] as {
      notificationPrefs: { push: { newRequest: boolean } };
      fcmTokens?: unknown;
    };
    expect(writtenBody.notificationPrefs.push.newRequest).toBe(false);
    expect(writtenBody.fcmTokens).toBeUndefined();
  });
});
