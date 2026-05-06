// Manager Queue data hooks + mutations.
//
// Read side:
//   - `usePendingRequests()` — live list of requests with status='pending',
//     ordered FIFO (oldest first). Indexed via the
//     `(status ASC, requested_at ASC)` composite from
//     `firestore.indexes.json`.
//
// Write side (mutations):
//   - `useCompleteAddRequest()` — Mark Complete for `add_manual` /
//     `add_temp`. Atomic: writes the new seat doc + flips the request
//     to `complete` inside one `runTransaction`. The rules' `seats.create`
//     rule's `tiedToRequestCompletion` invariant verifies the request
//     transitions pending → complete in the same write.
//   - `useCompleteRemoveRequest()` — Mark Complete for `remove`. Client
//     transaction reads the seat doc INSIDE the transaction so the R-1
//     race surfaces correctly: if the seat is gone, flip the request
//     with `completion_note` and emit only the request-side audit row
//     (Phase 8's `removeSeatOnRequestComplete` Cloud Function does the
//     Admin-SDK seat delete on the non-R-1 path).
//   - `useRejectRequest()` — flip pending → rejected with required
//     reason.

import { orderBy, query, runTransaction, serverTimestamp, where } from 'firebase/firestore';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { canonicalEmail, type AccessRequest } from '@kindoo/shared';
import { useFirestoreCollection } from '../../../lib/data';
import { db, auth } from '../../../lib/firebase';
import { requestsCol, requestRef, seatRef } from '../../../lib/docs';
import { STAKE_ID } from '../../../lib/constants';

// ---- Reads ----------------------------------------------------------

/** Live FIFO pending-requests list. */
export function usePendingRequests() {
  const q = useMemo(
    () =>
      query(
        requestsCol(db, STAKE_ID),
        where('status', '==', 'pending'),
        orderBy('requested_at', 'asc'),
      ),
    [],
  );
  return useFirestoreCollection<AccessRequest>(q);
}

// ---- Helper ---------------------------------------------------------

async function readActor(): Promise<{ email: string; canonical: string }> {
  const user = auth.currentUser;
  if (!user || !user.email) throw new Error('Not signed in.');
  const tokenResult = await user.getIdTokenResult();
  const tokenCanonical =
    (tokenResult.claims as { canonical?: string }).canonical ?? canonicalEmail(user.email);
  return { email: user.email, canonical: tokenCanonical };
}

// ---- Complete (add_manual / add_temp) ------------------------------

export interface CompleteAddInput {
  request: AccessRequest;
  building_names: string[];
}

/**
 * Mark Complete for an add_manual / add_temp request. Atomic via
 * `runTransaction`: the seat doc and the flipped request land together
 * or not at all. Rules:
 *   - seat: tied-to-request-completion invariant + lastActor + create
 *     allowed only on type='manual'/'temp' + duplicate_grants empty +
 *     callings empty.
 *   - request: pending → complete; completer_canonical = auth canonical;
 *     lastActor matches.
 */
export function useCompleteAddRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ request, building_names }: CompleteAddInput) => {
      if (request.type !== 'add_manual' && request.type !== 'add_temp') {
        throw new Error(`Cannot use add-completion for type "${request.type}".`);
      }
      if (building_names.length === 0) {
        throw new Error('Pick at least one building.');
      }
      const actor = await readActor();
      const seatType = request.type === 'add_manual' ? 'manual' : 'temp';

      await runTransaction(db, async (tx) => {
        const reqRef = requestRef(db, STAKE_ID, request.request_id);
        const reqSnap = await tx.get(reqRef);
        if (!reqSnap.exists()) {
          throw new Error('Request not found.');
        }
        const cur = reqSnap.data();
        if (cur.status !== 'pending') {
          throw new Error(`Request is no longer pending (current status: ${cur.status}).`);
        }
        const newSeatRef = seatRef(db, STAKE_ID, request.member_canonical);
        const seatSnap = await tx.get(newSeatRef);
        if (seatSnap.exists()) {
          // The rules let the seat create succeed only when there isn't
          // an existing doc; surface a friendlier message than the raw
          // permission-denied that a no-op create would yield.
          throw new Error(
            `${request.member_email} already has a seat. Reconcile via All Seats first.`,
          );
        }

        // Untyped record on the wire — `serverTimestamp()` is a
        // `FieldValue` sentinel that the SDK swaps for a real
        // `Timestamp` server-side, so it doesn't match the doc-shape's
        // `TimestampLike`. Cast through unknown when handing to `set`.
        const seatBody: Record<string, unknown> = {
          member_canonical: request.member_canonical,
          member_email: request.member_email,
          member_name: request.member_name,
          scope: request.scope,
          type: seatType,
          callings: [],
          building_names,
          duplicate_grants: [],
          granted_by_request: request.request_id,
          created_at: serverTimestamp(),
          last_modified_at: serverTimestamp(),
          last_modified_by: actor,
          lastActor: actor,
        };
        if (request.type === 'add_temp') {
          if (request.start_date) seatBody.start_date = request.start_date;
          if (request.end_date) seatBody.end_date = request.end_date;
        }
        if (request.reason) seatBody.reason = request.reason;

        // Cast through unknown — TanStack's typed converter expects a
        // full Seat including settled timestamps; here we hand a doc
        // body with `serverTimestamp()` sentinels that the SDK
        // resolves on commit.
        tx.set(newSeatRef, seatBody as never);
        tx.update(reqRef, {
          status: 'complete',
          completer_email: actor.email,
          completer_canonical: actor.canonical,
          completed_at: serverTimestamp(),
          lastActor: actor,
        });
      });
    },
    onSuccess: () => {
      // Fire-and-forget — the DIY live hooks key under
      // `__kindoo_firestore__` so this is keyed away from any
      // never-resolving placeholder queryFn, but `void` keeps the
      // pattern uniform across the codebase.
      void qc.invalidateQueries({ queryKey: ['kindoo', 'requests'] });
    },
  });
}

// ---- Complete (remove) ---------------------------------------------

export interface CompleteRemoveInput {
  request: AccessRequest;
}

/**
 * Mark Complete for a `remove` request. The actual seat delete happens
 * in Phase 8's `removeSeatOnRequestComplete` Cloud Function (Admin SDK
 * bypass; rules' seats.delete predicate has no access to
 * `request.resource.data` so we can't link the delete to a request via
 * client-side rules). On the client we:
 *
 *   1. Read the seat doc inside the transaction.
 *   2. If the seat exists → flip the request to complete (no
 *      completion_note); the Phase 8 trigger handles the delete.
 *   3. If the seat is absent → flip with `completion_note` recording
 *      the R-1 no-op so the audit trail explains why nothing was
 *      deleted.
 */
export function useCompleteRemoveRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ request }: CompleteRemoveInput) => {
      if (request.type !== 'remove') {
        throw new Error('useCompleteRemoveRequest requires type=remove.');
      }
      const actor = await readActor();
      await runTransaction(db, async (tx) => {
        const reqRef = requestRef(db, STAKE_ID, request.request_id);
        const reqSnap = await tx.get(reqRef);
        if (!reqSnap.exists()) {
          throw new Error('Request not found.');
        }
        const cur = reqSnap.data();
        if (cur.status !== 'pending') {
          throw new Error(`Request is no longer pending (current status: ${cur.status}).`);
        }
        const seatTargetCanonical = request.seat_member_canonical ?? request.member_canonical;
        const targetSeat = seatRef(db, STAKE_ID, seatTargetCanonical);
        const seatSnap = await tx.get(targetSeat);

        const update: Record<string, unknown> = {
          status: 'complete',
          completer_email: actor.email,
          completer_canonical: actor.canonical,
          completed_at: serverTimestamp(),
          lastActor: actor,
        };
        if (!seatSnap.exists()) {
          update.completion_note = 'Seat already removed at completion time (no-op).';
        }
        tx.update(reqRef, update);
      });
    },
    onSuccess: () => {
      // Fire-and-forget — the DIY live hooks key under
      // `__kindoo_firestore__` so this is keyed away from any
      // never-resolving placeholder queryFn, but `void` keeps the
      // pattern uniform across the codebase.
      void qc.invalidateQueries({ queryKey: ['kindoo', 'requests'] });
    },
  });
}

// ---- Reject ---------------------------------------------------------

export interface RejectRequestInput {
  request: AccessRequest;
  rejection_reason: string;
}

export function useRejectRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ request, rejection_reason }: RejectRequestInput) => {
      const reason = rejection_reason.trim();
      if (!reason) throw new Error('A rejection reason is required.');
      const actor = await readActor();

      await runTransaction(db, async (tx) => {
        const reqRef = requestRef(db, STAKE_ID, request.request_id);
        const reqSnap = await tx.get(reqRef);
        if (!reqSnap.exists()) {
          throw new Error('Request not found.');
        }
        const cur = reqSnap.data();
        if (cur.status !== 'pending') {
          throw new Error(`Request is no longer pending (current status: ${cur.status}).`);
        }
        tx.update(reqRef, {
          status: 'rejected',
          completer_email: actor.email,
          completer_canonical: actor.canonical,
          completed_at: serverTimestamp(),
          rejection_reason: reason,
          lastActor: actor,
        });
      });
    },
    onSuccess: () => {
      // Fire-and-forget — the DIY live hooks key under
      // `__kindoo_firestore__` so this is keyed away from any
      // never-resolving placeholder queryFn, but `void` keeps the
      // pattern uniform across the codebase.
      void qc.invalidateQueries({ queryKey: ['kindoo', 'requests'] });
    },
  });
}
