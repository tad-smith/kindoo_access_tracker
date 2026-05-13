// Callable client wrappers — the only SBA surface the extension talks
// to. No direct Firestore from the extension; everything goes through
// these two endpoints, server-gated on the caller being an active
// Kindoo Manager of the named stake.
//
// Input / output shapes are shared with the Cloud Function definitions
// via `@kindoo/shared/src/types/extensionCallables.ts`.

import { httpsCallable } from 'firebase/functions';
import type {
  GetMyPendingRequestsInput,
  GetMyPendingRequestsOutput,
  MarkRequestCompleteInput,
  MarkRequestCompleteOutput,
} from '@kindoo/shared';
import { functions } from './firebase';

export type {
  GetMyPendingRequestsInput,
  GetMyPendingRequestsOutput,
  MarkRequestCompleteInput,
  MarkRequestCompleteOutput,
};

/**
 * Fetch the queue of pending requests visible to the signed-in
 * manager for `stakeId`. The callable returns `permission-denied`
 * (Firebase Functions HttpsError) when the caller is not an active
 * Kindoo Manager of that stake — the UI surfaces a NotAuthorized
 * panel in that case.
 */
export async function getMyPendingRequests(
  input: GetMyPendingRequestsInput,
): Promise<GetMyPendingRequestsOutput> {
  const fn = httpsCallable<GetMyPendingRequestsInput, GetMyPendingRequestsOutput>(
    functions(),
    'getMyPendingRequests',
  );
  const result = await fn(input);
  return result.data;
}

/**
 * Mark a single pending request complete. Server validates that the
 * caller is an active Kindoo Manager of `stakeId` and that the
 * request is currently `pending`; out-of-order calls (already
 * complete, already rejected) surface as a typed HttpsError the UI
 * renders as a soft toast.
 *
 * v2.2: `kindooUid` and `provisioningNote` are forwarded through
 * unchanged. The shared input type already declares them optional;
 * the callable persists both on the request doc when present.
 */
export async function markRequestComplete(
  input: MarkRequestCompleteInput,
): Promise<MarkRequestCompleteOutput> {
  const fn = httpsCallable<MarkRequestCompleteInput, MarkRequestCompleteOutput>(
    functions(),
    'markRequestComplete',
  );
  const result = await fn(input);
  return result.data;
}
