// Unit tests for the content-script Shadow-DOM mount.
//
// The Shadow DOM container, the slide-over toggle, and the
// chrome.runtime / chrome.storage hooks are exercised. The React app
// itself is mocked so the test stays focused on the wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../panel/App', () => ({
  App: () => null,
}));

interface ChromeStub {
  storage: {
    local: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
  };
  runtime: {
    onMessage: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
    lastError: { message: string } | undefined;
  };
}

function chromeStub(): ChromeStub {
  return globalThis.chrome as unknown as ChromeStub;
}

function lastMessageListener(): (msg: unknown) => void {
  const calls = chromeStub().runtime.onMessage.addListener.mock.calls;
  const last = calls[calls.length - 1];
  return last?.[0] as (msg: unknown) => void;
}

describe('mountPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    chromeStub().storage.local.get.mockReset();
    chromeStub().storage.local.get.mockResolvedValue({});
    chromeStub().storage.local.set.mockReset();
    chromeStub().storage.local.set.mockResolvedValue(undefined);
    chromeStub().runtime.onMessage.addListener.mockReset();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.resetModules();
  });

  it('mounts a shadow-DOM host on document.body', async () => {
    const { mountPanel } = await import('./mount');
    const handles = mountPanel();
    expect(handles).not.toBeNull();
    const host = document.getElementById('sba-extension-root');
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).not.toBeNull();
    expect(host?.getAttribute('data-sba-open')).toBe('false');
  });

  it('does not double-mount if a host element already exists', async () => {
    const { mountPanel } = await import('./mount');
    const first = mountPanel();
    expect(first).not.toBeNull();
    const second = mountPanel();
    expect(second).toBeNull();
    expect(document.querySelectorAll('#sba-extension-root')).toHaveLength(1);
  });

  it('persists the open state to chrome.storage.local on toggle', async () => {
    const { mountPanel } = await import('./mount');
    const handles = mountPanel();
    handles?.setOpen(true);
    expect(handles?.isOpen()).toBe(true);
    expect(chromeStub().storage.local.set).toHaveBeenCalledWith({ 'sba.panelOpen': true });
  });

  it('restores the open state from chrome.storage on mount', async () => {
    chromeStub().storage.local.get.mockResolvedValue({ 'sba.panelOpen': true });
    const { mountPanel } = await import('./mount');
    const handles = mountPanel();
    // Wait for the chrome.storage.local.get promise chain.
    await new Promise((r) => setTimeout(r, 0));
    expect(handles?.isOpen()).toBe(true);
  });

  it('flips the open state when a panel.togglePushedFromSw message arrives', async () => {
    const { mountPanel } = await import('./mount');
    const handles = mountPanel();
    expect(handles?.isOpen()).toBe(false);
    const listener = lastMessageListener();
    listener({ type: 'panel.togglePushedFromSw' });
    expect(handles?.isOpen()).toBe(true);
    listener({ type: 'panel.togglePushedFromSw' });
    expect(handles?.isOpen()).toBe(false);
  });

  it('ignores unrelated runtime messages', async () => {
    const { mountPanel } = await import('./mount');
    const handles = mountPanel();
    const listener = lastMessageListener();
    listener({ type: 'auth.stateChanged', state: { status: 'signed-out' } });
    expect(handles?.isOpen()).toBe(false);
  });
});
