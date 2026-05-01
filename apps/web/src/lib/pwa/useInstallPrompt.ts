// PWA install-prompt hook. Captures the deferred `beforeinstallprompt`
// event so the UI can surface its own "Install" affordance instead of
// the browser's auto-banner (which Chrome suppresses anyway after
// dismissal).
//
// The event interface is non-standard (Chrome/Edge only); Safari and
// Firefox don't fire it. Components consuming this hook should treat
// `canInstall === false` as "don't render the affordance," not "the
// browser doesn't support PWA install" — Safari users install via the
// Share sheet, which we can't trigger programmatically.

import { useCallback, useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export interface InstallPromptState {
  canInstall: boolean;
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

export function useInstallPrompt(): InstallPromptState {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const installedHandler = () => {
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', handler);
    window.addEventListener('appinstalled', installedHandler);
    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      window.removeEventListener('appinstalled', installedHandler);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return 'unavailable' as const;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    setDeferred(null);
    return outcome;
  }, [deferred]);

  return { canInstall: deferred !== null, promptInstall };
}
