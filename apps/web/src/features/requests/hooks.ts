// Data hooks + mutations for the request lifecycle.
//
// Submit (`useSubmitRequest`) is a single Firestore write: a new doc in
// `stakes/{sid}/requests`, status='pending', `requested_at = serverTimestamp()`.
// The rules in `firestore.rules` enforce field-level invariants
// (member_name required for add types, ≥1 building for stake-scope add
// types, requester_canonical matches auth, lastActor matches auth).
//
// Complete + Reject mutations live in `manager/queue/hooks.ts`; cancel
// lives in `myRequests/cancelRequest.ts`. Centralising them with the
// queue / my-requests features keeps each page's mutation set local
// while sharing the rendering primitives below.

import { doc, orderBy, query, serverTimestamp, setDoc, where } from 'firebase/firestore';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { canonicalEmail } from '@kindoo/shared';
import type { Access, AccessRequest, Building, Seat, Ward } from '@kindoo/shared';
import { useFirestoreDoc, useFirestoreCollection } from '../../lib/data';
import { db, auth } from '../../lib/firebase';
import { accessRef, buildingsCol, requestsCol, seatRef, wardsCol } from '../../lib/docs';
import { useActiveStake } from '../../lib/useActiveStake';
import { usePrincipal } from '../../lib/principal';
import { allowedScopesFor } from './scopeOptions';
import type { ScopeOption } from './components/NewRequestForm';

/**
 * Live duplicate-warning hook. Per `docs/spec.md` §5.1: inline
 * warning when the member already has a seat in the requested scope.
 * Subscribes to `seats/{member_canonical}` because the seat doc id IS
 * the canonical email — no query needed; if the doc exists and its
 * `scope` matches the requested scope (or any duplicate_grants
 * scope), we surface a warning. Auto seats trigger the warning too;
 * the spec is "warns; does not block".
 *
 * `null` canonical disables the subscription.
 */
export function useSeatForMember(canonical: string | null) {
  const activeStakeId = useActiveStake();
  const ref = useMemo(() => {
    if (!canonical || !activeStakeId) return null;
    return seatRef(db, activeStakeId, canonical);
  }, [canonical, activeStakeId]);
  return useFirestoreDoc<Seat>(ref);
}

/**
 * Live subscription to a member's `access` doc by canonical email. The
 * doc id IS the canonical email — no query needed. Used to live-derive a
 * requester's display name + calling on the manager Queue (Option A: the
 * request itself stores no name/calling). Managers may read any
 * `access/{email}` (see `firestore.rules`), and the Queue is
 * manager-gated, so the read is always permitted for this surface.
 *
 * `null` canonical disables the subscription.
 */
export function useAccessForMember(canonical: string | null) {
  const activeStakeId = useActiveStake();
  const ref = useMemo(() => {
    if (!canonical || !activeStakeId) return null;
    return accessRef(db, activeStakeId, canonical);
  }, [canonical, activeStakeId]);
  return useFirestoreDoc<Access>(ref);
}

/**
 * Live "remove already pending" check for the X / removal modal so the
 * UI can disable the trashcan as soon as a remove submission lands.
 * Returns the matching request doc(s); empty array means no pending
 * removal.
 *
 * The query MUST filter by scope as well as member, because the
 * requests rule's read predicate keys off scope (a bishopric of CO
 * may only list requests where `scope='CO'` — Firestore rejects
 * queries whose filter set doesn't statically prove the result set
 * is allowable). Callers pass both the seat's `member_canonical`
 * and `scope`; the badge fires when a pending remove exists for the
 * exact (scope, member) pair.
 */
export function usePendingRemoveRequests(memberCanonical: string | null, scope: string | null) {
  const activeStakeId = useActiveStake();
  const q = useMemo(() => {
    if (!memberCanonical || !scope || !activeStakeId) return null;
    return query(
      requestsCol(db, activeStakeId),
      where('scope', '==', scope),
      where('type', '==', 'remove'),
      where('status', '==', 'pending'),
      where('member_canonical', '==', memberCanonical),
    );
  }, [memberCanonical, scope, activeStakeId]);
  return useFirestoreCollection<AccessRequest>(q);
}

/**
 * Live pending-request stream for a single scope. Powers the roster-
 * page "Outstanding Requests" section + the inline pending-removal
 * affordance on existing roster cards.
 *
 * Filter shape `(scope, status, requested_at)` matches the existing
 * composite index in `firestore/firestore.indexes.json`. Ordered FIFO
 * (oldest first) so the section list visually agrees with the manager
 * Queue page.
 *
 * Rules: the requests-read predicate already permits this query for
 * stake members reading `scope='stake'` and bishopric users reading
 * their ward's scope. Pass `null` to disable the subscription.
 */
export function usePendingRequestsForScope(scope: string | null) {
  const activeStakeId = useActiveStake();
  const q = useMemo(() => {
    if (!scope || !activeStakeId) return null;
    return query(
      requestsCol(db, activeStakeId),
      where('scope', '==', scope),
      where('status', '==', 'pending'),
      orderBy('requested_at', 'asc'),
    );
  }, [scope, activeStakeId]);
  return useFirestoreCollection<AccessRequest>(q);
}

/**
 * Stake ward catalogue — rules permit any stake member to read, so the
 * edit-modal can resolve a ward's `building_name` (used to compute the
 * "template / Church-managed" pre-checked + disabled buildings for an
 * `edit_auto` request) without a manager claim.
 */
export function useStakeWards() {
  const activeStakeId = useActiveStake();
  const q = useMemo(() => (activeStakeId ? wardsCol(db, activeStakeId) : null), [activeStakeId]);
  return useFirestoreCollection<Ward>(q);
}

/**
 * Stake building catalogue — same `isAnyMember` read gate as wards.
 * Powers the building checklist in the edit modal for every role.
 */
export function useStakeBuildings() {
  const activeStakeId = useActiveStake();
  const q = useMemo(
    () => (activeStakeId ? buildingsCol(db, activeStakeId) : null),
    [activeStakeId],
  );
  return useFirestoreCollection<Building>(q);
}

export interface NewRequestFormData {
  /** Allowed request scopes for the principal in the active stake. */
  scopes: ScopeOption[];
  /** Buildings catalogue (checkbox group). `[]` until loaded. */
  buildings: readonly Building[];
  /** Wards catalogue (resolves ward-scope default buildings). `[]` until loaded. */
  wards: readonly Ward[];
  /** True while the buildings catalogue is still loading (the page /
   *  dialog gates the form on this). */
  isLoading: boolean;
}

/**
 * Shared data source for the New Request form — consumed by the
 * roster-header `NewRequestDialog`. Subscribes to the buildings + wards
 * catalogues and derives the principal's allowed scopes. `isLoading` is
 * true until the buildings catalogue has hydrated (the dialog gates the
 * form on it).
 */
export function useNewRequestFormData(): NewRequestFormData {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();

  const buildingsQuery = useMemo(
    () => (activeStakeId ? buildingsCol(db, activeStakeId) : null),
    [activeStakeId],
  );
  const buildings = useFirestoreCollection<Building>(buildingsQuery);

  const wardsQuery = useMemo(
    () => (activeStakeId ? wardsCol(db, activeStakeId) : null),
    [activeStakeId],
  );
  const wards = useFirestoreCollection<Ward>(wardsQuery);

  const scopes = useMemo(
    () => (activeStakeId ? allowedScopesFor(principal, activeStakeId, wards.data ?? []) : []),
    [principal, activeStakeId, wards.data],
  );

  return {
    scopes,
    buildings: buildings.data ?? [],
    wards: wards.data ?? [],
    isLoading: buildings.isLoading || buildings.data === undefined,
  };
}

// ---- Submit ---------------------------------------------------------

export interface SubmitRequestInput {
  type: 'add_manual' | 'add_temp' | 'remove' | 'edit_auto' | 'edit_manual' | 'edit_temp';
  scope: string;
  member_email: string;
  member_name: string;
  reason: string;
  comment: string;
  start_date?: string;
  end_date?: string;
  building_names: string[];
  /** Defaults to false on the wire; missing → false on read. */
  urgent?: boolean;
  /**
   * For `type='remove'` (T-43 Phase B): always set by the Phase B
   * SPA. For a primary-row remove, equals the seat's top-level
   * `kindoo_site_id`; for a duplicate-row remove, equals that
   * duplicate's `kindoo_site_id`. `removeSeatOnRequestComplete`
   * keys on the `(scope, kindoo_site_id)` pair to splice the right
   * grant. Field is typed optional only so legacy pre-Phase-B
   * `remove` requests on disk (with no `kindoo_site_id`) still
   * round-trip — the trigger falls back to scope-only matching in
   * that case.
   */
  kindoo_site_id?: string | null;
  /**
   * Organization the requested stake-scope grant belongs to. Meaningful
   * only when `scope === 'stake'` on an add/edit request; the optional
   * org selector supplies it (slug id, or null = "No Organization").
   * The mutation writes it ONLY for stake scope and only on add/edit
   * types — ward scope and `remove` / `edit_auto` never carry a stray
   * org id. Absent / undefined → not written.
   */
  organization_id?: string | null;
}

/**
 * Submit a new request. The mutation accepts the form-level shape and
 * fills derived fields (`request_id`, `status`, `requested_at`,
 * `requester_*`, `lastActor`, optional `seat_member_canonical` for
 * remove). The Firestore SDK assigns the doc id; we leave
 * `request_id` mirroring it on the doc body for convenience (rules
 * don't require equality).
 */
export function useSubmitRequest() {
  const qc = useQueryClient();
  const activeStakeId = useActiveStake();
  return useMutation({
    mutationFn: async (input: SubmitRequestInput) => {
      if (!activeStakeId) {
        throw new Error('No active stake.');
      }
      const user = auth.currentUser;
      if (!user || !user.email) {
        throw new Error('Not signed in.');
      }
      // Force-refresh the ID token so a freshly-minted claim (e.g.
      // operator just added themselves to kindooManagers / access)
      // lands on this request. The default cached token can lag the
      // server-side `setCustomUserClaims` + `revokeRefreshTokens` by
      // up to an hour; rules then deny because
      // `request.auth.token.canonical` / `.stakes[sid].stake` are
      // absent or stale.
      const tokenResult = await user.getIdTokenResult(true);
      const claims = tokenResult.claims as {
        canonical?: string;
        email?: string;
        stakes?: Record<string, { manager?: boolean; stake?: boolean; wards?: string[] }>;
      };
      const tokenCanonical = claims.canonical ?? canonicalEmail(user.email);

      const memberCanonical = canonicalEmail(input.member_email);
      const actor = { email: user.email, canonical: tokenCanonical };

      // Pre-allocate the doc id so we can stamp it on the body in one
      // create call. `addDoc` would split the create + update across
      // two writes, but the second write would have to flip status off
      // pending to satisfy the rules' update rule — which would defeat
      // the purpose. Pre-allocating the ref keeps the body internally
      // consistent in a single rules-allowed create.
      const ref = doc(requestsCol(db, activeStakeId));

      // The doc body. Rules require: status='pending',
      // requester_canonical = auth canonical, requested_at = request.time
      // (serverTimestamp), lastActor matches auth, member_name non-empty
      // for add types, ≥1 building for stake-scope add types, scope
      // matches requester role.
      const body: Record<string, unknown> = {
        request_id: ref.id,
        type: input.type,
        scope: input.scope,
        member_email: input.member_email.trim(),
        member_canonical: memberCanonical,
        member_name: input.member_name.trim(),
        reason: input.reason.trim(),
        comment: input.comment.trim(),
        building_names: input.building_names,
        status: 'pending',
        requester_email: user.email,
        requester_canonical: tokenCanonical,
        requested_at: serverTimestamp(),
        lastActor: actor,
      };
      if (input.type === 'add_temp' || input.type === 'edit_temp') {
        // `edit_temp` carries the full replacement date pair so the
        // markRequestComplete callable can write the seat's new window.
        // Rules apply the same ISO YYYY-MM-DD regex + start<=end gate
        // as `add_temp`.
        if (input.start_date) body.start_date = input.start_date;
        if (input.end_date) body.end_date = input.end_date;
      }
      if (input.type === 'remove') {
        // Denormalise the seat key so the completion path can locate
        // the seat doc without a query (Firestore client transactions
        // don't support queries).
        body.seat_member_canonical = memberCanonical;
        // T-43 Phase B: stamp `kindoo_site_id` on every remove
        // request. The Phase B SPA always passes it (primary row →
        // seat's top-level site; duplicate row → that duplicate's).
        // The optional `!== undefined` guard is defense-in-depth for
        // a hypothetical legacy caller path; the trigger's scope-only
        // fallback covers pre-Phase-B requests on disk that lack the
        // field.
        if (input.kindoo_site_id !== undefined) {
          body.kindoo_site_id = input.kindoo_site_id;
        }
      }
      if (input.urgent === true) {
        // Stamp only when truthy; missing field reads as false. Keeps
        // the on-disk doc lean for the common non-urgent path.
        body.urgent = true;
      }
      // Organization is meaningful only at stake scope on an add/edit
      // request. `edit_auto` is forbidden at stake (the selector is
      // never rendered there) and `remove` doesn't carry one, so the
      // org id only lands on the four stake-scope add/edit types.
      // Non-stake requests never carry a stray org id — we explicitly
      // write `null` so a stale value can't leak from a reused form.
      const ORG_BEARING_TYPES = ['add_manual', 'add_temp', 'edit_manual', 'edit_temp'] as const;
      if ((ORG_BEARING_TYPES as readonly string[]).includes(input.type)) {
        body.organization_id = input.scope === 'stake' ? (input.organization_id ?? null) : null;
      }
      // Diagnostic log: pasted into staging by the operator to surface
      // which rule predicate denied a permission-error submit. Pairs
      // the auth-token shape against the doc body so the rule check
      // can be reproduced byte-by-byte. Quiet in tests (NODE_ENV).
      // Remove or gate behind a flag once staging is happy.
      if (typeof console !== 'undefined' && process.env['NODE_ENV'] !== 'test') {
        console.log('[submit-request] payload', {
          docPath: `stakes/${activeStakeId}/requests/${ref.id}`,
          body,
          authEmail: user.email,
          tokenEmail: claims.email,
          tokenCanonical: claims.canonical,
          tokenStakes: claims.stakes,
        });
      }
      try {
        await setDoc(ref, body as unknown as AccessRequest);
      } catch (err) {
        if (typeof console !== 'undefined' && process.env['NODE_ENV'] !== 'test') {
          console.error('[submit-request] denied', {
            docPath: `stakes/${activeStakeId}/requests/${ref.id}`,
            scope: input.scope,
            type: input.type,
            tokenCanonical: claims.canonical,
            stakes: claims.stakes,
            err,
          });
        }
        throw err;
      }
      return { id: ref.id };
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
