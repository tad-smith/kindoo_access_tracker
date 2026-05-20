// Broadcast Firebase Auth state changes to every content-script
// panel. The panel subscribes via chrome.runtime.onMessage and
// re-renders without needing to poll.
//
// We iterate `chrome.tabs.query` for tabs matching Kindoo
// (`host_permissions`) and dispatch `chrome.tabs.sendMessage` per
// tab. Tabs without an active content script throw "Could not
// establish connection. Receiving end does not exist."; we swallow
// that — it just means the user is not on a Kindoo page right now.

import type { User } from 'firebase/auth/web-extension';
import { subscribeAuthState } from '../lib/auth';
import type { AuthStateChangedPush, PrincipalSnapshot } from '../lib/messaging';

/** Synchronous projection of the Firebase User to the wire shape. No
 * claims read here — the panel does not consume them; the SW re-reads
 * on every `data.resolveEidStakes` to avoid staleness. Keeping this
 * synchronous also blocks the previous-iteration reorder race where a
 * sign-out broadcast could overtake a still-in-flight sign-in's
 * claims-read promise. */
function toPrincipalSnapshot(user: User): PrincipalSnapshot {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
  };
}

function broadcast(push: AuthStateChangedPush): void {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue;
      chrome.tabs.sendMessage(tab.id, push).catch(() => {
        // No CS listening on this tab — expected for non-Kindoo tabs.
      });
    }
  });
}

export function registerAuthStatePush(): () => void {
  return subscribeAuthState((user) => {
    const push: AuthStateChangedPush = user
      ? {
          type: 'auth.stateChanged',
          state: { status: 'signed-in', user: toPrincipalSnapshot(user) },
        }
      : { type: 'auth.stateChanged', state: { status: 'signed-out' } };
    broadcast(push);
  });
}
