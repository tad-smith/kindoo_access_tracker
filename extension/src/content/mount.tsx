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
//   - The `.sba-handle` pill tab — the primary affordance. It lives
//     INSIDE `.sba-slideover`, overhanging the panel's left edge, so
//     the panel's existing open / closed transform carries it: closed,
//     it lands flush against the viewport's right edge; open, it parks
//     just outside the panel. One transform, one animation, no
//     separate positioning logic.
//   - The toolbar action click (SW → CS `panel.togglePushedFromSw`)
//
// The handle also carries a pending-request count badge. React cannot
// reach it (it is container-layer markup outside the React root), so
// `App` reports the count through `onPendingCountChange` and we mirror
// it onto a `data-sba-count` host attribute — same pattern as
// `data-sba-open`. CSS hides the badge when the attribute is absent
// (count unknown) or zero.
//
// Initial open state is read from chrome.storage.local
// (`sba.panelOpen`). On the very first page visit the value is
// undefined; default to CLOSED so we never appear unsolicited on a
// Kindoo Manager's Kindoo page.

import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '../panel/App';
import { STORAGE_KEYS } from '../lib/messaging';
import panelCss from '../panel/panel.css?inline';
import containerCss from './container.css?inline';

const HOST_ELEMENT_ID = 'sba-extension-root';

export interface PanelHandles {
  host: HTMLElement;
  setOpen: (next: boolean) => void;
  isOpen: () => boolean;
  /**
   * Mirrors the pending-request count onto the handle's badge. `null`
   * clears it — the count is unknown (signed out, not authorized,
   * unconfigured, fetch failed), which is distinct from a known zero
   * only in intent; both render no badge.
   */
  setPendingCount: (count: number | null) => void;
  /**
   * Teardown: unmounts the React root, removes the runtime listener,
   * and removes the host element from the DOM. Production callers
   * (`content-script.ts`) do not invoke this — the panel lives for
   * the lifetime of the page. Tests call it in `afterEach` to drain
   * React's scheduler before jsdom is torn down (B-13: deferred
   * `performWorkOnRootViaSchedulerTask` after teardown surfaces as
   * "window is not defined" unhandled errors).
   */
  unmount: () => void;
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

  // The chevron glyph is driven entirely from CSS off `data-sba-open`
  // (‹ when closed, › when open) so nothing here toggles text.
  const handleBtn = document.createElement('button');
  handleBtn.type = 'button';
  handleBtn.className = 'sba-handle';
  handleBtn.setAttribute('data-testid', 'sba-handle');

  const handleChevron = document.createElement('span');
  handleChevron.className = 'sba-handle-chevron';
  handleChevron.setAttribute('aria-hidden', 'true');
  handleBtn.appendChild(handleChevron);

  const handleText = document.createElement('span');
  handleText.className = 'sba-handle-text';
  handleText.textContent = 'SBA';
  handleBtn.appendChild(handleText);

  // aria-hidden: the button's aria-label is its accessible name, so
  // this text would never be announced anyway. Marking it explicit
  // keeps the intent honest.
  const handleBadge = document.createElement('span');
  handleBadge.className = 'sba-handle-badge';
  handleBadge.setAttribute('aria-hidden', 'true');
  handleBadge.setAttribute('data-testid', 'sba-handle-badge');
  handleBtn.appendChild(handleBadge);

  panelContainer.appendChild(handleBtn);

  const reactRoot = document.createElement('div');
  reactRoot.className = 'sba-slideover-root';
  panelContainer.appendChild(reactRoot);

  const root: Root = createRoot(reactRoot);

  /** Single writer for every open/closed-derived attribute. */
  function applyOpenState(next: boolean): void {
    host.setAttribute('data-sba-open', next ? 'true' : 'false');
    handleBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
    handleBtn.setAttribute(
      'aria-label',
      next ? 'Close Stake Building Access panel' : 'Open Stake Building Access panel',
    );
  }

  applyOpenState(false);

  const messageListener = (msg: unknown) => {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { type?: unknown };
    if (m.type === 'panel.togglePushedFromSw') {
      handles.setOpen(!handles.isOpen());
    }
  };

  const handles: PanelHandles = {
    host,
    setOpen(next) {
      applyOpenState(next);
      chrome.storage?.local?.set({ [STORAGE_KEYS.panelOpen]: next }).catch(() => undefined);
    },
    isOpen() {
      return host.getAttribute('data-sba-open') === 'true';
    },
    setPendingCount(count) {
      if (count === null) {
        host.removeAttribute('data-sba-count');
        handleBadge.textContent = '';
        return;
      }
      host.setAttribute('data-sba-count', String(count));
      handleBadge.textContent = count === 0 ? '' : String(count);
    },
    unmount() {
      chrome.runtime?.onMessage?.removeListener(messageListener);
      root.unmount();
      host.remove();
    },
  };

  // Rendered after `handles` exists: the callback below closes over it,
  // and React may flush the first render synchronously.
  root.render(
    <StrictMode>
      <App onPendingCountChange={(count) => handles.setPendingCount(count)} />
    </StrictMode>,
  );

  handleBtn.addEventListener('click', () => handles.setOpen(!handles.isOpen()));

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
  chrome.runtime?.onMessage?.addListener(messageListener);

  return handles;
}
