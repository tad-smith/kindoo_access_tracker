// chrome.runtime.onMessage dispatch for the SW. The content-script
// panel sends one of the requests declared in `lib/messaging.ts`;
// this module routes to auth or callable handlers and replies.
//
// Sync-vs-async note: chrome.runtime.onMessage listeners return
// `true` to indicate that `sendResponse` will be called
// asynchronously. We always go async (auth + callable invocations
// resolve via Promises) so the listener returns `true`
// unconditionally for known message types.

import {
  signIn,
  signOut,
  currentUser,
  readManagerStakes,
  waitForAuthHydrated,
  AuthError,
} from '../lib/auth';
import { getMyPendingRequests, markRequestComplete, syncApplyFix } from '../lib/api';
import {
  loadSeatByEmail,
  loadStakeConfig,
  loadSyncData,
  resolveEidStakes,
  writeKindooConfig,
  writeKindooSiteEid,
} from './data';
import type {
  AuthSnapshot,
  ExtensionRequest,
  PrincipalSnapshot,
  WireError,
} from '../lib/messaging';
import type { User } from 'firebase/auth/web-extension';

/** Reduce a Firebase User to the slim cross-boundary shape. The panel
 * does not consume claims directly — the SW re-reads them on every
 * `data.resolveEidStakes` to avoid staleness windows across the
 * SW <-> CS boundary. */
function toPrincipalSnapshot(user: User): PrincipalSnapshot {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
  };
}

/** Synchronous auth-state snapshot from the SDK. */
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
        const state: AuthSnapshot = {
          status: 'signed-in',
          user: toPrincipalSnapshot(user),
        };
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
        const data = await loadStakeConfig(req.stakeId);
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
        await writeKindooConfig(req.stakeId, req.payload, user);
        return { ok: true, data: { ok: true } };
      } catch (err) {
        return { ok: false, error: toWireError(err) };
      }
    }
    case 'data.getSeatByEmail': {
      try {
        const seat = await loadSeatByEmail(req.stakeId, req.canonical);
        return { ok: true, data: seat };
      } catch (err) {
        return { ok: false, error: toWireError(err) };
      }
    }
    case 'data.getSyncData': {
      try {
        const data = await loadSyncData(req.stakeId);
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: toWireError(err) };
      }
    }
    case 'data.syncApplyFix': {
      try {
        const data = await syncApplyFix(req.payload);
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: toWireError(err) };
      }
    }
    case 'data.writeKindooSiteEid': {
      try {
        const user = currentUser();
        if (!user) {
          return {
            ok: false,
            error: { code: 'unauthenticated', message: 'sign in before writing site eid' },
          };
        }
        await writeKindooSiteEid(
          req.stakeId,
          req.payload.kindooSiteId,
          req.payload.kindooEid,
          user,
        );
        return { ok: true, data: { ok: true } };
      } catch (err) {
        return { ok: false, error: toWireError(err) };
      }
    }
    case 'data.resolveEidStakes': {
      try {
        // Wait for Firebase Auth to hydrate before reading currentUser().
        // On SW cold-start (idle suspension → wake on the CS's retry
        // click), `currentUser()` is null until the SDK rehydrates from
        // IndexedDB. Without this gate the resolver would surface
        // `managedStakeCount: 0` and route the panel to NotAuthorized —
        // a no-retry dead end for a still-signed-in operator. Matches
        // the `auth.getState` handler's pattern above.
        await waitForAuthHydrated();
        const user = currentUser();
        if (!user) {
          // Truly signed out (the CS would not normally call this, but
          // we surface an unauthenticated wire error rather than
          // `managedStakeCount: 0` so the panel routes to wire-error
          // /retry — not NotAuthorized.
          return {
            ok: false,
            error: { code: 'unauthenticated', message: 'sign in before resolving stakes' },
          };
        }
        // `readManagerStakes` propagates token-refresh failures so the
        // panel can surface a wire-error recovery state. The resolver
        // returns `{ candidates, failedStakes }` so the panel can
        // distinguish:
        //   - `managedStakeCount === 0` → NotAuthorized
        //   - `partialFailure && candidates.length === 0` → wire-error
        //     (every per-stake read threw — transient outage)
        //   - `partialFailure && candidates.length >= 1` →
        //     partial-failure banner above the auto-picked / picker
        //     view (T-48)
        //   - `managedStakeCount > 0 && !partialFailure && candidates.length === 0`
        //     → no-candidates (EID not configured under any managed
        //     stake)
        // `partialFailure` is derived from `failedStakes.length > 0`
        // on the wire — App.tsx reads either field interchangeably,
        // but the explicit boolean keeps existing call sites terse.
        const managerStakes = await readManagerStakes(user);
        const { candidates, failedStakes } = await resolveEidStakes(req.eid, managerStakes);
        return {
          ok: true,
          data: {
            candidates,
            managedStakeCount: managerStakes.length,
            failedStakes,
            partialFailure: failedStakes.length > 0,
          },
        };
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
