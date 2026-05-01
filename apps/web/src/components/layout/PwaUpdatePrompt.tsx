// PWA update prompt. Mounts a non-blocking inline toast above the main
// content area when the service worker has a new version waiting.
// Critical against the cache-first shell strategy — without this users
// stay on the stale shell forever after a deploy.
//
// Distinct from the generic Toast queue because the message is
// dismiss-on-action, not auto-expire, and tapping the action triggers
// an SW skip-waiting + page reload.

import { useServiceWorker } from '../../lib/pwa/useServiceWorker';
import './PwaUpdatePrompt.css';

export function PwaUpdatePrompt() {
  const sw = useServiceWorker();

  if (!sw.needRefresh) return null;

  return (
    <div className="kd-pwa-update" role="status" aria-live="polite">
      <span className="kd-pwa-update-message">Update available</span>
      <div className="kd-pwa-update-actions">
        <button
          type="button"
          className="btn btn-primary kd-pwa-update-action"
          onClick={() => {
            void sw.update();
          }}
        >
          Refresh
        </button>
        <button
          type="button"
          className="btn btn-secondary kd-pwa-update-dismiss"
          onClick={sw.dismissNeedRefresh}
          aria-label="Dismiss update prompt"
        >
          Later
        </button>
      </div>
    </div>
  );
}
