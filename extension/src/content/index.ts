// Content script. Injected into every Kindoo page per the manifest's
// `content_scripts.matches`. Mounts the SBA helper panel inside a
// Shadow DOM so SBA styles do not leak into Kindoo (and vice versa).
//
// Wiring:
//   - On load: create a `<div id="sba-extension-root">` on
//     document.body, attachShadow({ mode: 'open' }), inject the
//     panel CSS, mount React.
//   - Listen for `panel.togglePushedFromSw` to flip the slide-over
//     open / closed.
//   - Persist the open / closed state in chrome.storage.local so it
//     survives Kindoo's SPA navigations + page reloads.
//
// We import React + the panel app via dynamic `import()` from the
// React entry below to keep the synchronous CS bundle small. @crxjs
// resolves the dynamic import paths into separate chunks at build
// time.

import { mountPanel } from './mount';

mountPanel();

export {};
