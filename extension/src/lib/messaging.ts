// Cross-context message protocol shared by the service worker and the
// content-script panel.
//
// Content scripts CANNOT call chrome.identity or interact directly
// with the Firebase Auth SDK. The service worker owns auth state +
// callable invocations; the content script asks via
// chrome.runtime.sendMessage and renders the response. This module
// declares the wire shapes so both ends agree.
//
// On serialisation: chrome.runtime.sendMessage serialises via the
// structured-clone algorithm. The only payloads we send are plain JSON
// (callable inputs / outputs are JSON-safe; auth state is reduced to
// { email, displayName } before crossing the boundary). Firestore
// Timestamp values surface as `{ seconds, nanoseconds }` once they
// pass through httpsCallable, which is the shape the panel renderer
// already handles.

import type {
  GetMyPendingRequestsInput,
  GetMyPendingRequestsOutput,
  MarkRequestCompleteInput,
  MarkRequestCompleteOutput,
} from '@kindoo/shared';

/** Reduced user shape — the only auth fields the panel renders. */
export interface PrincipalSnapshot {
  uid: string;
  email: string | null;
  displayName: string | null;
}

export type AuthSnapshot =
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: PrincipalSnapshot };

/** Wire shape for errors crossing the SW boundary. */
export interface WireError {
  /** Stable code the panel can switch on (`'permission-denied'`,
   * `'consent_dismissed'`, etc.). */
  code: string;
  message: string;
}

// ---- Request envelopes -------------------------------------------------

export interface AuthGetStateRequest {
  type: 'auth.getState';
}

export interface AuthSignInRequest {
  type: 'auth.signIn';
}

export interface AuthSignOutRequest {
  type: 'auth.signOut';
}

export interface ApiGetMyPendingRequestsRequest {
  type: 'api.getMyPendingRequests';
  payload: GetMyPendingRequestsInput;
}

export interface ApiMarkRequestCompleteRequest {
  type: 'api.markRequestComplete';
  payload: MarkRequestCompleteInput;
}

export interface PanelTogglePushRequest {
  type: 'panel.togglePushedFromSw';
}

/** Discriminated union of every request the panel may send. */
export type ExtensionRequest =
  | AuthGetStateRequest
  | AuthSignInRequest
  | AuthSignOutRequest
  | ApiGetMyPendingRequestsRequest
  | ApiMarkRequestCompleteRequest
  | PanelTogglePushRequest;

// ---- Response envelopes ------------------------------------------------

export type Result<T> = { ok: true; data: T } | { ok: false; error: WireError };

export type AuthGetStateResponse = Result<AuthSnapshot>;
export type AuthSignInResponse = Result<AuthSnapshot>;
export type AuthSignOutResponse = Result<{ done: true }>;
export type ApiGetMyPendingRequestsResponse = Result<GetMyPendingRequestsOutput>;
export type ApiMarkRequestCompleteResponse = Result<MarkRequestCompleteOutput>;

/** Lookup from a request `type` to its response shape. */
export type ResponseFor<R extends ExtensionRequest> = R extends AuthGetStateRequest
  ? AuthGetStateResponse
  : R extends AuthSignInRequest
    ? AuthSignInResponse
    : R extends AuthSignOutRequest
      ? AuthSignOutResponse
      : R extends ApiGetMyPendingRequestsRequest
        ? ApiGetMyPendingRequestsResponse
        : R extends ApiMarkRequestCompleteRequest
          ? ApiMarkRequestCompleteResponse
          : never;

// ---- Push (SW → CS) ---------------------------------------------------

/**
 * Pushed by the service worker to all content scripts when the
 * signed-in user changes (sign-in, sign-out, refresh). The panel
 * subscribes via `chrome.runtime.onMessage` and re-renders.
 */
export interface AuthStateChangedPush {
  type: 'auth.stateChanged';
  state: AuthSnapshot;
}

export type ExtensionPush = AuthStateChangedPush;

/** Storage key used by both ends; lifted into a const to keep them in sync. */
export const STORAGE_KEYS = {
  /** Cached access token returned by `chrome.identity.getAuthToken`. */
  googleAccessToken: 'sba.googleAccessToken',
  /** Last-known principal snapshot for instant signed-in UI on SW revive. */
  principalSnapshot: 'sba.principalSnapshot',
  /** Whether the slide-over panel is open. Persists across Kindoo
   * SPA navigations + page reloads. */
  panelOpen: 'sba.panelOpen',
} as const;
