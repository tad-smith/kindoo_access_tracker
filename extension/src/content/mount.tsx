// Shadow-DOM mount for the SBA helper panel.
//
// Why Shadow DOM: Kindoo's page CSS is unknown. Mounting React
// directly into the page tree would expose the panel to whatever
// resets / layout rules Kindoo applies to descendants of body. The
// Shadow DOM gives us a sealed style scope.
//
// Layout: a fixed-position slide-over anchored to the right edge,
// 400px wide, full-height. Open / closed is a boolean attribute on
// the host element. Toggled by:
//   - The toolbar action click (SW → CS `panel.togglePushedFromSw`)
//   - A close button inside the panel itself
//
// Initial open state is read from chrome.storage.local
// (`sba.panelOpen`). On the very first page visit the value is
// undefined; default to CLOSED so we never appear unsolicited on a
// Kindoo Manager's Kindoo page.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../panel/App';
import { STORAGE_KEYS } from '../lib/messaging';
import panelCss from '../panel/panel.css?inline';
import containerCss from './container.css?inline';

const HOST_ELEMENT_ID = 'sba-extension-root';

interface PanelHandles {
  host: HTMLElement;
  setOpen: (next: boolean) => void;
  isOpen: () => boolean;
}

export function mountPanel(): PanelHandles | null {
  // Defensive: if the SPA navigated and we are re-injected, do not
  // double-mount.
  const existing = document.getElementById(HOST_ELEMENT_ID);
  if (existing) {
    return null;
  }

  const host = document.createElement('div');
  host.id = HOST_ELEMENT_ID;
  host.setAttribute('data-sba-open', 'false');
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  const styleContainer = document.createElement('style');
  styleContainer.textContent = containerCss;
  shadow.appendChild(styleContainer);

  const stylePanel = document.createElement('style');
  stylePanel.textContent = panelCss;
  shadow.appendChild(stylePanel);

  const panelContainer = document.createElement('div');
  panelContainer.className = 'sba-slideover';
  shadow.appendChild(panelContainer);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'sba-slideover-close';
  closeBtn.setAttribute('aria-label', 'Close SBA helper');
  closeBtn.textContent = '×';
  panelContainer.appendChild(closeBtn);

  const reactRoot = document.createElement('div');
  reactRoot.className = 'sba-slideover-root';
  panelContainer.appendChild(reactRoot);

  createRoot(reactRoot).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  const handles: PanelHandles = {
    host,
    setOpen(next) {
      host.setAttribute('data-sba-open', next ? 'true' : 'false');
      chrome.storage?.local?.set({ [STORAGE_KEYS.panelOpen]: next }).catch(() => undefined);
    },
    isOpen() {
      return host.getAttribute('data-sba-open') === 'true';
    },
  };

  closeBtn.addEventListener('click', () => handles.setOpen(false));

  // Restore the previously-persisted open state. Default to closed.
  chrome.storage?.local
    ?.get([STORAGE_KEYS.panelOpen])
    .then((result) => {
      const value = result?.[STORAGE_KEYS.panelOpen];
      if (value === true) handles.setOpen(true);
    })
    .catch(() => undefined);

  // Toolbar-action toggle: the SW posts this when the user clicks
  // the extension icon. Flip the slide-over open / closed.
  chrome.runtime?.onMessage?.addListener((msg: unknown) => {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { type?: unknown };
    if (m.type === 'panel.togglePushedFromSw') {
      handles.setOpen(!handles.isOpen());
    }
  });

  return handles;
}
