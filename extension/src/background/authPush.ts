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
import { readManagerStakes, subscribeAuthState } from '../lib/auth';
import type { AuthStateChangedPush, PrincipalSnapshot } from '../lib/messaging';

async function toPrincipalSnapshot(user: User): Promise<PrincipalSnapshot> {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    managerStakes: await readManagerStakes(user),
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
    if (user) {
      void toPrincipalSnapshot(user).then((snapshot) => {
        broadcast({
          type: 'auth.stateChanged',
          state: { status: 'signed-in', user: snapshot },
        });
      });
      return;
    }
    broadcast({ type: 'auth.stateChanged', state: { status: 'signed-out' } });
  });
}
