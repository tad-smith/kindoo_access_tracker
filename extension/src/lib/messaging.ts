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
  Building,
  GetMyPendingRequestsInput,
  GetMyPendingRequestsOutput,
  MarkRequestCompleteInput,
  MarkRequestCompleteOutput,
  Seat,
  Stake,
  Ward,
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

// ---- v2.1 configuration -----------------------------------------------

/**
 * One-shot read of the stake doc + every building doc under it. The
 * Configure panel uses this to (a) verify the stake name against
 * Kindoo's site name, and (b) render one row per building for rule
 * assignment.
 */
export interface DataGetStakeConfigRequest {
  type: 'data.getStakeConfig';
}

export interface DataGetStakeConfigPayload {
  stake: Stake;
  buildings: Building[];
  /**
   * Every ward under the stake — needed by v2.2's provision flow to
   * resolve a ward-scoped request's display name (`request.scope` is
   * a ward_code; the orchestrator maps it to `ward.ward_name` for the
   * Kindoo Description field). Empty for stakes with no wards yet.
   */
  wards: Ward[];
}

/**
 * Persist the operator's site-verification + per-building rule
 * assignments. SW does a single batched write so partial application
 * is impossible.
 */
export interface DataWriteKindooConfigRequest {
  type: 'data.writeKindooConfig';
  payload: WriteKindooConfigPayload;
}

export interface WriteKindooConfigPayload {
  siteId: number;
  siteName: string;
  buildingRules: Array<{
    buildingId: string;
    ruleId: number;
    ruleName: string;
  }>;
}

/**
 * One-shot read of the SBA `Seat` doc for a request's subject. v2.2's
 * read-first orchestrator uses this to compute the post-completion
 * seat state (which buildings to grant, which to drop, what to
 * synthesize as the Kindoo Description). `null` is a valid return
 * — first-time-add cases have no seat yet.
 */
export interface DataGetSeatByEmailRequest {
  type: 'data.getSeatByEmail';
  /** Canonical email — caller has already run `canonicalEmail()`. */
  canonical: string;
}

/** Discriminated union of every request the panel may send. */
export type ExtensionRequest =
  | AuthGetStateRequest
  | AuthSignInRequest
  | AuthSignOutRequest
  | ApiGetMyPendingRequestsRequest
  | ApiMarkRequestCompleteRequest
  | PanelTogglePushRequest
  | DataGetStakeConfigRequest
  | DataWriteKindooConfigRequest
  | DataGetSeatByEmailRequest;

// ---- Response envelopes ------------------------------------------------

export type Result<T> = { ok: true; data: T } | { ok: false; error: WireError };

export type AuthGetStateResponse = Result<AuthSnapshot>;
export type AuthSignInResponse = Result<AuthSnapshot>;
export type AuthSignOutResponse = Result<{ done: true }>;
export type ApiGetMyPendingRequestsResponse = Result<GetMyPendingRequestsOutput>;
export type ApiMarkRequestCompleteResponse = Result<MarkRequestCompleteOutput>;
export type DataGetStakeConfigResponse = Result<DataGetStakeConfigPayload>;
export type DataWriteKindooConfigResponse = Result<{ ok: true }>;
export type DataGetSeatByEmailResponse = Result<Seat | null>;

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
          : R extends DataGetStakeConfigRequest
            ? DataGetStakeConfigResponse
            : R extends DataWriteKindooConfigRequest
              ? DataWriteKindooConfigResponse
              : R extends DataGetSeatByEmailRequest
                ? DataGetSeatByEmailResponse
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
