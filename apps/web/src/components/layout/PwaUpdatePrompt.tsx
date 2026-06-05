// PWA update prompt. Mounts a non-blocking inline strip above the main
// content area when the service worker has a new version waiting.
// Critical against the cache-first shell strategy — without this users
// stay on the stale shell forever after a deploy.
//
// Single-action by design: only "Update now". There is no "Later" /
// dismiss affordance — the prompt persists until the user updates, which
// is the intent (a stale bundle can resolve removed fields and show wrong
// data, so we never let the user defer indefinitely). Tapping the action
// drives an SW skip-waiting + page reload via `sw.update()`.

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
          Update now
        </button>
      </div>
    </div>
  );
}
