// Reconciles `access` docs after a stake flips
// `stake.eq_president_app_access`. Flipping the flag changes which
// callings grant app access, but the flag alone doesn't touch the
// `access` docs already derived from existing seats — this callable
// sweeps the stake's auto ward-scope Elders Quorum President seats and
// grants or revokes the corresponding access in one pass.
//
// Decisions locked in:
//
//   - `direction` is an explicit parameter, guarded against the stake's
//     CURRENT config: `'grant'` requires the flag ON, `'revoke'`
//     requires it OFF. A stale dialog confirmation (config never saved,
//     or flipped back since) fails `failed-precondition` instead of
//     writing the wrong side.
//   - MERGE-ONLY per scope. We add / remove exactly the Elders Quorum
//     President entry inside `importer_callings[scope]`, leaving every
//     other calling in that scope's list alone. Deliberately NOT
//     `writeAccessForAutoScope`'s wholesale replace: rebuilding the
//     scope's list from the seat's callings would also silently "fix"
//     unrelated stale entries, which is beyond the action the operator
//     consented to.
//   - `manual_grants` is never read-modified in either direction. An
//     Elders Quorum President who also holds a manual grant keeps it on
//     revoke, and a manual-grants-only doc is never deleted.
//   - Skip-if-equal idempotency. A grant whose scope entry already
//     carries the calling, or a revoke whose entry doesn't, writes
//     nothing — a second run reports `docs_written: 0`.
//   - D25 tier stamp maintained in lockstep. An entry this run INSERTS
//     is stamped limited in `importer_limited_callings[scope]`, in the
//     same update as `importer_callings`; the revoke direction removes
//     the calling from both maps. An entry that already exists is left
//     alone in both maps by the skip above — the tier belongs to the
//     writer that inserted the record, and this callable does not
//     re-tier records it didn't write. Existing Elders Quorum Presidents
//     therefore stay FULL until their scope is next written, which is
//     D23(a)'s "not retroactive in either direction" applied to the tier.
//   - ≤250 seats at target scale: one `where('type','==','auto')` query
//     (single-field, no composite index) then in-memory filtering. No
//     pagination, no batching.
//
// Auth: KINDOO MANAGER OF THE STAKE. Same check as `syncApplyFix` —
// read `kindooManagers/{canonical}` directly rather than trusting the
// custom claim, which can be ~1h stale on an idle session.
//
// Actor: the calling human manager. This is a manager-confirmed action
// (they flipped the config and confirmed the backfill), so human
// attribution is correct — no synthetic system actor.
//
// Audit + claims are automatic. The parameterized `auditTrigger` fans
// `create_access` / `update_access` / `delete_access` rows from the
// resulting writes, and `syncAccessClaims` re-mints custom claims +
// revokes refresh tokens. We write neither here. One wrinkle on the
// revoke side: the audit trigger reads the BEFORE snapshot on a delete,
// so the branch that drops an emptied access doc stamps the manager
// onto `lastActor` in its own committed transaction first — otherwise
// `delete_access` would name whatever actor the doc happened to carry
// (typically a Sync actor) instead of the manager who confirmed this
// backfill. See the two-write note on that branch.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { EQ_PRESIDENT_CALLING, canonicalEmail, seatCallingOrder } from '@kindoo/shared';
import type {
  Access,
  ActorRef,
  BackfillEqPresidentAccessInput,
  BackfillEqPresidentAccessOutput,
  KindooManager,
  Seat,
  Stake,
} from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';

/** Normalisation key — trim + lowercase, the same scheme
 * `appAccessCallings.ts` / `callingSortOrder.ts` match on. */
function normalize(calling: string): string {
  return calling.trim().toLowerCase();
}

const EQ_PRESIDENT_KEY = normalize(EQ_PRESIDENT_CALLING);

/** Exact-title match only — the quorum's counselors and secretary never
 * grant access. */
function isEqPresident(calling: string): boolean {
  return normalize(calling) === EQ_PRESIDENT_KEY;
}

/**
 * Rebuild a per-scope calling map (`importer_callings` or its
 * `importer_limited_callings` tier stamp) with one scope's entry
 * replaced. Other scopes are copied verbatim; an empty replacement drops
 * the key entirely. Mirrors the map-rebuild pattern in `syncApplyFix.ts`.
 */
function rebuildScopeMap(
  prior: Record<string, string[]> | undefined,
  scope: string,
  next: string[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [s, c] of Object.entries(prior ?? {})) {
    if (s === scope) continue;
    if (c && c.length > 0) out[s] = [...c];
  }
  if (next.length > 0) out[scope] = next;
  return out;
}

function pickMin(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/** True iff any scope still carries at least one manual grant. */
function hasManualGrants(access: Access): boolean {
  return Object.values(access.manual_grants ?? {}).some((arr) => arr && arr.length > 0);
}

/**
 * Per-seat result. `delete-pending` is internal: the first transaction
 * stamped the actor and handed off to the second, which resolves to one
 * of the other three.
 */
type Outcome = 'skipped' | 'written' | 'deleted' | 'delete-pending';

/**
 * Run the reconcile over one stake. Exported so tests can drive it
 * without the callable wrapper; the callable owns auth + the
 * direction-vs-config guard.
 */
export async function backfillEqPresidentAccessForStake(
  db: Firestore,
  stakeId: string,
  direction: 'grant' | 'revoke',
  actor: ActorRef,
): Promise<BackfillEqPresidentAccessOutput> {
  // Single-field filter — no composite index needed. The scope / calling
  // predicates are applied in memory (≤250 seats at target scale).
  const seatsSnap = await db
    .collection(`stakes/${stakeId}/seats`)
    .where('type', '==', 'auto')
    .get();

  const matched = seatsSnap.docs
    .map((d) => d.data() as Seat)
    .filter((seat) => seat.scope !== 'stake' && (seat.callings ?? []).some(isEqPresident))
    // Stable order across runs, for readable audit fan-out.
    .sort((a, b) => a.member_canonical.localeCompare(b.member_canonical));

  const out: BackfillEqPresidentAccessOutput = {
    ok: true,
    seats_matched: matched.length,
    docs_written: 0,
    docs_deleted: 0,
  };

  const eqOrder = seatCallingOrder([EQ_PRESIDENT_CALLING]);

  for (const seat of matched) {
    const accessRef = db.doc(`stakes/${stakeId}/access/${seat.member_canonical}`);
    let outcome = await db.runTransaction<Outcome>(async (tx) => {
      const snap = await tx.get(accessRef);
      const access = snap.exists ? (snap.data() as Access) : undefined;
      const prior = access?.importer_callings?.[seat.scope] ?? [];
      const priorLimited = access?.importer_limited_callings?.[seat.scope] ?? [];
      const now = FieldValue.serverTimestamp();

      if (direction === 'grant') {
        // Already granted for this scope → nothing to do (idempotent).
        // Deliberately NOT re-stamping a pre-existing untiered entry:
        // the tier is decided when the record is written, and this
        // callable does not re-tier records it didn't insert (D23(a),
        // "the toggle is not retroactive in either direction").
        if (prior.some(isEqPresident)) return 'skipped';
        // Original casing preserved from the seat.
        const eqCallings = (seat.callings ?? []).filter(isEqPresident);
        const merged = [...new Set([...prior, ...eqCallings])].sort();
        // The D25 tier stamp for the entry this run inserts. Written in
        // the SAME update as `importer_callings` so the two can't drift;
        // the names are taken from `merged` so the stamp is a literal
        // subset of it. Any prior stamp for this scope is preserved.
        const mergedLimited = [
          ...new Set([...priorLimited, ...merged.filter(isEqPresident)]),
        ].sort();

        if (!access) {
          tx.set(accessRef, {
            member_canonical: seat.member_canonical,
            member_email: seat.member_email,
            member_name: seat.member_name,
            importer_callings: { [seat.scope]: merged },
            importer_limited_callings: { [seat.scope]: mergedLimited },
            manual_grants: {},
            sort_order: eqOrder,
            created_at: now,
            last_modified_at: now,
            last_modified_by: actor,
            lastActor: actor,
          });
          return 'written';
        }

        const priorSort = typeof access.sort_order === 'number' ? access.sort_order : null;
        // `tx.update`, NOT `tx.set(..., { merge: true })`: a merge
        // deep-merges nested maps key-by-key, which would strand stale
        // scope entries. `update` replaces both maps wholesale with the
        // ones we just rebuilt and leaves `manual_grants` (and every
        // other unmentioned field) untouched.
        tx.update(accessRef, {
          importer_callings: rebuildScopeMap(access.importer_callings, seat.scope, merged),
          importer_limited_callings: rebuildScopeMap(
            access.importer_limited_callings,
            seat.scope,
            mergedLimited,
          ),
          sort_order: pickMin(priorSort, eqOrder),
          last_modified_at: now,
          last_modified_by: actor,
          lastActor: actor,
        });
        return 'written';
      }

      // ---- revoke ----
      // No doc ⇒ nothing derived from this seat to reap.
      if (!access) return 'skipped';
      const next = prior.filter((c) => !isEqPresident(c));
      if (next.length === prior.length) return 'skipped';
      // The tier stamp goes with the calling it described.
      const nextLimited = priorLimited.filter((c) => !isEqPresident(c));

      const finalImporter = rebuildScopeMap(access.importer_callings, seat.scope, next);
      const finalLimited = rebuildScopeMap(
        access.importer_limited_callings,
        seat.scope,
        nextLimited,
      );
      if (Object.keys(finalImporter).length === 0 && !hasManualGrants(access)) {
        // Nothing left to keep the doc alive, so it gets dropped — but
        // the delete has to be a SEPARATE committed write. The audit
        // trigger reads the BEFORE snapshot on a delete, and a stamp +
        // delete inside one transaction coalesces to a bare delete: the
        // stamp never lands, and `delete_access` inherits whatever actor
        // the doc already carried instead of the confirming manager.
        // Same split, same reason, as `syncApplyFix`'s
        // `applySbaOnlyRemove`.
        //
        // Bookkeeping-only, so `isNoOpUpdate` suppresses an audit row for
        // it — the pair still fans exactly one `delete_access`. It also
        // keeps the seat's revoke all-or-nothing: a crash before the
        // second write leaves the calling in place for a clean re-run.
        tx.update(accessRef, {
          last_modified_at: now,
          last_modified_by: actor,
          lastActor: actor,
        });
        return 'delete-pending';
      }

      // MIN canonical order across everything still in the map; `null`
      // when the map is empty or nothing in it ranks (per the documented
      // `Access.sort_order` semantics).
      const remaining = Object.values(finalImporter).flat();
      tx.update(accessRef, {
        importer_callings: finalImporter,
        importer_limited_callings: finalLimited,
        sort_order: seatCallingOrder(remaining),
        last_modified_at: now,
        last_modified_by: actor,
        lastActor: actor,
      });
      return 'written';
    });

    if (outcome === 'delete-pending') {
      // Second committed write. It re-reads instead of trusting the
      // first transaction's view: a Sync write landing between the two
      // commits can re-add importer callings or a manual grant, and
      // deleting on the strength of the stale read would destroy access
      // the stake still wants. When that happens we fall through to the
      // ordinary revoke update — the same write this seat would have
      // taken had the concurrent change arrived a moment earlier — so
      // the calling is still reaped and `docs_written` still counts it.
      outcome = await db.runTransaction<Outcome>(async (tx) => {
        const snap = await tx.get(accessRef);
        // Deleted concurrently; the intended end state already holds.
        if (!snap.exists) return 'skipped';
        const fresh = snap.data() as Access;
        const freshNext = (fresh.importer_callings?.[seat.scope] ?? []).filter(
          (c) => !isEqPresident(c),
        );
        const freshNextLimited = (fresh.importer_limited_callings?.[seat.scope] ?? []).filter(
          (c) => !isEqPresident(c),
        );
        const freshImporter = rebuildScopeMap(fresh.importer_callings, seat.scope, freshNext);
        // The tier stamp is never part of the doc-existence test — it
        // stamps grants, it isn't one.
        if (Object.keys(freshImporter).length === 0 && !hasManualGrants(fresh)) {
          tx.delete(accessRef);
          return 'deleted';
        }
        tx.update(accessRef, {
          importer_callings: freshImporter,
          importer_limited_callings: rebuildScopeMap(
            fresh.importer_limited_callings,
            seat.scope,
            freshNextLimited,
          ),
          sort_order: seatCallingOrder(Object.values(freshImporter).flat()),
          last_modified_at: FieldValue.serverTimestamp(),
          last_modified_by: actor,
          lastActor: actor,
        });
        return 'written';
      });
    }

    if (outcome === 'written') out.docs_written += 1;
    else if (outcome === 'deleted') out.docs_deleted += 1;
  }

  return out;
}

export const backfillEqPresidentAccess = onCall(
  {
    timeoutSeconds: 540,
    memory: '512MiB',
    serviceAccount: APP_SA,
  },
  async (req): Promise<BackfillEqPresidentAccessOutput> => {
    if (!req.auth) {
      throw new HttpsError('unauthenticated', 'sign in required');
    }
    const data = (req.data ?? {}) as Partial<BackfillEqPresidentAccessInput>;
    const stakeId = data.stakeId;
    if (!stakeId || typeof stakeId !== 'string') {
      throw new HttpsError('invalid-argument', 'stakeId required');
    }
    const direction = data.direction;
    if (direction !== 'grant' && direction !== 'revoke') {
      throw new HttpsError('invalid-argument', "direction must be 'grant' or 'revoke'");
    }

    const typedEmail = req.auth.token.email;
    if (!typedEmail) {
      throw new HttpsError('failed-precondition', 'auth token has no email');
    }
    const callerCanonical = canonicalEmail(typedEmail);

    const db = getDb();
    const mgrSnap = await db.doc(`stakes/${stakeId}/kindooManagers/${callerCanonical}`).get();
    if (!mgrSnap.exists) {
      throw new HttpsError('permission-denied', 'caller is not a manager of this stake');
    }
    const mgr = mgrSnap.data() as KindooManager;
    if (mgr.active !== true) {
      throw new HttpsError('permission-denied', 'manager record is inactive');
    }

    // Direction must match the stake's CURRENT config. Makes a stale
    // dialog confirmation harmless and keeps a retry unambiguous.
    const stakeSnap = await db.doc(`stakes/${stakeId}`).get();
    const enabled =
      (stakeSnap.data() as Partial<Stake> | undefined)?.eq_president_app_access === true;
    if (direction === 'grant' && !enabled) {
      throw new HttpsError(
        'failed-precondition',
        'Elders Quorum President app access is not enabled for this stake — save the config first, then run the backfill.',
      );
    }
    if (direction === 'revoke' && enabled) {
      throw new HttpsError(
        'failed-precondition',
        'Elders Quorum President app access is still enabled for this stake — save the config first, then run the backfill.',
      );
    }

    const actor: ActorRef = { email: typedEmail, canonical: callerCanonical };
    return backfillEqPresidentAccessForStake(db, stakeId, direction, actor);
  },
);
