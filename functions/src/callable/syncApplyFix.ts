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
// Auto-seat bookkeeping: `applyKindooOnly` / `applyExtraKindooCalling`
// / `applyTypeMismatch` stamp `sort_order` from the matched template's
// `sheet_order` (via `functions/src/lib/diff.ts:minSheetOrderForCallings`)
// and upsert the corresponding access doc with `give_app_access` from
// the template. `applyScopeMismatch` / `applyBuildingsMismatch` don't
// touch type or callings, so that bookkeeping doesn't apply to them.
//
// Seat shape on type flip (`applyTypeMismatch`, grant-derived
// promote / demote — see `extension/docs/sync-design.md` "Grant-derived
// seat type"): the §13 convention is auto seats carry the calling in
// `callings[]` (empty `reason`), manual / temp seats carry
// `callings: []` with the calling in free-text `reason`. Promote sets
// `callings[]` from the payload (fallback `[reason]`) and clears
// `reason`; demote folds `callings[]` into `reason` and clears
// `callings[]`. Without this the flip would leave a spec-violating
// hybrid seat.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import { canonicalEmail } from '@kindoo/shared';
import type {
  Access,
  ActorRef,
  BuildingsMismatchPayload,
  CallingTemplate,
  ExtraKindooCallingPayload,
  KindooManager,
  KindooOnlyPayload,
  SbaOnlyRemovePayload,
  ScopeMismatchPayload,
  Seat,
  SyncApplyFixInput,
  SyncApplyFixResult,
  TypeMismatchPayload,
} from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';
import {
  buildTemplateIndex,
  matchTemplate,
  type TemplateIndex,
  type TemplateRow,
} from '../lib/parser.js';
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
      case 'extra-kindoo-calling':
        return applyExtraKindooCalling(stakeId, fix.payload as ExtraKindooCallingPayload);
      case 'scope-mismatch':
        return applyScopeMismatch(stakeId, fix.payload as ScopeMismatchPayload);
      case 'type-mismatch':
        return applyTypeMismatch(stakeId, fix.payload as TypeMismatchPayload);
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

  // Auto seats need template-driven `sort_order` + access-doc parity.
  // Manual / temp seats don't (importer leaves both fields alone).
  const needsTemplates = type === 'auto';

  const result = await db.runTransaction<SyncApplyFixResult>(async (tx) => {
    // All transaction reads must precede any write.
    const seatSnap = await tx.get(seatRef);
    if (seatSnap.exists) {
      return { success: false, error: 'seat already exists for that member' };
    }

    let sortOrder: number | null = null;
    let accessCallings: string[] = [];
    let priorAccess: Access | undefined;
    if (needsTemplates) {
      const idx = await loadTemplateIndex(db, tx, stakeId, scope);
      sortOrder = minSheetOrder(idx, dedupedCallings);
      accessCallings = filterByGiveAppAccess(idx, dedupedCallings);
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
    if (needsTemplates) body.sort_order = sortOrder;
    if (reason !== undefined) body.reason = reason;
    if (type === 'temp') {
      if (startDate !== undefined) body.start_date = startDate;
      if (endDate !== undefined) body.end_date = endDate;
    }
    tx.set(seatRef, body);

    if (needsTemplates && accessCallings.length > 0) {
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

async function applyExtraKindooCalling(
  stakeId: string,
  payload: ExtraKindooCallingPayload | undefined,
): Promise<SyncApplyFixResult> {
  if (!payload || typeof payload !== 'object') {
    throw new HttpsError('invalid-argument', 'payload required');
  }
  const memberEmail = requireString(payload.memberEmail, 'memberEmail');
  const extras = cleanStringArray(payload.extraCallings ?? [], 'extraCallings');
  const canonical = canonicalEmail(memberEmail);
  if (canonical === '') {
    throw new HttpsError('invalid-argument', 'memberEmail did not canonicalize');
  }

  const db = getDb();
  const seatRef = db.doc(`stakes/${stakeId}/seats/${canonical}`);
  const accessRef = db.doc(`stakes/${stakeId}/access/${canonical}`);
  const actor = syncActor('extra-kindoo-calling');

  return db.runTransaction<SyncApplyFixResult>(async (tx) => {
    const snap = await tx.get(seatRef);
    if (!snap.exists) {
      return { success: false, error: 'seat not found' };
    }
    const seat = snap.data() as Seat;
    const priorCallings = seat.callings ?? [];
    const merged = dedupePreserveOrder([...priorCallings, ...extras]);
    if (merged.length === priorCallings.length) {
      // Nothing to add — every extra is already present. Still treat as
      // a success so the extension can clear the drift row from its UI.
      return { success: true, seatId: canonical };
    }

    const update: Record<string, unknown> = {
      callings: merged,
      last_modified_at: FieldValue.serverTimestamp(),
      last_modified_by: actor,
      lastActor: actor,
    };

    // PARITY (Importer): auto seats carry a template-driven `sort_order`
    // and drive `access` doc creation for `give_app_access` templates;
    // manual / temp seats don't. Skip both for non-auto.
    if (seat.type === 'auto') {
      const idx = await loadTemplateIndex(db, tx, stakeId, seat.scope);
      const newSortOrder = minSheetOrder(idx, merged);
      if ((seat.sort_order ?? null) !== newSortOrder) {
        update.sort_order = newSortOrder;
      }
      const accessCallings = filterByGiveAppAccess(idx, merged);
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
  const actor = syncActor('scope-mismatch');

  return db.runTransaction<SyncApplyFixResult>(async (tx) => {
    const snap = await tx.get(seatRef);
    if (!snap.exists) {
      return { success: false, error: 'seat not found' };
    }
    tx.update(seatRef, {
      scope: newScope,
      last_modified_at: FieldValue.serverTimestamp(),
      last_modified_by: actor,
      lastActor: actor,
    });
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

    // Reshape the seat to the §13 convention on the type flip, then run
    // the auto-seat `sort_order` + access-doc bookkeeping off the
    // reshaped callings. §13: auto seats carry the calling in
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

      const idx = await loadTemplateIndex(db, tx, stakeId, seat.scope);
      const newSortOrder = minSheetOrder(idx, autoCallings);
      update.sort_order = newSortOrder;
      const accessCallings = filterByGiveAppAccess(idx, autoCallings);
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
 * Mirrors `removeSeatOnRequestComplete`'s seat-removal semantics:
 *   - No `duplicate_grants[]` (the common orphan case) → delete the
 *     seat. To attribute the deletion to `SyncActor:sba-only` in the
 *     audit log, we follow the Expiry precedent: stamp `lastActor`
 *     (a bookkeeping-only write the audit trigger no-ops), then delete.
 *     The audit trigger reads the stamped BEFORE snapshot and emits a
 *     `delete_seat` row attributed to the Sync actor. Stamp + delete
 *     must be two committed writes (not one transaction) — inside a
 *     single transaction they collapse to a bare delete whose BEFORE
 *     carries the seat's *prior* actor, mis-attributing the row.
 *   - Has `duplicate_grants[]` → the member holds other-site / other-
 *     scope access we must not nuke. Promote the first duplicate to
 *     primary (same field copy the remove trigger does) instead of
 *     deleting, in a single-doc transactional update stamped with the
 *     Sync actor; the audit trigger fans an `update_seat` row.
 *
 * Does NOT touch the member's `access/{canonical}` doc — matching the
 * remove trigger, which leaves access untouched on seat removal.
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
  const actor = syncActor('sba-only');

  const seatSnap = await seatRef.get();
  if (!seatSnap.exists) {
    return { success: false, error: 'seat not found' };
  }
  const seat = seatSnap.data() as Seat;
  const dupes = seat.duplicate_grants ?? [];

  if (dupes.length === 0) {
    // Orphan delete. Expiry-style stamp-then-delete so the audit row is
    // attributed to the Sync actor (the audit trigger reads BEFORE on a
    // delete). Two committed writes — see the doc comment above.
    await seatRef.set(
      {
        lastActor: { ...actor },
        last_modified_at: FieldValue.serverTimestamp(),
        last_modified_by: { ...actor },
      },
      { merge: true },
    );
    await seatRef.delete();
    return { success: true, seatId: canonical };
  }

  // Multi-grant edge: the member has other grants (e.g. parallel-site
  // access). Promote the first duplicate to primary rather than nuking
  // it. Field copy mirrors `removeSeatOnRequestComplete`'s promote path.
  const [promoted, ...remaining] = dupes;
  await db.runTransaction(async (tx) => {
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
  });
  return { success: true, seatId: canonical };
}

// ---------------------------------------------------------------------------
// Auto-seat helpers: template-index loading, sort_order derivation
// from `wardCallingTemplates` / `stakeCallingTemplates`, and the
// access-doc upsert that backs every auto-seat write (`give_app_access`
// → access doc; `sort_order` → roster sort key).
// ---------------------------------------------------------------------------

/**
 * Load the calling-template collection for a scope and build the
 * matcher index. `'stake'` reads `stakeCallingTemplates`; any other
 * scope reads `wardCallingTemplates` (templates are stake-wide; every
 * ward shares the ward-template index).
 *
 * Firestore transactions require all reads to precede any write — pass
 * the `tx` so the template reads count as transaction reads.
 */
async function loadTemplateIndex(
  db: Firestore,
  tx: Transaction,
  stakeId: string,
  scope: string,
): Promise<TemplateIndex> {
  const collection = scope === 'stake' ? 'stakeCallingTemplates' : 'wardCallingTemplates';
  const colRef = db.collection(`stakes/${stakeId}/${collection}`);
  const snap = await tx.get(colRef);
  const rows: TemplateRow[] = snap.docs.map((d) => {
    const data = d.data() as CallingTemplate;
    return {
      calling_name: data.calling_name,
      give_app_access: data.give_app_access === true,
      auto_kindoo_access: data.auto_kindoo_access === true,
      sheet_order: typeof data.sheet_order === 'number' ? data.sheet_order : 0,
    };
  });
  return buildTemplateIndex(rows);
}

/**
 * MIN(`sheet_order`) across the matched templates for `callings`.
 * Returns `null` if no calling matches an "orphaned auto seat" — see
 * `diff.ts:minSheetOrderForCallings`.
 */
function minSheetOrder(idx: TemplateIndex, callings: string[]): number | null {
  let min: number | null = null;
  for (const c of callings) {
    const tpl = matchTemplate(idx, c);
    if (!tpl) continue;
    const order = typeof tpl.sheet_order === 'number' ? tpl.sheet_order : 0;
    if (min === null || order < min) min = order;
  }
  return min;
}

/** Subset of `callings` whose matched template has `give_app_access=true`. */
function filterByGiveAppAccess(idx: TemplateIndex, callings: string[]): string[] {
  const out: string[] = [];
  for (const c of callings) {
    const tpl = matchTemplate(idx, c);
    if (tpl && tpl.give_app_access === true) out.push(c);
  }
  return out;
}

/**
 * Write an `access` doc for a sync-created/extended auto seat:
 *   - merges with any existing doc (preserves `manual_grants` and other
 *     scopes' `importer_callings`)
 *   - replaces `importer_callings[scope]` wholesale with `callings`
 *     (sorted, deduped)
 *   - stamps `sort_order` from the caller (computed once at the
 *     `minSheetOrder` call site for this scope's callings).
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
    /** MIN(sheet_order) for `callings` under `scope`; `null` if no match. */
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
  // scope's MIN.
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

  tx.set(
    ref,
    {
      importer_callings: finalImporter,
      sort_order: finalImporterEmpty ? null : (access.sort_order ?? null),
      last_modified_at: FieldValue.serverTimestamp(),
      last_modified_by: actor,
      lastActor: actor,
    },
    { merge: true },
  );
}
