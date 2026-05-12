// Service worker entry. Currently a stub — wires the action button to
// open the side panel and reserves a message channel for future
// background work (e.g., periodic polling, badge updates).
//
// MV3 service workers are NOT long-lived; they spin up on demand and
// suspend after a few minutes of idle. Don't hold mutable in-memory
// state here — persist via chrome.storage.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => {
      console.error('[sba-ext] setPanelBehavior failed', err);
    });
});

export {};
