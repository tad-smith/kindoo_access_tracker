// Component tests for the Push Notifications panel. Exercises every
// render branch: unsupported, requires-install, VAPID-missing,
// permission denied, default (subscribe button), granted+subscribed
// (toggle + disable). Hooks are mocked to keep the test focused on
// rendering.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { UserIndexEntry } from '@kindoo/shared';

const useCurrentUserIndexMock = vi.fn();
const useIsThisDeviceSubscribedMock = vi.fn();
const useEnablePushMutationMock = vi.fn();
const useDisablePushMutationMock = vi.fn();
const useUpdateNewRequestPrefMutationMock = vi.fn();
const pushSupportStatusMock = vi.fn();
const currentPermissionMock = vi.fn();
const getVapidPublicKeyMock = vi.fn();

vi.mock('../hooks', () => ({
  useCurrentUserIndex: () => useCurrentUserIndexMock(),
  useIsThisDeviceSubscribed: (entry: UserIndexEntry | undefined) =>
    useIsThisDeviceSubscribedMock(entry),
  useEnablePushMutation: () => useEnablePushMutationMock(),
  useDisablePushMutation: () => useDisablePushMutationMock(),
  useUpdateNewRequestPrefMutation: () => useUpdateNewRequestPrefMutationMock(),
  getNewRequestPref: (entry: UserIndexEntry | undefined) =>
    entry?.notificationPrefs?.push?.newRequest === true,
}));

vi.mock('../lib', () => ({
  pushSupportStatus: () => pushSupportStatusMock(),
  currentPermission: () => currentPermissionMock(),
  getVapidPublicKey: () => getVapidPublicKeyMock(),
}));

import { PushNotificationsPanel } from '../components/PushNotificationsPanel';

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function liveResult<T>(data: T | undefined) {
  return {
    data,
    error: null,
    status: 'success' as const,
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle' as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pushSupportStatusMock.mockReturnValue('supported');
  currentPermissionMock.mockReturnValue('default');
  getVapidPublicKeyMock.mockReturnValue('test-vapid-key');
  useCurrentUserIndexMock.mockReturnValue(liveResult<UserIndexEntry | undefined>(undefined));
  useIsThisDeviceSubscribedMock.mockReturnValue(false);
  useEnablePushMutationMock.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue('granted'),
    isPending: false,
    isSuccess: false,
  });
  useDisablePushMutationMock.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isSuccess: false,
  });
  useUpdateNewRequestPrefMutationMock.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
  });
});

describe('PushNotificationsPanel', () => {
  it('renders the unsupported message on browsers without Notification API', () => {
    pushSupportStatusMock.mockReturnValue('unsupported');
    render(
      <Wrapper>
        <PushNotificationsPanel />
      </Wrapper>,
    );
    expect(screen.getByTestId('push-unsupported')).toBeInTheDocument();
  });

  it('renders the iOS install instruction when launched outside standalone mode', () => {
    pushSupportStatusMock.mockReturnValue('requires-install');
    render(
      <Wrapper>
        <PushNotificationsPanel />
      </Wrapper>,
    );
    expect(screen.getByTestId('push-requires-install')).toBeInTheDocument();
  });

  it('warns when the VAPID public key is unset in the deploy environment', () => {
    getVapidPublicKeyMock.mockReturnValue(null);
    render(
      <Wrapper>
        <PushNotificationsPanel />
      </Wrapper>,
    );
    expect(screen.getByTestId('push-vapid-missing')).toBeInTheDocument();
  });

  it('shows recovery copy when the user has previously denied permission', () => {
    currentPermissionMock.mockReturnValue('denied');
    render(
      <Wrapper>
        <PushNotificationsPanel />
      </Wrapper>,
    );
    expect(screen.getByTestId('push-denied')).toBeInTheDocument();
  });

  it('shows the Enable button when permission is default and device is unsubscribed', () => {
    currentPermissionMock.mockReturnValue('default');
    render(
      <Wrapper>
        <PushNotificationsPanel />
      </Wrapper>,
    );
    expect(screen.getByTestId('push-enable-button')).toBeInTheDocument();
  });

  it('invokes the enable mutation when the user clicks Enable', async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn().mockResolvedValue('granted');
    useEnablePushMutationMock.mockReturnValue({
      mutateAsync,
      isPending: false,
      isSuccess: false,
    });
    render(
      <Wrapper>
        <PushNotificationsPanel />
      </Wrapper>,
    );
    await user.click(screen.getByTestId('push-enable-button'));
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('shows the toggle + disable controls once subscribed', () => {
    currentPermissionMock.mockReturnValue('granted');
    useIsThisDeviceSubscribedMock.mockReturnValue(true);
    useCurrentUserIndexMock.mockReturnValue(
      liveResult<UserIndexEntry | undefined>({
        uid: 'u1',
        typedEmail: 'mgr@example.com',
        lastSignIn: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
        fcmTokens: { 'device-1': 'token-1' },
        notificationPrefs: { push: { newRequest: true } },
      }),
    );
    render(
      <Wrapper>
        <PushNotificationsPanel />
      </Wrapper>,
    );
    expect(screen.getByTestId('push-subscribed')).toBeInTheDocument();
    const toggle = screen.getByTestId('push-newrequest-toggle');
    expect(toggle).toBeChecked();
    // Regression guard: the new-request toggle is a shadcn Switch
    // (Radix `role="switch"`), not a bare checkbox. Switching back
    // would silently regress the visual treatment.
    expect(toggle).toHaveAttribute('role', 'switch');
    expect(screen.getByTestId('push-disable-button')).toBeInTheDocument();
  });

  it('updates the new-request preference when the toggle is flipped', async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    currentPermissionMock.mockReturnValue('granted');
    useIsThisDeviceSubscribedMock.mockReturnValue(true);
    useCurrentUserIndexMock.mockReturnValue(
      liveResult<UserIndexEntry | undefined>({
        uid: 'u1',
        typedEmail: 'mgr@example.com',
        lastSignIn: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
        fcmTokens: { 'device-1': 'token-1' },
        notificationPrefs: { push: { newRequest: true } },
      }),
    );
    useUpdateNewRequestPrefMutationMock.mockReturnValue({ mutateAsync, isPending: false });
    render(
      <Wrapper>
        <PushNotificationsPanel />
      </Wrapper>,
    );
    await user.click(screen.getByTestId('push-newrequest-toggle'));
    expect(mutateAsync).toHaveBeenCalledWith(false);
  });

  it('invokes the disable mutation when the user clicks Disable on this device', async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    currentPermissionMock.mockReturnValue('granted');
    useIsThisDeviceSubscribedMock.mockReturnValue(true);
    useCurrentUserIndexMock.mockReturnValue(
      liveResult<UserIndexEntry | undefined>({
        uid: 'u1',
        typedEmail: 'mgr@example.com',
        lastSignIn: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
        fcmTokens: { 'device-1': 'token-1' },
        notificationPrefs: { push: { newRequest: true } },
      }),
    );
    useDisablePushMutationMock.mockReturnValue({
      mutateAsync,
      isPending: false,
      isSuccess: false,
    });
    render(
      <Wrapper>
        <PushNotificationsPanel />
      </Wrapper>,
    );
    await user.click(screen.getByTestId('push-disable-button'));
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });
});
