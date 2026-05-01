// Online/offline status hook. Reads `navigator.onLine` initially and
// subscribes to `online` / `offline` window events. Used by the topbar
// offline indicator.
//
// `navigator.onLine` is best-effort — it reports whether the OS-level
// network interface is up, not whether the network actually reaches
// Firestore. A user on captive-portal wifi will read as online here but
// fail every Firestore read. The Firestore SDK's own offline detection
// covers that case (queued writes, cached reads); this hook is purely
// for the topbar chrome.

import { useEffect, useState } from 'react';

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    const onUp = () => setOnline(true);
    const onDown = () => setOnline(false);
    window.addEventListener('online', onUp);
    window.addEventListener('offline', onDown);
    return () => {
      window.removeEventListener('online', onUp);
      window.removeEventListener('offline', onDown);
    };
  }, []);

  return online;
}
