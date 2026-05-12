// Action-button (toolbar icon) click → toggle the content-script
// panel on the current tab.
//
// We post a `panel.togglePushedFromSw` message to the active tab and
// let the content script's listener flip its open/closed state. The
// CS owns the actual visibility — the SW does not need to know
// whether the panel is currently rendered.
//
// Tabs without an active content script (the user is on a non-Kindoo
// tab) silently drop the message. That is the correct UX: clicking
// the toolbar icon on a non-Kindoo page does nothing rather than
// surfacing an error.

import type { PanelTogglePushRequest } from '../lib/messaging';

export function registerActionToggle(): void {
  chrome.action.onClicked.addListener((tab) => {
    if (typeof tab.id !== 'number') return;
    const msg: PanelTogglePushRequest = { type: 'panel.togglePushedFromSw' };
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {
      // Receiving end does not exist — non-Kindoo tab. Silent no-op.
    });
  });
}
