// Manager Access data hooks. One live subscription over the access
// collection; rendering is split into per-user cards (each card has an
// importer block + a manual block — see firebase-schema.md §4.5).
//
// Manual-grant write paths: add (arrayUnion-style) and delete
// (arrayRemove-style). The split-ownership rule means
// `importer_callings` is never touched by the client; manager-only
// writes mutate `manual_grants` exclusively (rules enforce).

import { useMemo } from 'react';
import {
  arrayRemove,
  arrayUnion,
  deleteDoc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  Access,
  ManualGrant,
  StakeCallingTemplate,
  WardCallingTemplate,
} from '@kindoo/shared';
import { canonicalEmail } from '@kindoo/shared';
import { useFirestoreCollection } from '../../../lib/data';
import { auth, db } from '../../../lib/firebase';
import {
  accessCol,
  accessRef,
  stakeCallingTemplatesCol,
  wardCallingTemplatesCol,
} from '../../../lib/docs';
import { STAKE_ID } from '../../../lib/constants';

export function useAccessList() {
  const q = useMemo(() => accessCol(db, STAKE_ID), []);
  return useFirestoreCollection<Access>(q);
}

export function useStakeCallingTemplates() {
  const q = useMemo(() => stakeCallingTemplatesCol(db, STAKE_ID), []);
  return useFirestoreCollection<StakeCallingTemplate>(q);
}

export function useWardCallingTemplates() {
  const q = useMemo(() => wardCallingTemplatesCol(db, STAKE_ID), []);
  return useFirestoreCollection<WardCallingTemplate>(q);
}

interface RefreshedActor {
  /** Typed email from auth.currentUser (Firebase Auth). */
  email: string;
  /** canonical custom-claim from the freshly-refreshed token. */
  canonical: string;
  /** The full claims payload — used by diagnostic logging only. */
  claims: {
    canonical?: string;
    email?: string;
    stakes?: Record<string, { manager?: boolean; stake?: boolean; wards?: string[] }>;
  };
}

/**
 * Force-refresh the ID token + return the actor record the rules'
 * `lastActorMatchesAuth` check expects (`{ email, canonical }`
 * matching `request.auth.token.email` + `.canonical`).
 *
 * Why force-refresh: a manager freshly added to `kindooManagers` has
 * `setCustomUserClaims` + `revokeRefreshTokens` minted server-side,
 * but the in-browser cached token can lag by up to an hour. With the
 * stale token, `request.auth.token.canonical` may be absent /
 * `request.auth.token.stakes[sid].manager` may be false, and the
 * `access` rules' create + update predicates deny on `isManager`. The
 * `useSubmitRequest` hook does the same thing for the `requests` rule
 * block. See PR #29 + the `[submit-request]` diagnostic prefix.
 */
async function readRefreshedActor(): Promise<RefreshedActor> {
  const user = auth.currentUser;
  if (!user || !user.email) {
    throw new Error('Not signed in.');
  }
  const tokenResult = await user.getIdTokenResult(true);
  const claims = tokenResult.claims as RefreshedActor['claims'];
  return {
    email: user.email,
    canonical: claims.canonical ?? canonicalEmail(user.email),
    claims,
  };
}

const LOG_PREFIX = '[add-manual-grant]';

function isLoggable(): boolean {
  return typeof console !== 'undefined' && process.env['NODE_ENV'] !== 'test';
}

export interface AddManualGrantInput {
  member_email: string;
  member_name: string;
  scope: string;
  reason: string;
}

/**
 * Add a manual access grant. If the access doc doesn't yet exist (the
 * user has only manual grants), `setDoc` creates it with empty
 * `importer_callings`. If it exists, `updateDoc` with `arrayUnion`
 * appends the new grant entry to the right scope's array.
 *
 * Note that arrayUnion merges by deep-equality on the value object,
 * which means the grant_id (UUID) makes every row unique even when
 * scope + reason match a prior entry — a manager re-adding "covering
 * bishop" twice on purpose still gets two distinct entries.
 *
 * Per spec §3.1, the composite-uniqueness check on (canonical, scope,
 * reason) is enforced server-side — we surface a friendly client-side
 * pre-check first (faster feedback), and trust the rules to catch any
 * race-condition slip-through.
 */
export function useAddManualGrantMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddManualGrantInput) => {
      // Force-refresh the ID token: a manager freshly minted (or whose
      // canonical claim was set after their last sign-in) needs a
      // round-trip before the rule's `isManager` + `lastActor`
      // predicates resolve correctly. Same pattern as `useSubmitRequest`.
      const refreshed = await readRefreshedActor();
      const actor = { email: refreshed.email, canonical: refreshed.canonical };
      const can = canonicalEmail(input.member_email);
      const grant: ManualGrant = {
        grant_id: crypto.randomUUID(),
        reason: input.reason.trim(),
        granted_by: actor,
        // The serverTimestamp sentinel can't live inside an arrayUnion
        // value (Firestore rejects it for atomic-array ops). We use
        // `new Date()` cast through `unknown` here — it serialises to a
        // Firestore timestamp on write. The audit row's
        // `timestamp` field on the trigger side uses a real
        // serverTimestamp.
        granted_at: new Date() as unknown as ManualGrant['granted_at'],
      };
      const ref = accessRef(db, STAKE_ID, can);
      const snap = await getDoc(ref);

      // Diagnostic: which path are we taking + what's on the token?
      // Operator pastes from staging when a denial surfaces.
      if (isLoggable()) {
        console.log(`${LOG_PREFIX} resolved`, {
          docPath: `stakes/${STAKE_ID}/access/${can}`,
          docExists: snap.exists(),
          scope: input.scope,
          authEmail: refreshed.email,
          tokenEmail: refreshed.claims.email,
          tokenCanonical: refreshed.claims.canonical,
          tokenStakes: refreshed.claims.stakes,
        });
      }

      if (!snap.exists()) {
        // Create a fresh manual-only access doc per the rule's `create`
        // gate — `importer_callings` must be empty.
        const body = {
          member_canonical: can,
          member_email: input.member_email.trim(),
          member_name: input.member_name.trim(),
          importer_callings: {},
          manual_grants: { [input.scope]: [grant] },
          created_at: serverTimestamp(),
          last_modified_at: serverTimestamp(),
          last_modified_by: actor,
          lastActor: actor,
        };
        if (isLoggable()) {
          console.log(`${LOG_PREFIX} create payload`, { docPath: ref.path, body });
        }
        try {
          await setDoc(ref, body as unknown as Access);
        } catch (err) {
          if (isLoggable()) {
            console.error(`${LOG_PREFIX} create denied`, {
              docPath: ref.path,
              tokenCanonical: refreshed.claims.canonical,
              stakes: refreshed.claims.stakes,
              err,
            });
          }
          throw err;
        }
        return;
      }

      // Friendly pre-check: reject obvious composite-key collision on
      // (scope, reason). The server still has the final word; this just
      // gives the manager fast feedback in the common case.
      const existing = snap.data() as Access;
      const dup = (existing.manual_grants?.[input.scope] ?? []).some(
        (g) => g.reason.trim() === input.reason.trim(),
      );
      if (dup) {
        throw new Error(`A manual grant with that reason already exists for ${input.scope}.`);
      }

      // Update payload — keys MUST be a subset of the rule's
      // `affectedKeys()` allowlist:
      //   ['manual_grants', 'last_modified_by', 'last_modified_at',
      //    'lastActor']
      // member_email + member_name are set-once on create; touching
      // them here trips the `hasOnly()` check and the rule denies. If
      // a manager wants to fix a typo in those fields, that's a
      // separate flow (the access-doc rename path doesn't exist yet —
      // tracked in spec §3.1 split-ownership).
      const updatePayload = {
        [`manual_grants.${input.scope}`]: arrayUnion(grant),
        last_modified_at: serverTimestamp(),
        last_modified_by: actor,
        lastActor: actor,
      };
      if (isLoggable()) {
        console.log(`${LOG_PREFIX} update payload`, { docPath: ref.path, updatePayload });
      }
      try {
        await updateDoc(ref, updatePayload);
      } catch (err) {
        if (isLoggable()) {
          console.error(`${LOG_PREFIX} update denied`, {
            docPath: ref.path,
            tokenCanonical: refreshed.claims.canonical,
            stakes: refreshed.claims.stakes,
            err,
          });
        }
        throw err;
      }
    },
    // Fire-and-forget — awaiting `invalidateQueries()` would hang
    // because the DIY live hooks use a never-resolving placeholder
    // queryFn (the `onSnapshot` listener is the real source). Without
    // this `void`, `mutateAsync` would chain on the invalidate promise
    // and the button would stay stuck on its pending state.
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });
}

export interface DeleteManualGrantInput {
  member_canonical: string;
  scope: string;
  grant: ManualGrant;
}

/**
 * Delete a single manual grant by `arrayRemove`. The grant payload must
 * be byte-equal to a value currently in the array — Firestore's
 * arrayRemove uses deep equality, so the caller passes the exact
 * `ManualGrant` object from the displayed list. If the resulting doc
 * has empty `importer_callings` AND empty `manual_grants` we delete
 * the doc entirely (per the rules' delete predicate).
 */
export function useDeleteManualGrantMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ member_canonical, scope, grant }: DeleteManualGrantInput) => {
      const refreshed = await readRefreshedActor();
      const actor = { email: refreshed.email, canonical: refreshed.canonical };
      const ref = accessRef(db, STAKE_ID, member_canonical);
      await updateDoc(ref, {
        [`manual_grants.${scope}`]: arrayRemove(grant),
        last_modified_at: serverTimestamp(),
        last_modified_by: actor,
        lastActor: actor,
      });

      // Doc-cleanup: if all manual + importer maps are empty after the
      // arrayRemove, delete the doc entirely (matches the rules' delete
      // predicate). We re-read because arrayRemove's return value
      // doesn't tell us the new array length.
      const after = await getDoc(ref);
      if (!after.exists()) return;
      const data = after.data() as Access;
      const importerEmpty = Object.keys(data.importer_callings ?? {}).length === 0;
      const manualScopes = data.manual_grants ?? {};
      const manualEmpty = Object.values(manualScopes).every((arr) => arr.length === 0);
      if (importerEmpty && manualEmpty) {
        await deleteDoc(ref);
      }
    },
    // Fire-and-forget — awaiting `invalidateQueries()` would hang
    // because the DIY live hooks use a never-resolving placeholder
    // queryFn (the `onSnapshot` listener is the real source). Without
    // this `void`, `mutateAsync` would chain on the invalidate promise
    // and the button would stay stuck on its pending state.
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });
}
