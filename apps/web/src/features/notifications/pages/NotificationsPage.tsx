// Notifications page. Wraps the device-level Push Notifications panel
// in the standard page chrome. Role-agnostic at the component level —
// the route file owns the gate so this page can be expanded later
// (Phase 9 will add per-event push categories visible to bishopric +
// stake users when completed/rejected/cancelled push lands).

import { PushNotificationsPanel } from '../components/PushNotificationsPanel';

export function NotificationsPage() {
  return (
    <section className="kd-page-medium">
      <h1>Notifications</h1>
      <p className="kd-page-subtitle">
        Manage push notifications for this device. Per-device — enable on each browser or phone you
        want to be notified on.
      </p>
      <PushNotificationsPanel />
    </section>
  );
}
