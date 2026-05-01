// Install affordance. Visible only when the browser has fired
// `beforeinstallprompt` (Chromium / Edge); hidden on Safari + Firefox
// because they don't support programmatic install. Dismissal is per-
// session — `beforeinstallprompt` doesn't refire after a dismiss until
// the user reloads, so there's no "nag" loop to suppress.

import { useInstallPrompt } from '../../lib/pwa/useInstallPrompt';

export function PwaInstallButton() {
  const { canInstall, promptInstall } = useInstallPrompt();

  if (!canInstall) return null;

  return (
    <button
      type="button"
      className="btn btn-secondary kd-pwa-install"
      onClick={() => {
        void promptInstall();
      }}
    >
      Install
    </button>
  );
}
