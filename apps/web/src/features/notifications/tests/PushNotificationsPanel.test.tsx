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
const useUpdatePushPrefMutationMock = vi.fn();
const pushSupportStatusMock = vi.fn();
const currentPermissionMock = vi.fn();
const getVapidPublicKeyMock = vi.fn();

// Type-only import — erased at runtime, so it does not defeat the
// `../hooks` mock below, and it keeps the category union in step with
// the shared schema rather than restating it.
import type { PushCategory } from '../hooks';

vi.mock('../hooks', () => ({
  useCurrentUserIndex: () => useCurrentUserIndexMock(),
  useIsThisDeviceSubscribed: (entry: UserIndexEntry | undefined) =>
    useIsThisDeviceSubscribedMock(entry),
  useEnablePushMutation: () => useEnablePushMutationMock(),
  useDisablePushMutation: () => useDisablePushMutationMock(),
  useUpdatePushPrefMutation: (category: PushCategory) => useUpdatePushPrefMutationMock(category),
  getPushPref: (entry: UserIndexEntry | undefined, category: PushCategory) =>
    entry?.notificationPrefs?.push?.[category] === true,
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

/**
 * One mutation object per category, so a test can assert that flipping
 * one switch left the sibling category's mutation untouched.
 */
let prefMutations: Record<PushCategory, { mutateAsync: ReturnType<typeof vi.fn> }>;

/** A subscribed user's userIndex doc, with the given push prefs. */
function subscribedEntry(push: Partial<Record<PushCategory, boolean>>): UserIndexEntry {
  return {
    uid: 'u1',
    typedEmail: 'mgr@example.com',
    lastSignIn: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
    fcmTokens: { 'device-1': 'token-1' },
    notificationPrefs: { push },
  };
}

/** Put the panel in the granted-and-subscribed state. */
function renderSubscribed(push: Partial<Record<PushCategory, boolean>> = { newRequest: true }) {
  currentPermissionMock.mockReturnValue('granted');
  useIsThisDeviceSubscribedMock.mockReturnValue(true);
  useCurrentUserIndexMock.mockReturnValue(
    liveResult<UserIndexEntry | undefined>(subscribedEntry(push)),
  );
  return render(
    <Wrapper>
      <PushNotificationsPanel />
    </Wrapper>,
  );
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
  prefMutations = {
    newRequest: { mutateAsync: vi.fn().mockResolvedValue(undefined) },
    syncReminder: { mutateAsync: vi.fn().mockResolvedValue(undefined) },
  };
  useUpdatePushPrefMutationMock.mockImplementation((category: PushCategory) => ({
    ...prefMutations[category],
    isPending: false,
  }));
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

  it('shows both category toggles + disable controls once subscribed', () => {
    renderSubscribed({ newRequest: true });
    expect(screen.getByTestId('push-subscribed')).toBeInTheDocument();
    const toggle = screen.getByTestId('push-newrequest-toggle');
    expect(toggle).toBeChecked();
    // Regression guard: the category toggles are shadcn Switches
    // (Radix `role="switch"`), not bare checkboxes. Switching back
    // would silently regress the visual treatment.
    expect(toggle).toHaveAttribute('role', 'switch');
    expect(screen.getByTestId('push-syncreminder-toggle')).toHaveAttribute('role', 'switch');
    expect(screen.getByTestId('push-disable-button')).toBeInTheDocument();
  });

  // Deliberately not "…for expired temp seats": the reminder covers two
  // conditions since T-106, and a label naming one of them reads as a
  // promise that the other will not arrive.
  it('labels the sync-reminder toggle for both conditions it covers', () => {
    renderSubscribed();
    expect(screen.getByText('Sync reminders')).toBeInTheDocument();
  });

  it('updates the new-request preference when its toggle is flipped', async () => {
    const user = userEvent.setup();
    renderSubscribed({ newRequest: true });
    await user.click(screen.getByTestId('push-newrequest-toggle'));
    expect(prefMutations.newRequest.mutateAsync).toHaveBeenCalledWith(false);
  });

  it('leaves the sync-reminder preference alone when the new-request toggle is flipped', async () => {
    const user = userEvent.setup();
    renderSubscribed({ newRequest: true, syncReminder: true });
    await user.click(screen.getByTestId('push-newrequest-toggle'));
    expect(prefMutations.newRequest.mutateAsync).toHaveBeenCalledWith(false);
    expect(prefMutations.syncReminder.mutateAsync).not.toHaveBeenCalled();
  });

  it('shows the sync-reminder toggle off for a manager with no stored preference', () => {
    // Absent key = opted out. A manager already subscribed for new
    // requests does not silently start receiving sync reminders.
    renderSubscribed({ newRequest: true });
    expect(screen.getByTestId('push-syncreminder-toggle')).not.toBeChecked();
  });

  it('shows the sync-reminder toggle on when the manager has opted in', () => {
    renderSubscribed({ newRequest: false, syncReminder: true });
    expect(screen.getByTestId('push-syncreminder-toggle')).toBeChecked();
    expect(screen.getByTestId('push-newrequest-toggle')).not.toBeChecked();
  });

  it('turns the sync-reminder preference on when its toggle is flipped', async () => {
    const user = userEvent.setup();
    renderSubscribed({ newRequest: true });
    await user.click(screen.getByTestId('push-syncreminder-toggle'));
    expect(prefMutations.syncReminder.mutateAsync).toHaveBeenCalledWith(true);
  });

  it('leaves the new-request preference alone when the sync-reminder toggle is flipped', async () => {
    const user = userEvent.setup();
    renderSubscribed({ newRequest: true, syncReminder: true });
    await user.click(screen.getByTestId('push-syncreminder-toggle'));
    expect(prefMutations.syncReminder.mutateAsync).toHaveBeenCalledWith(false);
    expect(prefMutations.newRequest.mutateAsync).not.toHaveBeenCalled();
  });

  // `.kd-switch-label` is inline-flex, so two switches in a plain block
  // container would share a line. They must sit in the stacking wrapper.
  it('stacks both category switches in one container', () => {
    renderSubscribed();
    const group = screen.getByTestId('push-categories');
    expect(group).toContainElement(screen.getByTestId('push-newrequest-toggle'));
    expect(group).toContainElement(screen.getByTestId('push-syncreminder-toggle'));
    expect(group.className).toContain('flex-col');
  });

  it('invokes the disable mutation when the user clicks Disable on this device', async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    useDisablePushMutationMock.mockReturnValue({
      mutateAsync,
      isPending: false,
      isSuccess: false,
    });
    renderSubscribed({ newRequest: true });
    await user.click(screen.getByTestId('push-disable-button'));
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });
});
