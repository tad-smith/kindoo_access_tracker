// Manager Access data hooks. One live subscription over the access
// collection; rendering is split into per-user cards (each card has an
// importer block + a manual block — see firebase-schema.md §4.5).
//
// Phase 7 adds the manual-grant write paths: add (arrayUnion-style) and
// delete (arrayRemove-style). The split-ownership rule means
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
import type { Access, ManualGrant } from '@kindoo/shared';
import { canonicalEmail } from '@kindoo/shared';
import { useFirestoreCollection } from '../../../lib/data';
import { db } from '../../../lib/firebase';
import { accessCol, accessRef } from '../../../lib/docs';
import { STAKE_ID } from '../../../lib/constants';
import { usePrincipal } from '../../../lib/principal';

export function useAccessList() {
  const q = useMemo(() => accessCol(db, STAKE_ID), []);
  return useFirestoreCollection<Access>(q);
}

function actorOf(principal: ReturnType<typeof usePrincipal>) {
  return {
    email: principal.email ?? '',
    canonical: principal.canonical ?? canonicalEmail(principal.email ?? ''),
  };
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
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddManualGrantInput) => {
      const actor = actorOf(principal);
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

      if (!snap.exists()) {
        // Create a fresh manual-only access doc per the rule's `create`
        // gate — `importer_callings` must be empty.
        await setDoc(ref, {
          member_canonical: can,
          member_email: input.member_email.trim(),
          member_name: input.member_name.trim(),
          importer_callings: {},
          manual_grants: { [input.scope]: [grant] },
          created_at: serverTimestamp(),
          last_modified_at: serverTimestamp(),
          last_modified_by: actor,
          lastActor: actor,
        } as unknown as Access);
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

      // Preserve member_email + member_name in case they came in fresh
      // on this add (existing doc may pre-date the values from typing).
      await updateDoc(ref, {
        [`manual_grants.${input.scope}`]: arrayUnion(grant),
        member_email: input.member_email.trim() || existing.member_email,
        member_name: input.member_name.trim() || existing.member_name,
        last_modified_at: serverTimestamp(),
        last_modified_by: actor,
        lastActor: actor,
      });
    },
    onSuccess: () => qc.invalidateQueries(),
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
  const principal = usePrincipal();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ member_canonical, scope, grant }: DeleteManualGrantInput) => {
      const actor = actorOf(principal);
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
    onSuccess: () => qc.invalidateQueries(),
  });
}
