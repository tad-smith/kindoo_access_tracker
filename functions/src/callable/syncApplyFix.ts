// Chrome-extension bridge: applies a single per-row Fix from the Sync
// Phase 2 drift report. Each invocation handles one discrepancy code on
// one seat — no bulk endpoint, no confirmation dance.
//
// Kindoo is the authoritative source: sync never writes SBA → Kindoo.
// Provisioning into Kindoo flows through SBA requests, not sync. Every
// drift code is now an SBA-side mutation that flows through this
// callable. `sba-only` is an SBA-side delete: an SBA seat with no
// Kindoo presence is an orphan (Kindoo, the authority, doesn't have
// it), so we delete it. (It was previously a Kindoo-side write —
// "Provision in Kindoo" — handled by the extension and never reaching
// the backend; the Kindoo-authoritative shift made it an SBA-side
// "Remove From SBA" delete.)
//
// Per-axis single-field writes are intentional: the operator picks each
// axis independently in the drift UI. If two axes are misaligned on the
// same seat, the second drift row re-emits on the next sync run.
//
// `kindoo-unparseable` is an SBA-side update for a Kindoo Description
// that is present but doesn't parse as `Scope (Calling)`: such a
// description is treated as a church-wide calling, so the seat is moved
// to stake scope and its calling is set from the raw description text
// (per the §6.1 convention — `callings[]` for auto, free-text `reason`
// for manual / temp). Blank descriptions stay review-only and are
// handled extension-side; they never reach this callable.
//
// Auth: same authority check as `markRequestComplete` — read the
// `kindooManagers/{canonical}` doc directly (custom claims can be ~1h
// stale on idle sessions; the doc is the source of truth at call time).
//
// Audit: every write stamps `lastActor: SyncActor(code)`. The
// parameterised `auditSeatWrites` trigger fans the audit row from the
// resulting Firestore write — we never write audit rows directly here.
//
// Failure envelope:
//   - shape / auth errors → `HttpsError` (matches other callables)
//   - domain misses (seat not found, seat already exists) →
//     `{ success: false, error }` so the extension can surface a clean
//     inline message without trapping a thrown error.
//
// Auto-seat bookkeeping: `applyKindooOnly` / `applyCallingsMismatch`
// / `applyTypeMismatch` stamp `sort_order` from the canonical churchwide
// calling order (`@kindoo/shared:seatCallingOrder`) and reconcile the
// corresponding access doc against the hard-coded app-access calling sets
// (`filterAppAccessCallings` — ward callings for ward scopes, stake
// callings for 'stake' scope). `applyScopeMismatch` /
// `applyBuildingsMismatch` don't touch type or callings, so that
// bookkeeping doesn't apply to them.
//
// `callings-mismatch` REPLACES the auto seat's `callings[]` wholesale to
// match Kindoo's parsed calling(s) (Kindoo authoritative — a renamed
// calling replaces the old name, not appended), recomputes `sort_order`,
// and reconciles the scope's `importer_callings`. Because a replace can
// REMOVE access (the old callings may have granted app access the new
// ones don't), the access reconcile writes the new grant set when
// non-empty and clears `importer_callings[scope]` when empty.
//
// Seat shape on type flip (`applyTypeMismatch`, grant-derived
// promote / demote — see `extension/docs/sync-design.md` "Grant-derived
// seat type"): the §6.1 convention is auto seats carry the calling in
// `callings[]` (empty `reason`), manual / temp seats carry
// `callings: []` with the calling in free-text `reason`. Promote sets
// `callings[]` from the payload (fallback `[reason]`) and clears
// `reason`; demote folds `callings[]` into `reason` and clears
// `callings[]`. Without this the flip would leave a spec-violating
// hybrid seat.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import {
  canonicalEmail,
  filterAppAccessCallings,
  resolveWardSite,
  seatCallingOrder,
} from '@kindoo/shared';
import type {
  Access,
  ActorRef,
  Building,
  BuildingsMismatchPayload,
  CallingsMismatchPayload,
  KindooManager,
  KindooOnlyPayload,
  KindooUnparseablePayload,
  SbaOnlyRemovePayload,
  ScopeMismatchPayload,
  Seat,
  SyncApplyFixInput,
  SyncApplyFixResult,
  TypeMismatchPayload,
  Ward,
} from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';
import { syncActor } from '../lib/systemActors.js';

/** Seat type values the callable accepts. Matches `SeatType` in the
 * shared types; restated locally so we can validate the raw input. */
const VALID_SEAT_TYPES = new Set(['auto', 'manual', 'temp']);

/** De-duplicate while preserving first-seen order. */
function dedupePreserveOrder(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/** Trim + reject empty strings from a string array. */
function cleanStringArray(items: unknown, field: string): string[] {
  if (!Array.isArray(items)) {
    throw new HttpsError('invalid-argument', `${field} must be an array of strings`);
  }
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') {
      throw new HttpsError('invalid-argument', `${field} entries must be strings`);
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpsError('invalid-argument', `${field} required`);
  }
  return value;
}

function requireSeatType(value: unknown, field: string): Seat['type'] {
  if (typeof value !== 'string' || !VALID_SEAT_TYPES.has(value)) {
    throw new HttpsError('invalid-argument', `${field} must be 'auto', 'manual', or 'temp'`);
  }
  return value as Seat['type'];
}

export const syncApplyFix = onCall(
  { serviceAccount: APP_SA },
  async (req): Promise<SyncApplyFixResult> => {
    if (!req.auth) {
      throw new HttpsError('unauthenticated', 'sign in required');
    }
    const data = (req.data ?? {}) as Partial<SyncApplyFixInput>;
    const stakeId = data.stakeId;
    if (!stakeId || typeof stakeId !== 'string') {
      throw new HttpsError('invalid-argument', 'stakeId required');
    }
    const fix = data.fix;
    if (!fix || typeof fix !== 'object') {
      throw new HttpsError('invalid-argument', 'fix required');
    }
    if (typeof fix.code !== 'string') {
      throw new HttpsError('invalid-argument', 'fix.code required');
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

    const code: string = fix.code;
    switch (code) {
      case 'kindoo-only':
        return applyKindooOnly(stakeId, fix.payload as KindooOnlyPayload);
      case 'callings-mismatch':
        return applyCallingsMismatch(stakeId, fix.payload as CallingsMismatchPayload);
      case 'scope-mismatch':
        return applyScopeMismatch(stakeId, fix.payload as ScopeMismatchPayload);
      case 'type-mismatch':
        return applyTypeMismatch(stakeId, fix.payload as TypeMismatchPayload);
      case 'kindoo-unparseable':
        return applyKindooUnparseable(stakeId, fix.payload as KindooUnparseablePayload);
      case 'buildings-mismatch':
        return applyBuildingsMismatch(stakeId, fix.payload as BuildingsMismatchPayload);
      case 'sba-only':
        return applySbaOnlyRemove(stakeId, fix.payload as SbaOnlyRemovePayload);
      default:
        throw new HttpsError('invalid-argument', `unknown fix code: ${code}`);
    }
  },
);

async function applyKindooOnly(
  stakeId: string,
  payload: KindooOnlyPayload | undefined,
): Promise<SyncApplyFixResult> {
  if (!payload || typeof payload !== 'object') {
    throw new HttpsError('invalid-argument', 'payload required');
  }
  const memberEmail = requireString(payload.memberEmail, 'memberEmail');
  const memberName = requireString(payload.memberName, 'memberName');
  const scope = requireString(payload.scope, 'scope');
  const type = requireSeatType(payload.type, 'type');
  const callings = cleanStringArray(payload.callings ?? [], 'callings');
  const buildingNames = cleanStringArray(payload.buildingNames ?? [], 'buildingNames');
  if (typeof payload.isTempUser !== 'boolean') {
    throw new HttpsError('invalid-argument', 'isTempUser must be a boolean');
  }
  const reason =
    typeof payload.reason === 'string' && payload.reason.trim().length > 0
      ? payload.reason.trim()
      : undefined;
  const startDate =
    typeof payload.startDate === 'string' && payload.startDate.trim().length > 0
      ? payload.startDate.trim()
      : undefined;
  const endDate =
    typeof payload.endDate === 'string' && payload.endDate.trim().length > 0
      ? payload.endDate.trim()
      : undefined;

  const canonical = canonicalEmail(memberEmail);
  if (canonical === '') {
    throw new HttpsError('invalid-argument', 'memberEmail did not canonicalize');
  }

  const db = getDb();
  const seatRef = db.doc(`stakes/${stakeId}/seats/${canonical}`);
  const accessRef = db.doc(`stakes/${stakeId}/access/${canonical}`);
  const actor = syncActor('kindoo-only');
  const dedupedCallings = dedupePreserveOrder(callings);

  // Auto seats carry a canonical `sort_order` + access-doc parity.
  // Manual / temp seats don't (Sync leaves both fields alone).
  const isAuto = type === 'auto';

  const result = await db.runTransaction<SyncApplyFixResult>(async (tx) => {
    // All transaction reads must precede any write.
    const seatSnap = await tx.get(seatRef);
    if (seatSnap.exists) {
      return { success: false, error: 'seat already exists for that member' };
    }

    let sortOrder: number | null = null;
    let accessCallings: string[] = [];
    let priorAccess: Access | undefined;
    if (isAuto) {
      sortOrder = seatCallingOrder(dedupedCallings);
      accessCallings = filterAppAccessCallings(scope, dedupedCallings);
      const accessSnap = await tx.get(accessRef);
      if (accessSnap.exists) priorAccess = accessSnap.data() as Access;
    }

    const now = Timestamp.now();
    const body: Record<string, unknown> = {
      member_canonical: canonical,
      member_email: memberEmail,
      member_name: memberName,
      scope,
      type,
      callings: dedupedCallings,
      building_names: dedupePreserveOrder(buildingNames),
      duplicate_grants: [],
      // T-42 / T-43: server-maintained primitive mirror of
      // `duplicate_grants[].scope`. Always set, even when empty.
      duplicate_scopes: [],
      created_at: now,
      last_modified_at: now,
      last_modified_by: actor,
      lastActor: actor,
    };
    if (isAuto) body.sort_order = sortOrder;
    if (reason !== undefined) body.reason = reason;
    if (type === 'temp') {
      if (startDate !== undefined) body.start_date = startDate;
      if (endDate !== undefined) body.end_date = endDate;
    }
    tx.set(seatRef, body);

    if (isAuto && accessCallings.length > 0) {
      writeAccessForAutoScope(tx, accessRef, {
        canonical,
        memberEmail,
        memberName,
        scope,
        callings: accessCallings,
        sortOrder,
        priorAccess,
        actor,
      });
    }

    return { success: true, seatId: canonical };
  });

  return result;
}

/**
 * `callings-mismatch` — REPLACE an auto seat's `callings[]` with Kindoo's
 * parsed calling(s) (Kindoo is authoritative). A renamed calling replaces
 * the old name wholesale (Kindoo `Bishopric Clerk`, seat `Bishop` → seat
 * becomes `['Bishopric Clerk']`, NOT `['Bishop', 'Bishopric Clerk']`).
 * Sibling of `scope-mismatch` / `buildings-mismatch`.
 *
 * Because a replace can REMOVE access (the old callings may have been in
 * the scope's app-access set, the new ones not), the scope's access is
 * reconciled the same way `applyTypeMismatch` does: when the new callings
 * still earn a grant, `writeAccessForAutoScope` rewrites
 * `importer_callings[scope]`; when they don't, `clearImporterCallingsForScope`
 * drops the scope's entry (deleting the doc when both maps go empty,
 * `manual_grants` always preserved).
 *
 * Auto-only by construction (the detector emits this code for auto seats
 * only). A non-auto seat is rejected with `failed-precondition` rather
 * than written — replacing `callings[]` on a manual / temp seat would
 * mint a §6.1-violating hybrid (callings AND free-text reason).
 */
async function applyCallingsMismatch(
  stakeId: string,
  payload: CallingsMismatchPayload | undefined,
): Promise<SyncApplyFixResult> {
  if (!payload || typeof payload !== 'object') {
    throw new HttpsError('invalid-argument', 'payload required');
  }
  const memberEmail = requireString(payload.memberEmail, 'memberEmail');
  // The FULL target set = Kindoo's parsed calling(s). A real auto-seat
  // callings-mismatch always has a target, so an empty set is malformed.
  const callings = cleanStringArray(payload.callings ?? [], 'callings');
  if (callings.length === 0) {
    throw new HttpsError(
      'invalid-argument',
      'callings must not be empty — a callings-mismatch always replaces with a non-empty target',
    );
  }
  const newCallings = dedupePreserveOrder(callings);
  const canonical = canonicalEmail(memberEmail);
  if (canonical === '') {
    throw new HttpsError('invalid-argument', 'memberEmail did not canonicalize');
  }

  const db = getDb();
  const seatRef = db.doc(`stakes/${stakeId}/seats/${canonical}`);
  const accessRef = db.doc(`stakes/${stakeId}/access/${canonical}`);
  const actor = syncActor('callings-mismatch');

  return db.runTransaction<SyncApplyFixResult>(async (tx) => {
    // All reads before any write.
    const snap = await tx.get(seatRef);
    if (!snap.exists) {
      return { success: false, error: 'seat not found' };
    }
    const seat = snap.data() as Seat;

    // `callings-mismatch` mirrors Kindoo's calling onto an AUTO seat's
    // `callings[]` (§6.1: auto seats carry the calling there, no `reason`).
    // The detector only emits it for auto seats, so a non-auto seat here
    // is a malformed request — replacing `callings[]` on a manual / temp
    // seat would mint a §6.1-violating hybrid (callings AND reason). Reject
    // rather than write it.
    if (seat.type !== 'auto') {
      throw new HttpsError('failed-precondition', 'callings-mismatch applies to auto seats only');
    }

    const update: Record<string, unknown> = {
      callings: newCallings,
      last_modified_at: FieldValue.serverTimestamp(),
      last_modified_by: actor,
      lastActor: actor,
    };

    update.sort_order = seatCallingOrder(newCallings);

    // REPLACE can remove access: recompute the grant set from the NEW
    // callings against the scope's app-access set, then either rewrite the
    // scope's importer_callings or clear it. Read the access doc before
    // any write.
    const accessCallings = filterAppAccessCallings(seat.scope, newCallings);
    const accessSnap = await tx.get(accessRef);
    if (accessCallings.length > 0) {
      writeAccessForAutoScope(tx, accessRef, {
        canonical,
        memberEmail: seat.member_email ?? memberEmail,
        memberName: seat.member_name ?? '',
        scope: seat.scope,
        callings: accessCallings,
        sortOrder: update.sort_order as number | null,
        priorAccess: accessSnap.exists ? (accessSnap.data() as Access) : undefined,
        actor,
      });
    } else if (accessSnap.exists) {
      // The new callings earn no grant; drop the old scope's entry
      // (deletes the doc when both maps go empty).
      clearImporterCallingsForScope(tx, accessRef, {
        access: accessSnap.data() as Access,
        scope: seat.scope,
        actor,
      });
    }

    tx.update(seatRef, update);
    return { success: true, seatId: canonical };
  });
}

async function applyScopeMismatch(
  stakeId: string,
  payload: ScopeMismatchPayload | undefined,
): Promise<SyncApplyFixResult> {
  if (!payload || typeof payload !== 'object') {
    throw new HttpsError('invalid-argument', 'payload required');
  }
  const memberEmail = requireString(payload.memberEmail, 'memberEmail');
  const newScope = requireString(payload.newScope, 'newScope');
  const canonical = canonicalEmail(memberEmail);
  if (canonical === '') {
    throw new HttpsError('invalid-argument', 'memberEmail did not canonicalize');
  }

  const db = getDb();
  const seatRef = db.doc(`stakes/${stakeId}/seats/${canonical}`);
  const wardRef = newScope !== 'stake' ? db.doc(`stakes/${stakeId}/wards/${newScope}`) : null;
  const buildingsRef = db.collection(`stakes/${stakeId}/buildings`);
  const actor = syncActor('scope-mismatch');

  return db.runTransaction<SyncApplyFixResult>(async (tx) => {
    // All reads before any write.
    const snap = await tx.get(seatRef);
    if (!snap.exists) {
      return { success: false, error: 'seat not found' };
    }
    // For a ward `newScope`, resolve the new ward's Kindoo site from its
    // building so the moved seat carries the right site. Reads happen up
    // front to satisfy reads-before-writes.
    let newSiteId: string | null | undefined; // undefined ⇒ leave field untouched
    if (wardRef) {
      const [wardSnap, buildingsSnap] = await Promise.all([tx.get(wardRef), tx.get(buildingsRef)]);
      if (wardSnap.exists) {
        const ward = wardSnap.data() as Ward;
        const buildings = buildingsSnap.docs.map((d) => d.data() as Building);
        newSiteId = resolveWardSite(ward, buildings);
      }
    }

    const update: Record<string, unknown> = {
      scope: newScope,
      last_modified_at: FieldValue.serverTimestamp(),
      last_modified_by: actor,
      lastActor: actor,
    };
    if (newScope === 'stake') {
      // Stake-scope primaries resolve to the home site (spec §15 Phase 1):
      // `kindoo_site_id` must be null/absent. A foreign-site ward seat
      // that scope-mismatches to stake would otherwise keep its foreign
      // site id and `projectSeatForSite` would resolve it off-home.
      // Mirrors `applyKindooUnparseable`.
      update.kindoo_site_id = FieldValue.delete();
    } else if (newSiteId !== undefined) {
      // Ward `newScope`: stamp the new ward's building-derived site.
      // `null` (home ward) stores explicit null; a foreign id stores it.
      // An unresolvable ward leaves `newSiteId === undefined`, so the
      // field is left untouched and the ward-fallback handles it.
      update.kindoo_site_id = newSiteId;
    }
    tx.update(seatRef, update);
    return { success: true, seatId: canonical };
  });
}

async function applyTypeMismatch(
  stakeId: string,
  payload: TypeMismatchPayload | undefined,
): Promise<SyncApplyFixResult> {
  if (!payload || typeof payload !== 'object') {
    throw new HttpsError('invalid-argument', 'payload required');
  }
  const memberEmail = requireString(payload.memberEmail, 'memberEmail');
  const newType = requireSeatType(payload.newType, 'newType');
  // Promote-only: the Kindoo-parsed calling(s) the extension sends so
  // the resulting auto seat carries a populated `callings[]`. Ignored
  // on demote (the calling is sourced from the seat's own callings).
  const payloadCallings = cleanStringArray(payload.callings ?? [], 'callings');
  const canonical = canonicalEmail(memberEmail);
  if (canonical === '') {
    throw new HttpsError('invalid-argument', 'memberEmail did not canonicalize');
  }

  const db = getDb();
  const seatRef = db.doc(`stakes/${stakeId}/seats/${canonical}`);
  const accessRef = db.doc(`stakes/${stakeId}/access/${canonical}`);
  const actor = syncActor('type-mismatch');

  return db.runTransaction<SyncApplyFixResult>(async (tx) => {
    const snap = await tx.get(seatRef);
    if (!snap.exists) {
      return { success: false, error: 'seat not found' };
    }
    const seat = snap.data() as Seat;
    const update: Record<string, unknown> = {
      type: newType,
      last_modified_at: FieldValue.serverTimestamp(),
      last_modified_by: actor,
      lastActor: actor,
    };

    // Reshape the seat to the §6.1 convention on the type flip, then run
    // the auto-seat `sort_order` + access-doc bookkeeping off the
    // reshaped callings. §6.1: auto seats carry the calling in
    // `callings[]` (empty `reason`); manual / temp seats carry
    // `callings: []` with the calling in free-text `reason`.
    // - manual / temp → auto (promote): set `callings[]` from the
    //   payload (fallback `[seat.reason]`), clear `reason`, stamp
    //   sort_order, write access doc(s).
    // - auto → manual / temp (demote): set `reason` from the joined
    //   existing callings, clear `callings[]`, clear sort_order, drop
    //   importer_callings for the seat's scope; if both importer_callings
    //   and manual_grants end up empty, the access doc is deleted.
    if (newType === 'auto' && seat.type !== 'auto') {
      const reason = typeof seat.reason === 'string' ? seat.reason.trim() : '';
      const autoCallings = dedupePreserveOrder(
        payloadCallings.length > 0 ? payloadCallings : reason.length > 0 ? [reason] : [],
      );
      update.callings = autoCallings;
      update.reason = FieldValue.delete();

      const newSortOrder = seatCallingOrder(autoCallings);
      update.sort_order = newSortOrder;
      const accessCallings = filterAppAccessCallings(seat.scope, autoCallings);
      if (accessCallings.length > 0) {
        const accessSnap = await tx.get(accessRef);
        const priorAccess = accessSnap.exists ? (accessSnap.data() as Access) : undefined;
        writeAccessForAutoScope(tx, accessRef, {
          canonical,
          memberEmail: seat.member_email ?? memberEmail,
          memberName: seat.member_name ?? '',
          scope: seat.scope,
          callings: accessCallings,
          sortOrder: newSortOrder,
          priorAccess,
          actor,
        });
      }
    } else if (newType !== 'auto' && seat.type === 'auto') {
      // Demote: fold the auto calling(s) into the free-text reason and
      // clear `callings[]` (manual / temp convention). Preserve an
      // existing non-empty reason if the seat somehow already had one.
      const existingReason = typeof seat.reason === 'string' ? seat.reason.trim() : '';
      const reasonFromCallings = (seat.callings ?? []).join(', ').trim();
      const reason = existingReason.length > 0 ? existingReason : reasonFromCallings;
      if (reason.length > 0) update.reason = reason;
      update.callings = [];

      update.sort_order = FieldValue.delete();
      const accessSnap = await tx.get(accessRef);
      if (accessSnap.exists) {
        clearImporterCallingsForScope(tx, accessRef, {
          access: accessSnap.data() as Access,
          scope: seat.scope,
          actor,
        });
      }
    }

    tx.update(seatRef, update);
    return { success: true, seatId: canonical };
  });
}

/**
 * `kindoo-unparseable` — a Kindoo Description that is present but doesn't
 * parse as `Scope (Calling)` is treated as a CHURCH-WIDE calling applied
 * at stake scope. We move the seat to `scope = 'stake'`, clear any
 * foreign `kindoo_site_id` (stake-scope primaries resolve to the home
 * site, spec §15 Phase 1), keep its existing `type`, and set the calling
 * from the raw description text per the §6.1 convention (auto →
 * `callings[]`; manual / temp → free-text `reason`, callings cleared,
 * temp dates preserved).
 *
 * Access-doc handling (AUTO seats only — manual / temp carry no
 * `importer_callings`): the seat is leaving its old scope, so we reap the
 * old scope's calling-derived grant (Kindoo-authoritative reap, #183).
 * Whether the member KEEPS SBA app access then depends on the calling:
 *
 *   - If `calling` is in the STAKE app-access calling set, we write a
 *     fresh `importer_callings['stake'] = [calling]`. "Unparseable" only
 *     means the description didn't match `Scope (Calling)`; a bare
 *     app-access calling name (e.g. `Stake Clerk`, no parens) reaches
 *     this path and IS a real grant, so dropping its access would be a
 *     silent regression. The seat keeps stake-scope access.
 *   - If `calling` is not in the stake app-access set, no new grant is
 *     written (the old scope is still reaped). A genuinely free-text
 *     church-wide calling confers no SBA app access via sync; if it ever
 *     should, that flows through a manual grant.
 *
 * The whole access-doc reshape is ONE coherent write
 * (`writeStakeScopeAccessForUnparseable`): it computes the final
 * `importer_callings` (old scope dropped, stake entry added iff the
 * calling grants stake access), then either deletes the doc (final
 * importer empty AND no manual grants) or writes it. The access-doc read
 * precedes that write, satisfying Firestore reads-before-writes.
 */
async function applyKindooUnparseable(
  stakeId: string,
  payload: KindooUnparseablePayload | undefined,
): Promise<SyncApplyFixResult> {
  if (!payload || typeof payload !== 'object') {
    throw new HttpsError('invalid-argument', 'payload required');
  }
  const memberEmail = requireString(payload.memberEmail, 'memberEmail');
  const calling = requireString(payload.calling, 'calling').trim();
  const canonical = canonicalEmail(memberEmail);
  if (canonical === '') {
    throw new HttpsError('invalid-argument', 'memberEmail did not canonicalize');
  }

  const db = getDb();
  const seatRef = db.doc(`stakes/${stakeId}/seats/${canonical}`);
  const accessRef = db.doc(`stakes/${stakeId}/access/${canonical}`);
  const actor = syncActor('kindoo-unparseable');

  return db.runTransaction<SyncApplyFixResult>(async (tx) => {
    // All reads before any write.
    const snap = await tx.get(seatRef);
    if (!snap.exists) {
      return { success: false, error: 'seat not found' };
    }
    const seat = snap.data() as Seat;
    const oldScope = seat.scope;

    const update: Record<string, unknown> = {
      scope: 'stake',
      // Stake-scope primary grants resolve to the home site (spec §15
      // Phase 1): `kindoo_site_id` must be null/absent. The seat may have
      // carried a foreign site id (Sync run against a foreign site), so
      // clear it on every type. See packages/shared/src/types/seat.ts.
      kindoo_site_id: FieldValue.delete(),
      last_modified_at: FieldValue.serverTimestamp(),
      last_modified_by: actor,
      lastActor: actor,
    };

    if (seat.type === 'auto') {
      // §6.1 auto convention: calling lives in `callings[]`, no `reason`.
      update.callings = dedupePreserveOrder([calling]);
      update.reason = FieldValue.delete();

      // Access doc: reap the OLD scope's calling-derived grant, then —
      // iff `calling` is in the STAKE app-access set — write a fresh
      // `importer_callings['stake']` so the member keeps SBA app access.
      // "Unparseable" only means the description doesn't match
      // `Scope (Calling)`; a bare app-access calling (e.g. `Stake Clerk`)
      // reaches here and IS a real grant, so we must not silently drop
      // access. The access-doc read happens before any write to satisfy
      // Firestore's reads-before-writes rule.
      const accessSnap = await tx.get(accessRef);
      const stakeSort = seatCallingOrder([calling]);
      const stakeHasGrant = filterAppAccessCallings('stake', [calling]).length > 0;
      // The seat's `sort_order` comes from the canonical churchwide order
      // (parity with `applyKindooOnly` / `applyCallingsMismatch`); `null`
      // for an unknown calling. The access grant is gated on the stake
      // app-access set separately.
      update.sort_order = stakeSort;

      writeStakeScopeAccessForUnparseable(tx, accessRef, {
        canonical,
        memberEmail: seat.member_email ?? memberEmail,
        memberName: seat.member_name ?? '',
        oldScope,
        calling,
        stakeSort,
        stakeHasGrant,
        priorAccess: accessSnap.exists ? (accessSnap.data() as Access) : undefined,
        actor,
      });
    } else {
      // §6.1 manual / temp convention: calling lives in free-text `reason`,
      // `callings[]` cleared. Temp seats keep their existing dates.
      update.reason = calling;
      update.callings = [];
    }

    tx.update(seatRef, update);
    return { success: true, seatId: canonical };
  });
}

async function applyBuildingsMismatch(
  stakeId: string,
  payload: BuildingsMismatchPayload | undefined,
): Promise<SyncApplyFixResult> {
  if (!payload || typeof payload !== 'object') {
    throw new HttpsError('invalid-argument', 'payload required');
  }
  const memberEmail = requireString(payload.memberEmail, 'memberEmail');
  const newBuildingNames = dedupePreserveOrder(
    cleanStringArray(payload.newBuildingNames ?? [], 'newBuildingNames'),
  );
  // Guardrail: never clear all buildings from a seat. A drift fix that
  // resolves to an empty building list is a malformed reconciliation
  // request, not a valid "remove every building" instruction.
  if (newBuildingNames.length === 0) {
    throw new HttpsError(
      'invalid-argument',
      'newBuildingNames must not be empty — refusing to clear all buildings from the seat',
    );
  }
  const canonical = canonicalEmail(memberEmail);
  if (canonical === '') {
    throw new HttpsError('invalid-argument', 'memberEmail did not canonicalize');
  }

  const db = getDb();
  const seatRef = db.doc(`stakes/${stakeId}/seats/${canonical}`);
  const actor = syncActor('buildings-mismatch');

  return db.runTransaction<SyncApplyFixResult>(async (tx) => {
    const snap = await tx.get(seatRef);
    if (!snap.exists) {
      return { success: false, error: 'seat not found' };
    }
    tx.update(seatRef, {
      building_names: newBuildingNames,
      last_modified_at: FieldValue.serverTimestamp(),
      last_modified_by: actor,
      lastActor: actor,
    });
    return { success: true, seatId: canonical };
  });
}

/**
 * `sba-only` — Kindoo-authoritative orphan delete ("Remove From SBA").
 * The drift report found an SBA seat with no Kindoo presence; since
 * Kindoo is the authority, the SBA seat is stale and gets removed.
 *
 * Both branches re-read the seat INSIDE a transaction and re-validate
 * `duplicate_grants[]` before acting, so a concurrent
 * `markRequestComplete` between the outer read and the write can't be
 * silently clobbered.
 *
 * Mirrors `removeSeatOnRequestComplete`'s seat-removal semantics:
 *   - No `duplicate_grants[]` (the common orphan case) → delete the
 *     seat. To attribute the deletion to `SyncActor:sba-only` in the
 *     audit log we stamp `lastActor` (a bookkeeping-only write the audit
 *     trigger no-ops), then delete.
 *     Stamp + reap happen in ONE transaction; the bare `delete()` is a
 *     separate second committed write. They can't share a transaction —
 *     a stamp + delete inside one tx collapses to a bare delete whose
 *     BEFORE carries the seat's *prior* actor, mis-attributing the row.
 *     Reaping inside the same tx as the stamp (rather than after the
 *     delete) keeps the reaping guarantee retry-safe: a reap/stamp
 *     failure leaves seat + access intact; a delete failure leaves the
 *     seat alive with access already reaped. Either self-heals on retry
 *     or on the next Sync round.
 *   - Has `duplicate_grants[]` → the member holds other-site / other-
 *     scope access we must not nuke. Promote the first duplicate to
 *     primary (same field copy the remove trigger does) instead of
 *     deleting, in a transactional update stamped with the Sync actor;
 *     the audit trigger fans an `update_seat` row.
 *
 * Access reap: the removed primary's `scope` is cleared from the
 * member's `access/{canonical}` doc via `clearImporterCallingsForScope`
 * — the same blessed helper the demote path uses. This drops the
 * calling-derived `importer_callings[scope]` (so `syncAccessClaims`
 * stops granting SBA app access on the strength of a calling that no
 * longer has a seat), preserves `manual_grants` (deliberate manager
 * grants are independent of seats), preserves other scopes'
 * `importer_callings`, and deletes the access doc iff BOTH maps end up
 * empty. A manual/temp orphan carries no `importer_callings`, so the
 * reap is a harmless no-op for it. On promote, the cleared scope is the
 * REMOVED primary's — the promoted scope's `importer_callings` survives
 * because the member still holds that seat.
 *
 * Audit caveat: the reap's `update_access` row is stamped with
 * `SyncActor:sba-only`, but when the helper DELETES the access doc
 * (both maps went empty) its bare `tx.delete` fans a `delete_access`
 * row attributed to the doc's PRIOR `lastActor`, not the Sync actor.
 * Pre-existing — shared with the `type-mismatch` demote path — and
 * accepted at our scale rather than adding a stamp-then-delete dance
 * for the access doc.
 */
async function applySbaOnlyRemove(
  stakeId: string,
  payload: SbaOnlyRemovePayload | undefined,
): Promise<SyncApplyFixResult> {
  if (!payload || typeof payload !== 'object') {
    throw new HttpsError('invalid-argument', 'payload required');
  }
  const memberEmail = requireString(payload.memberEmail, 'memberEmail');
  const canonical = canonicalEmail(memberEmail);
  if (canonical === '') {
    throw new HttpsError('invalid-argument', 'memberEmail did not canonicalize');
  }

  const db = getDb();
  const seatRef = db.doc(`stakes/${stakeId}/seats/${canonical}`);
  const accessRef = db.doc(`stakes/${stakeId}/access/${canonical}`);
  const actor = syncActor('sba-only');

  const seatSnap = await seatRef.get();
  if (!seatSnap.exists) {
    return { success: false, error: 'seat not found' };
  }
  const seat = seatSnap.data() as Seat;
  const dupes = seat.duplicate_grants ?? [];

  if (dupes.length === 0) {
    // Orphan delete, retry-safe. ONE transaction re-reads + re-validates
    // the seat, stamps `lastActor: SyncActor:sba-only`, and reaps the
    // access scope; the bare delete is a separate second committed write
    // (a stamp + delete inside one tx collapses to a bare delete that
    // mis-attributes the audit row — see the doc comment above).
    const txResult = await db.runTransaction<SyncApplyFixResult>(async (tx) => {
      // All reads before any write.
      const freshSeatSnap = await tx.get(seatRef);
      if (!freshSeatSnap.exists) {
        return { success: false, error: 'seat not found' };
      }
      const freshSeat = freshSeatSnap.data() as Seat;
      if ((freshSeat.duplicate_grants ?? []).length > 0) {
        // A concurrent `markRequestComplete` added a duplicate grant
        // between the outer read and here — deleting would silently
        // destroy it. Soft-fail; the operator re-clicks and the next
        // round takes the promote path.
        return { success: false, error: 'seat changed concurrently' };
      }
      const accessSnap = await tx.get(accessRef);

      // Stamp the seat so the delete's audit BEFORE-snapshot attributes
      // `delete_seat` to the Sync actor (the audit trigger reads BEFORE
      // on a delete). Bookkeeping-only — no-op'd by the audit trigger.
      tx.set(
        seatRef,
        {
          lastActor: { ...actor },
          last_modified_at: FieldValue.serverTimestamp(),
          last_modified_by: { ...actor },
        },
        { merge: true },
      );

      // Reap the orphan seat's scope from the access doc in the SAME tx,
      // so a failure here leaves seat + access both intact for a clean
      // retry (the reaping guarantee never half-applies).
      if (accessSnap.exists) {
        clearImporterCallingsForScope(tx, accessRef, {
          access: accessSnap.data() as Access,
          scope: freshSeat.scope,
          actor,
        });
      }
      return { success: true, seatId: canonical };
    });
    if (!txResult.success) return txResult;

    // Irreversible second write: the seat's BEFORE snapshot now carries
    // the Sync-actor stamp, so `delete_seat` is attributed correctly. A
    // failure here leaves the seat alive with access already reaped;
    // retrying re-runs the idempotent tx, then re-deletes (or the next
    // Sync round re-detects sba-only).
    await seatRef.delete();
    return { success: true, seatId: canonical };
  }

  // Multi-grant edge: the member has other grants (e.g. parallel-site
  // access). Promote the first duplicate to primary rather than nuking
  // it. Field copy mirrors `removeSeatOnRequestComplete`'s promote path.
  //
  // Read the seat (and access doc) INSIDE the transaction so we act on
  // the committed state, not the stale outer snapshot: a concurrent
  // `markRequestComplete` could have changed `duplicate_grants[]` or
  // deleted the seat between the outer read and here.
  return db.runTransaction<SyncApplyFixResult>(async (tx) => {
    const freshSeatSnap = await tx.get(seatRef);
    if (!freshSeatSnap.exists) {
      // Seat removed concurrently — soft-fail rather than throw on update.
      return { success: false, error: 'seat not found' };
    }
    const freshSeat = freshSeatSnap.data() as Seat;
    const freshDupes = freshSeat.duplicate_grants ?? [];
    if (freshDupes.length === 0) {
      // Duplicates consumed concurrently (e.g. a remove completed). The
      // seat is now a plain orphan; don't promote a grant that no longer
      // exists. Soft-fail so the drift report re-emits and the operator
      // re-clicks (which will take the orphan-delete path).
      return { success: false, error: 'seat changed concurrently; no duplicate grant to promote' };
    }
    const removedScope = freshSeat.scope;
    const accessSnap = await tx.get(accessRef);

    const [promoted, ...remaining] = freshDupes;
    tx.update(seatRef, {
      scope: promoted!.scope,
      type: promoted!.type,
      callings: promoted!.callings ?? [],
      building_names: promoted!.building_names ?? [],
      kindoo_site_id:
        promoted!.kindoo_site_id !== undefined ? promoted!.kindoo_site_id : FieldValue.delete(),
      duplicate_grants: remaining,
      duplicate_scopes: remaining.map((d) => d.scope),
      // `granted_by_request` justified the now-removed primary; clear it.
      granted_by_request: FieldValue.delete(),
      reason: promoted!.reason ?? FieldValue.delete(),
      start_date: promoted!.start_date ?? FieldValue.delete(),
      end_date: promoted!.end_date ?? FieldValue.delete(),
      last_modified_at: FieldValue.serverTimestamp(),
      last_modified_by: { ...actor },
      lastActor: { ...actor },
    });

    // Reap the REMOVED primary's scope from the access doc. The promoted
    // scope's importer_callings survives (the member still holds it).
    if (accessSnap.exists) {
      clearImporterCallingsForScope(tx, accessRef, {
        access: accessSnap.data() as Access,
        scope: removedScope,
        actor,
      });
    }

    return { success: true, seatId: canonical };
  });
}

// ---------------------------------------------------------------------------
// Auto-seat helpers: the access-doc upsert that backs every auto-seat
// write. App-access callings (`filterAppAccessCallings`) → access doc;
// canonical calling order (`seatCallingOrder`) → roster sort key.
// ---------------------------------------------------------------------------

/**
 * Write an `access` doc for a sync-created/extended auto seat:
 *   - merges with any existing doc (preserves `manual_grants` and other
 *     scopes' `importer_callings`)
 *   - replaces `importer_callings[scope]` wholesale with `callings`
 *     (sorted, deduped)
 *   - stamps `sort_order` from the caller (the canonical
 *     `seatCallingOrder` for this scope's callings).
 */
function writeAccessForAutoScope(
  tx: Transaction,
  ref: DocumentReference,
  opts: {
    canonical: string;
    memberEmail: string;
    memberName: string;
    scope: string;
    callings: string[];
    /** Canonical `seatCallingOrder` for `callings`; `null` if none rank. */
    sortOrder: number | null;
    priorAccess: Access | undefined;
    actor: ActorRef;
  },
): void {
  const { canonical, memberEmail, memberName, scope, callings, sortOrder, priorAccess, actor } =
    opts;
  const sortedCallings = [...new Set(callings)].sort();

  // Build the post-write importer_callings map: drop the target scope's
  // old entry, then set it to `sortedCallings`. Other scopes preserved.
  const finalImporter: Record<string, string[]> = {};
  for (const [s, c] of Object.entries(priorAccess?.importer_callings ?? {})) {
    if (s === scope) continue;
    if (c && c.length > 0) finalImporter[s] = [...c];
  }
  finalImporter[scope] = sortedCallings;

  // sort_order: if the prior doc had a smaller value (from another
  // scope's callings stamped earlier), keep it. Otherwise use this
  // scope's order.
  const priorSort = typeof priorAccess?.sort_order === 'number' ? priorAccess.sort_order : null;
  const finalSort = pickMin(priorSort, sortOrder);

  const now = FieldValue.serverTimestamp();
  if (priorAccess) {
    tx.set(
      ref,
      {
        member_canonical: canonical,
        member_email: memberEmail,
        member_name: memberName || priorAccess.member_name,
        importer_callings: finalImporter,
        sort_order: finalSort,
        last_modified_at: now,
        last_modified_by: actor,
        lastActor: actor,
      },
      { merge: true },
    );
  } else {
    tx.set(ref, {
      member_canonical: canonical,
      member_email: memberEmail,
      member_name: memberName,
      importer_callings: finalImporter,
      manual_grants: {},
      sort_order: finalSort,
      created_at: now,
      last_modified_at: now,
      last_modified_by: actor,
      lastActor: actor,
    });
  }
}

function pickMin(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/**
 * Clear `importer_callings[scope]` for an access doc when its
 * corresponding auto seat flips away from auto. If the final
 * `importer_callings` is empty AND `manual_grants` is empty, the
 * access doc is deleted; otherwise it is updated in place.
 */
function clearImporterCallingsForScope(
  tx: Transaction,
  ref: DocumentReference,
  opts: {
    access: Access;
    scope: string;
    actor: ActorRef;
  },
): void {
  const { access, scope, actor } = opts;
  const finalImporter: Record<string, string[]> = {};
  for (const [s, c] of Object.entries(access.importer_callings ?? {})) {
    if (s === scope) continue;
    if (c && c.length > 0) finalImporter[s] = [...c];
  }
  const hasManual = Object.values(access.manual_grants ?? {}).some((arr) => arr && arr.length > 0);
  const finalImporterEmpty = Object.keys(finalImporter).length === 0;

  if (finalImporterEmpty && !hasManual) {
    tx.delete(ref);
    return;
  }

  // `tx.update` (not `tx.set merge`) so `importer_callings` is REPLACED
  // wholesale with `finalImporter`. A `set merge` deep-merges nested
  // maps key-by-key, which would leave the cleared scope's stale entry
  // behind whenever another scope survives. `update` replaces the named
  // field entirely while leaving `manual_grants` (and every other
  // unmentioned field) untouched.
  tx.update(ref, {
    importer_callings: finalImporter,
    sort_order: finalImporterEmpty ? null : (access.sort_order ?? null),
    last_modified_at: FieldValue.serverTimestamp(),
    last_modified_by: actor,
    lastActor: actor,
  });
}

/**
 * One coherent access-doc write for the `kindoo-unparseable` AUTO path.
 * Drops the seat's OLD scope from `importer_callings`, then adds a fresh
 * `importer_callings['stake'] = [calling]` iff the calling is in the
 * stake app-access set (`stakeHasGrant`). Resolves the final state in
 * memory (no read after this write), then:
 *   - deletes the doc when the final `importer_callings` is empty AND
 *     `manual_grants` is empty (nothing left to justify access), or
 *   - writes the doc otherwise: `tx.update` when it exists (replaces
 *     `importer_callings` wholesale, leaving `manual_grants` untouched —
 *     a `set merge` would deep-merge map keys and strand the old scope),
 *     or a full `tx.set` create when it doesn't.
 * `importer_callings` is always written as the fully-computed map, so the
 * cleared old scope never lingers.
 */
function writeStakeScopeAccessForUnparseable(
  tx: Transaction,
  ref: DocumentReference,
  opts: {
    canonical: string;
    memberEmail: string;
    memberName: string;
    oldScope: string;
    calling: string;
    /** Canonical `seatCallingOrder` for `calling`; `null` if it doesn't rank. */
    stakeSort: number | null;
    /** True iff `calling` is in the stake app-access set. */
    stakeHasGrant: boolean;
    priorAccess: Access | undefined;
    actor: ActorRef;
  },
): void {
  const {
    canonical,
    memberEmail,
    memberName,
    oldScope,
    calling,
    stakeSort,
    stakeHasGrant,
    priorAccess,
    actor,
  } = opts;

  // Final importer map: every scope except the abandoned old one, plus a
  // fresh stake entry when the calling earns app access. The old scope's
  // entry is always dropped even if it equals 'stake' — the stake entry,
  // if any, is rewritten wholesale from this calling.
  const finalImporter: Record<string, string[]> = {};
  for (const [s, c] of Object.entries(priorAccess?.importer_callings ?? {})) {
    if (s === oldScope || s === 'stake') continue;
    if (c && c.length > 0) finalImporter[s] = [...c];
  }
  if (stakeHasGrant) finalImporter['stake'] = [calling];

  const hasManual = Object.values(priorAccess?.manual_grants ?? {}).some(
    (arr) => arr && arr.length > 0,
  );
  const finalImporterEmpty = Object.keys(finalImporter).length === 0;

  // If there's no prior doc and nothing to grant, there's nothing to do.
  if (!priorAccess && finalImporterEmpty) return;

  if (finalImporterEmpty && !hasManual) {
    tx.delete(ref);
    return;
  }

  // sort_order: keep the smaller of the prior value and this stake entry's
  // MIN (other surviving scopes may carry a smaller key). `null` when the
  // final importer is empty (manual-only doc).
  const priorSort = typeof priorAccess?.sort_order === 'number' ? priorAccess.sort_order : null;
  const finalSort = finalImporterEmpty
    ? null
    : pickMin(priorSort, stakeHasGrant ? stakeSort : null);

  const now = FieldValue.serverTimestamp();
  if (priorAccess) {
    // `tx.update` (NOT `tx.set merge`) so `importer_callings` is REPLACED
    // wholesale with `finalImporter`. A `set merge` deep-merges nested
    // maps key-by-key, which would leave the cleared old scope's stale
    // entry behind. `update` replaces the named field entirely while
    // leaving `manual_grants` (and every other unmentioned field)
    // untouched — same reasoning as `clearImporterCallingsForScope`.
    tx.update(ref, {
      member_canonical: canonical,
      member_email: memberEmail,
      member_name: memberName || priorAccess.member_name,
      importer_callings: finalImporter,
      sort_order: finalSort,
      last_modified_at: now,
      last_modified_by: actor,
      lastActor: actor,
    });
  } else {
    tx.set(ref, {
      member_canonical: canonical,
      member_email: memberEmail,
      member_name: memberName,
      importer_callings: finalImporter,
      manual_grants: {},
      sort_order: finalSort,
      created_at: now,
      last_modified_at: now,
      last_modified_by: actor,
      lastActor: actor,
    });
  }
}
