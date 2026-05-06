// Push Notifications panel — lives inside the manager Configuration
// page's Config tab. Renders four states by inspecting the live
// `userIndex` doc and `Notification.permission`:
//
//   1. unsupported / requires-install — flat copy, no controls.
//   2. permission='default' (never asked) — primary "Enable" button.
//   3. permission='denied' — recovery copy ("re-enable in browser
//      settings") with no button (we can't re-prompt after denial).
//   4. permission='granted' — subscription toggle + per-category
//      "New requests" switch (manager-only category in v1).
//
// Manager-only invocation is enforced one level up — the panel renders
// only when the principal holds the manager claim. The hooks
// themselves are role-agnostic (any signed-in user has a userIndex
// doc) but the only category we ship in v1 is manager-relevant.

import { useEffect, useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { Switch } from '../../../components/ui/Switch';
import { toast } from '../../../lib/store/toast';
import {
  getNewRequestPref,
  useCurrentUserIndex,
  useDisablePushMutation,
  useEnablePushMutation,
  useIsThisDeviceSubscribed,
  useUpdateNewRequestPrefMutation,
} from '../hooks';
import { currentPermission, getVapidPublicKey, pushSupportStatus } from '../lib';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function PushNotificationsPanel() {
  const support = pushSupportStatus();
  const userIndex = useCurrentUserIndex();
  const subscribedHere = useIsThisDeviceSubscribed(userIndex.data);
  const newRequestPref = getNewRequestPref(userIndex.data);
  const enable = useEnablePushMutation();
  const disable = useDisablePushMutation();
  const updatePref = useUpdateNewRequestPrefMutation();
  const vapidKey = getVapidPublicKey();

  // `Notification.permission` is not reactive; we read it on mount
  // and refresh after a request resolves so the UI flips state.
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    currentPermission(),
  );
  useEffect(() => {
    setPermission(currentPermission());
  }, [enable.isSuccess, disable.isSuccess]);

  // ---- Static "not available" states ----------------------------------

  if (support === 'unsupported') {
    return (
      <PanelShell>
        <p className="kd-form-hint" data-testid="push-unsupported">
          Push notifications are not supported on this device or browser.
        </p>
      </PanelShell>
    );
  }

  if (support === 'requires-install') {
    return (
      <PanelShell>
        <p className="kd-form-hint" data-testid="push-requires-install">
          On iOS, install Stake Building Access to your Home Screen to enable push notifications.
          Open in Safari → Share → Add to Home Screen.
        </p>
      </PanelShell>
    );
  }

  if (!vapidKey) {
    return (
      <PanelShell>
        <p className="kd-form-hint" data-testid="push-vapid-missing">
          Push notifications are not configured for this site. Contact your administrator.
        </p>
      </PanelShell>
    );
  }

  // ---- Permission-state-driven controls -------------------------------

  if (permission === 'denied') {
    return (
      <PanelShell>
        <p className="kd-form-hint" data-testid="push-denied">
          Push notifications are blocked for this site. To re-enable, open your browser&apos;s site
          settings and allow notifications, then refresh.
        </p>
      </PanelShell>
    );
  }

  if (permission === 'default' || !subscribedHere) {
    return (
      <PanelShell>
        <p className="kd-form-hint">
          Get a push notification when a new access request is submitted. Per-device — enable on
          each browser or phone you want to be notified on.
        </p>
        <div className="form-actions">
          <Button
            type="button"
            disabled={enable.isPending}
            onClick={() => {
              enable
                .mutateAsync()
                .then((outcome) => {
                  if (outcome === 'granted') {
                    toast('Push notifications enabled.', 'success');
                  } else {
                    toast('Permission denied.', 'warn');
                  }
                })
                .catch((err) => toast(errorMessage(err), 'error'));
            }}
            data-testid="push-enable-button"
          >
            {enable.isPending ? 'Enabling…' : 'Enable push notifications'}
          </Button>
        </div>
      </PanelShell>
    );
  }

  // permission === 'granted' AND this device is subscribed.
  return (
    <PanelShell>
      <p className="kd-form-hint" data-testid="push-subscribed">
        This device is subscribed to push notifications.
      </p>
      <label className="kd-switch-label" htmlFor="push-newrequest-toggle">
        <Switch
          id="push-newrequest-toggle"
          checked={newRequestPref}
          disabled={updatePref.isPending}
          onCheckedChange={(next) => {
            updatePref
              .mutateAsync(next)
              .then(() =>
                toast(next ? 'New-request push enabled.' : 'New-request push disabled.', 'success'),
              )
              .catch((err) => toast(errorMessage(err), 'error'));
          }}
          data-testid="push-newrequest-toggle"
        />
        <span>New request notifications</span>
      </label>
      <div className="form-actions">
        <Button
          type="button"
          variant="secondary"
          disabled={disable.isPending}
          onClick={() => {
            disable
              .mutateAsync()
              .then(() => toast('Push notifications disabled on this device.', 'success'))
              .catch((err) => toast(errorMessage(err), 'error'));
          }}
          data-testid="push-disable-button"
        >
          {disable.isPending ? 'Disabling…' : 'Disable on this device'}
        </Button>
      </div>
    </PanelShell>
  );
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="kd-config-section" data-testid="push-notifications-panel">
      <h3>Push Notifications</h3>
      {children}
    </section>
  );
}
