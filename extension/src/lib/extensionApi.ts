// Content-script-side wrapper over chrome.runtime.sendMessage.
//
// The panel components (SignedOutPanel, QueuePanel, NotAuthorizedPanel,
// RequestCard, ResultDialog, ConfigurePanel) live in the content-script
// bundle and cannot touch chrome.identity or the Firebase SDK directly.
// They import from here instead; this module round-trips through the
// service worker which owns those surfaces.
//
// Hook shapes mirror the previous direct-Firebase versions
// (`useAuthState`, `getMyPendingRequests`, `markRequestComplete`) so
// the component code ports verbatim.

import { useEffect, useState } from 'react';
import type {
  ApiGetMyPendingRequestsRequest,
  ApiGetMyPendingRequestsResponse,
  ApiMarkRequestCompleteRequest,
  ApiMarkRequestCompleteResponse,
  AuthGetStateRequest,
  AuthGetStateResponse,
  AuthSignInRequest,
  AuthSignInResponse,
  AuthSignOutRequest,
  AuthSignOutResponse,
  AuthSnapshot,
  AuthStateChangedPush,
  DataGetSeatByEmailRequest,
  DataGetSeatByEmailResponse,
  DataGetStakeConfigPayload,
  DataGetStakeConfigRequest,
  DataGetStakeConfigResponse,
  DataGetSyncDataRequest,
  DataGetSyncDataResponse,
  DataSyncApplyFixRequest,
  DataSyncApplyFixResponse,
  DataWriteKindooConfigRequest,
  DataWriteKindooConfigResponse,
  DataWriteKindooSiteEidRequest,
  DataWriteKindooSiteEidResponse,
  ExtensionRequest,
  ResponseFor,
  SyncDataBundle,
  WireError,
  WriteKindooConfigPayload,
} from './messaging';

export type { SyncDataBundle } from './messaging';

/** Public alias for the stake-config bundle the panel passes between
 * components. */
export type StakeConfigBundle = DataGetStakeConfigPayload;
import type {
  GetMyPendingRequestsInput,
  GetMyPendingRequestsOutput,
  MarkRequestCompleteInput,
  MarkRequestCompleteOutput,
  Seat,
  SyncApplyFixInput,
  SyncApplyFixResult,
} from '@kindoo/shared';

/**
 * Re-throwable error that carries the SW-side error code so component
 * code can pattern-match on e.g. `'permission-denied'` or
 * `'consent_dismissed'`.
 */
export class ExtensionApiError extends Error {
  readonly code: string;
  constructor(error: WireError) {
    super(error.message);
    this.name = 'ExtensionApiError';
    this.code = error.code;
  }
}

/**
 * Type-safe `chrome.runtime.sendMessage` wrapper. Resolves with the
 * SW handler's response, with the discriminated union narrowed by
 * the request type.
 */
function sendMessage<R extends ExtensionRequest>(request: R): Promise<ResponseFor<R>> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(
          new ExtensionApiError({
            code: 'sw-unreachable',
            message: err.message ?? 'sw unreachable',
          }),
        );
        return;
      }
      resolve(response as ResponseFor<R>);
    });
  });
}

/** Unwrap a `Result<T>` response or throw an ExtensionApiError. */
function unwrap<T>(response: { ok: true; data: T } | { ok: false; error: WireError }): T {
  if (response.ok) return response.data;
  throw new ExtensionApiError(response.error);
}

// ---- Auth -------------------------------------------------------------

export async function signIn(): Promise<AuthSnapshot> {
  const req: AuthSignInRequest = { type: 'auth.signIn' };
  const res: AuthSignInResponse = await sendMessage(req);
  return unwrap(res);
}

export async function signOut(): Promise<void> {
  const req: AuthSignOutRequest = { type: 'auth.signOut' };
  const res: AuthSignOutResponse = await sendMessage(req);
  unwrap(res);
}

export async function fetchAuthState(): Promise<AuthSnapshot> {
  const req: AuthGetStateRequest = { type: 'auth.getState' };
  const res: AuthGetStateResponse = await sendMessage(req);
  return unwrap(res);
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; email: string | null; displayName: string | null };

/**
 * React hook: read the SW's auth state and subscribe to push updates.
 * Initial state is `'loading'` until the first `auth.getState`
 * response lands; subsequent SW pushes (sign-in, sign-out elsewhere)
 * arrive via `chrome.runtime.onMessage`.
 */
export function useAuthState(): AuthState {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchAuthState()
      .then((snap) => {
        if (cancelled) return;
        setState(snapToState(snap));
      })
      .catch(() => {
        if (cancelled) return;
        setState({ status: 'signed-out' });
      });
    const listener = (msg: unknown) => {
      if (!isAuthStateChangedPush(msg)) return;
      setState(snapToState(msg.state));
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      cancelled = true;
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);

  return state;
}

function snapToState(snap: AuthSnapshot): AuthState {
  if (snap.status === 'signed-out') return { status: 'signed-out' };
  return {
    status: 'signed-in',
    email: snap.user.email,
    displayName: snap.user.displayName,
  };
}

function isAuthStateChangedPush(value: unknown): value is AuthStateChangedPush {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { type?: unknown }).type === 'auth.stateChanged';
}

// ---- Callables --------------------------------------------------------

export async function getMyPendingRequests(
  input: GetMyPendingRequestsInput,
): Promise<GetMyPendingRequestsOutput> {
  const req: ApiGetMyPendingRequestsRequest = { type: 'api.getMyPendingRequests', payload: input };
  const res: ApiGetMyPendingRequestsResponse = await sendMessage(req);
  return unwrap(res);
}

export async function markRequestComplete(
  input: MarkRequestCompleteInput,
): Promise<MarkRequestCompleteOutput> {
  const req: ApiMarkRequestCompleteRequest = { type: 'api.markRequestComplete', payload: input };
  const res: ApiMarkRequestCompleteResponse = await sendMessage(req);
  return unwrap(res);
}

// ---- v2.1 config ------------------------------------------------------

export async function getStakeConfig(): Promise<DataGetStakeConfigPayload> {
  const req: DataGetStakeConfigRequest = { type: 'data.getStakeConfig' };
  const res: DataGetStakeConfigResponse = await sendMessage(req);
  return unwrap(res);
}

export async function writeKindooConfig(payload: WriteKindooConfigPayload): Promise<void> {
  const req: DataWriteKindooConfigRequest = { type: 'data.writeKindooConfig', payload };
  const res: DataWriteKindooConfigResponse = await sendMessage(req);
  unwrap(res);
}

/**
 * Fetch the SBA `Seat` doc for a member by canonical email. Returns
 * `null` when the member has no seat yet — that's the v2.2 first-add
 * signal (orchestrator treats `seat=null` as "no prior grants").
 */
export async function getSeatByEmail(canonical: string): Promise<Seat | null> {
  const req: DataGetSeatByEmailRequest = { type: 'data.getSeatByEmail', canonical };
  const res: DataGetSeatByEmailResponse = await sendMessage(req);
  return unwrap(res);
}

/**
 * One-shot read of every Firestore collection the Sync feature needs.
 * Used by `SyncPanel` to compute drift between SBA and Kindoo.
 */
export async function getSyncData(): Promise<SyncDataBundle> {
  const req: DataGetSyncDataRequest = { type: 'data.getSyncData' };
  const res: DataGetSyncDataResponse = await sendMessage(req);
  return unwrap(res);
}

/**
 * Dispatch one SBA-side per-row Sync Phase 2 fix to the callable.
 * Wire-level / auth errors throw `ExtensionApiError`; domain misses
 * (seat already exists, seat not found) come back as
 * `{ success: false, error }` for the caller to render inline.
 */
export async function syncApplyFix(input: SyncApplyFixInput): Promise<SyncApplyFixResult> {
  const req: DataSyncApplyFixRequest = { type: 'data.syncApplyFix', payload: input };
  const res: DataSyncApplyFixResponse = await sendMessage(req);
  return unwrap(res);
}

/**
 * Persist the active Kindoo session's EID onto a foreign `KindooSite`
 * doc. Kindoo Sites Phase 3 — see `siteCheck.ts`. Throws
 * `ExtensionApiError` on auth / rule failure; callers run after the
 * UI has already determined the operator is a manager so the only
 * realistic failures are transient.
 */
export async function writeKindooSiteEid(kindooSiteId: string, kindooEid: number): Promise<void> {
  const req: DataWriteKindooSiteEidRequest = {
    type: 'data.writeKindooSiteEid',
    payload: { kindooSiteId, kindooEid },
  };
  const res: DataWriteKindooSiteEidResponse = await sendMessage(req);
  unwrap(res);
}
