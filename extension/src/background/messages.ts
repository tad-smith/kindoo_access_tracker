// chrome.runtime.onMessage dispatch for the SW. The content-script
// panel sends one of the requests declared in `lib/messaging.ts`;
// this module routes to auth or callable handlers and replies.
//
// Sync-vs-async note: chrome.runtime.onMessage listeners return
// `true` to indicate that `sendResponse` will be called
// asynchronously. We always go async (auth + callable invocations
// resolve via Promises) so the listener returns `true`
// unconditionally for known message types.

import { signIn, signOut, currentUser, waitForAuthHydrated, AuthError } from '../lib/auth';
import { getMyPendingRequests, markRequestComplete } from '../lib/api';
import { loadStakeConfig, writeKindooConfig } from './data';
import type {
  AuthSnapshot,
  ExtensionRequest,
  PrincipalSnapshot,
  WireError,
} from '../lib/messaging';
import type { User } from 'firebase/auth/web-extension';

/** Reduce a Firebase User to the slim cross-boundary shape. */
function toPrincipalSnapshot(user: User): PrincipalSnapshot {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
  };
}

/** Synchronous (no IDB read) auth-state snapshot from the SDK. */
function snapshotAuthState(): AuthSnapshot {
  const user = currentUser();
  if (!user) return { status: 'signed-out' };
  return { status: 'signed-in', user: toPrincipalSnapshot(user) };
}

/** Translate any error into the wire shape. */
function toWireError(err: unknown): WireError {
  if (err instanceof AuthError) {
    return { code: err.code, message: err.message };
  }
  if (typeof err === 'object' && err !== null) {
    const e = err as { code?: unknown; message?: unknown };
    const code = typeof e.code === 'string' ? e.code : 'unknown';
    const message = typeof e.message === 'string' ? e.message : String(err);
    return { code, message };
  }
  return { code: 'unknown', message: String(err) };
}

/**
 * Resolve the result for a single ExtensionRequest. Exported for
 * unit testing — the chrome.runtime.onMessage wrapper is registered
 * in `registerMessageHandlers`.
 */
export async function handleRequest(req: ExtensionRequest): Promise<unknown> {
  switch (req.type) {
    case 'auth.getState': {
      // Wait for the Firebase SDK to hydrate persisted state before
      // answering; otherwise on SW revive we would reply
      // `'signed-out'` to a still-valid session.
      await waitForAuthHydrated();
      return { ok: true, data: snapshotAuthState() };
    }
    case 'auth.signIn': {
      try {
        const user = await signIn();
        const state: AuthSnapshot = { status: 'signed-in', user: toPrincipalSnapshot(user) };
        return { ok: true, data: state };
      } catch (err) {
        return { ok: false, error: toWireError(err) };
      }
    }
    case 'auth.signOut': {
      try {
        await signOut();
        return { ok: true, data: { done: true } };
      } catch (err) {
        return { ok: false, error: toWireError(err) };
      }
    }
    case 'api.getMyPendingRequests': {
      try {
        const data = await getMyPendingRequests(req.payload);
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: toWireError(err) };
      }
    }
    case 'api.markRequestComplete': {
      try {
        const data = await markRequestComplete(req.payload);
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: toWireError(err) };
      }
    }
    case 'panel.togglePushedFromSw': {
      // Reserved for future SW → CS toggle pokes (e.g. from an
      // action-click). The CS-driven toggle does not round-trip
      // through the SW; this branch exists so the discriminated
      // union compiles to a real handler.
      return { ok: true, data: { done: true } };
    }
    case 'data.getStakeConfig': {
      try {
        const data = await loadStakeConfig();
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: toWireError(err) };
      }
    }
    case 'data.writeKindooConfig': {
      try {
        const user = currentUser();
        if (!user) {
          return {
            ok: false,
            error: { code: 'unauthenticated', message: 'sign in before saving config' },
          };
        }
        await writeKindooConfig(req.payload, user);
        return { ok: true, data: { ok: true } };
      } catch (err) {
        return { ok: false, error: toWireError(err) };
      }
    }
  }
}

function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { type?: unknown };
  return typeof v.type === 'string';
}

/**
 * Install the chrome.runtime.onMessage handler that routes every
 * supported request through `handleRequest`. Returns the listener
 * for tests that want to drive it directly.
 */
export function registerMessageHandlers(): (
  request: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean {
  const listener = (
    request: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    if (!isExtensionRequest(request)) {
      sendResponse({ ok: false, error: { code: 'bad-request', message: 'unknown message type' } });
      return false;
    }
    handleRequest(request)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: toWireError(err) }));
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return listener;
}
