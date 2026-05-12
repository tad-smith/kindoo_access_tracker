// Service worker entry. Owns Firebase Auth state + callable
// invocations on behalf of the content-script panel.
//
// Content scripts cannot call chrome.identity directly, and we keep
// the Firebase SDK out of the content-script bundle to limit what
// runs in the Kindoo page context. The content script asks via
// chrome.runtime.sendMessage and renders the response.
//
// MV3 service workers are NOT long-lived; they spin up on demand and
// suspend after a few minutes of idle. Mutable state must be either
// reconstructible (Firebase Auth re-hydrates from IndexedDB) or
// persisted via chrome.storage. The action-button toggle state lives
// in chrome.storage.local.

import { registerActionToggle } from './actionToggle';
import { registerMessageHandlers } from './messages';
import { registerAuthStatePush } from './authPush';

registerActionToggle();
registerMessageHandlers();
registerAuthStatePush();

export {};
