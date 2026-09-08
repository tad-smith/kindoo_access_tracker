// SPIKE — coverage for the one piece of the offscreen probe that has
// real branching: deciding whether to create the document, and not
// mistaking a lost create race for a failure.
//
// The offscreen document itself (`src/offscreen/main.ts`) is untested on
// purpose — it is wiring against a live Firebase Auth session and a live
// Firestore listener, and a mocked version of that would assert the
// mock rather than the behaviour the spike exists to measure.
//
// The chrome.offscreen / chrome.runtime.getContexts stubs are installed
// here rather than in test/setup.ts so the shared setup stays exactly as
// it is on main.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFSCREEN_DOCUMENT_PATH, OFFSCREEN_REASON } from '../lib/spike';
import { ensureOffscreenDocument, registerOffscreenSpike } from './offscreenSpike';

interface ChromeStubs {
  createDocument: ReturnType<typeof vi.fn>;
  getContexts: ReturnType<typeof vi.fn>;
  addListener: ReturnType<typeof vi.fn>;
}

function installChromeStubs(options?: { withOffscreen?: boolean }): ChromeStubs {
  const createDocument = vi.fn(() => Promise.resolve());
  const getContexts = vi.fn(() => Promise.resolve([] as unknown[]));
  const addListener = vi.fn();
  const chromeGlobal = globalThis.chrome as unknown as Record<string, unknown>;
  chromeGlobal.offscreen = options?.withOffscreen === false ? undefined : { createDocument };
  chromeGlobal.runtime = {
    ...(chromeGlobal.runtime as Record<string, unknown>),
    getContexts,
    getURL: (path: string) => `chrome-extension://test/${path}`,
    onMessage: { addListener, removeListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
  };
  return { createDocument, getContexts, addListener };
}

describe('ensureOffscreenDocument', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reports unavailable when chrome.offscreen is missing', async () => {
    installChromeStubs({ withOffscreen: false });
    await expect(ensureOffscreenDocument()).resolves.toBe('unavailable');
  });

  it('does not create a second document when one is already up', async () => {
    const stubs = installChromeStubs();
    stubs.getContexts.mockResolvedValue([{ contextType: 'OFFSCREEN_DOCUMENT' }]);
    await expect(ensureOffscreenDocument()).resolves.toBe('existing');
    expect(stubs.createDocument).not.toHaveBeenCalled();
  });

  it('creates the document with the spike reason and path', async () => {
    const stubs = installChromeStubs();
    await expect(ensureOffscreenDocument()).resolves.toBe('created');
    expect(stubs.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: [OFFSCREEN_REASON],
        justification: expect.stringContaining('XMLHttpRequest'),
      }),
    );
  });

  it('scopes the getContexts probe to this extension offscreen document', async () => {
    const stubs = installChromeStubs();
    await ensureOffscreenDocument();
    expect(stubs.getContexts).toHaveBeenCalledWith({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [`chrome-extension://test/${OFFSCREEN_DOCUMENT_PATH}`],
    });
  });

  it('treats a lost create race as success, not failure', async () => {
    const stubs = installChromeStubs();
    stubs.createDocument.mockRejectedValue(
      new Error('Only a single offscreen document may be created.'),
    );
    await expect(ensureOffscreenDocument()).resolves.toBe('existing');
  });

  it('reports a genuine create rejection as failed', async () => {
    const stubs = installChromeStubs();
    stubs.createDocument.mockRejectedValue(new Error('Invalid reason'));
    await expect(ensureOffscreenDocument()).resolves.toBe('failed');
  });

  it('clears its in-flight guard so a later wake can retry', async () => {
    const stubs = installChromeStubs();
    stubs.createDocument.mockRejectedValueOnce(new Error('Invalid reason'));
    await expect(ensureOffscreenDocument()).resolves.toBe('failed');
    await expect(ensureOffscreenDocument()).resolves.toBe('created');
    expect(stubs.createDocument).toHaveBeenCalledTimes(2);
  });
});

describe('registerOffscreenSpike', () => {
  it('never answers a message it does not own', () => {
    // Two listeners racing to respond to one message is a bug where the
    // faster one silently wins, and background/messages.ts already
    // answers everything carrying a string `type`.
    const stubs = installChromeStubs();
    registerOffscreenSpike();
    const listener = stubs.addListener.mock.calls[0]?.[0] as (
      message: unknown,
      sender: unknown,
      sendResponse: (value: unknown) => void,
    ) => unknown;
    const sendResponse = vi.fn();

    expect(listener({ type: 'auth.getState' }, {}, sendResponse)).toBeUndefined();
    expect(
      listener(
        { type: 'spike.offscreen.snapshot', event: { at: '', ctx: 'offscreen', kind: 'x' } },
        {},
        sendResponse,
      ),
    ).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
