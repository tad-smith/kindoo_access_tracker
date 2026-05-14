// Chrome-extension bridge: applies a single per-row Fix from the Sync
// Phase 2 drift report. Each invocation handles one discrepancy code on
// one seat — no bulk endpoint, no confirmation dance.
//
// Codes split by which side owns the write:
//   - SBA-side  → this callable
//   - Kindoo-side → the extension's v2.2 provision orchestrator
// The Kindoo-side codes (`sba-only`, plus the `direction: 'sba-to-kindoo'`
// variants of the *-mismatch codes) never reach the backend.
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

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { canonicalEmail } from '@kindoo/shared';
import type {
  BuildingsMismatchPayload,
  ExtraKindooCallingPayload,
  KindooManager,
  KindooOnlyPayload,
  ScopeMismatchPayload,
  Seat,
  SyncApplyFixInput,
  SyncApplyFixResult,
  TypeMismatchPayload,
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
      case 'extra-kindoo-calling':
        return applyExtraKindooCalling(stakeId, fix.payload as ExtraKindooCallingPayload);
      case 'scope-mismatch':
        return applyScopeMismatch(stakeId, fix.payload as ScopeMismatchPayload);
      case 'type-mismatch':
        return applyTypeMismatch(stakeId, fix.payload as TypeMismatchPayload);
      case 'buildings-mismatch':
        return applyBuildingsMismatch(stakeId, fix.payload as BuildingsMismatchPayload);
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
  const actor = syncActor('kindoo-only');

  const result = await db.runTransaction<SyncApplyFixResult>(async (tx) => {
    const snap = await tx.get(seatRef);
    if (snap.exists) {
      return { success: false, error: 'seat already exists for that member' };
    }
    const now = Timestamp.now();
    const body: Record<string, unknown> = {
      member_canonical: canonical,
      member_email: memberEmail,
      member_name: memberName,
      scope,
      type,
      callings: dedupePreserveOrder(callings),
      building_names: dedupePreserveOrder(buildingNames),
      duplicate_grants: [],
      created_at: now,
      last_modified_at: now,
      last_modified_by: actor,
      lastActor: actor,
    };
    if (reason !== undefined) body.reason = reason;
    if (type === 'temp') {
      if (startDate !== undefined) body.start_date = startDate;
      if (endDate !== undefined) body.end_date = endDate;
    }
    tx.set(seatRef, body);
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
  const actor = syncActor('extra-kindoo-calling');

  return db.runTransaction<SyncApplyFixResult>(async (tx) => {
    const snap = await tx.get(seatRef);
    if (!snap.exists) {
      return { success: false, error: 'seat not found' };
    }
    const seat = snap.data() as Seat;
    const merged = dedupePreserveOrder([...(seat.callings ?? []), ...extras]);
    if (merged.length === (seat.callings ?? []).length) {
      // Nothing to add — every extra is already present. Still treat as
      // a success so the extension can clear the drift row from its UI.
      return { success: true, seatId: canonical };
    }
    tx.update(seatRef, {
      callings: merged,
      last_modified_at: FieldValue.serverTimestamp(),
      last_modified_by: actor,
      lastActor: actor,
    });
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
  const canonical = canonicalEmail(memberEmail);
  if (canonical === '') {
    throw new HttpsError('invalid-argument', 'memberEmail did not canonicalize');
  }

  const db = getDb();
  const seatRef = db.doc(`stakes/${stakeId}/seats/${canonical}`);
  const actor = syncActor('type-mismatch');

  return db.runTransaction<SyncApplyFixResult>(async (tx) => {
    const snap = await tx.get(seatRef);
    if (!snap.exists) {
      return { success: false, error: 'seat not found' };
    }
    tx.update(seatRef, {
      type: newType,
      last_modified_at: FieldValue.serverTimestamp(),
      last_modified_by: actor,
      lastActor: actor,
    });
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
  const newBuildingNames = cleanStringArray(payload.newBuildingNames ?? [], 'newBuildingNames');
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
      building_names: dedupePreserveOrder(newBuildingNames),
      last_modified_at: FieldValue.serverTimestamp(),
      last_modified_by: actor,
      lastActor: actor,
    });
    return { success: true, seatId: canonical };
  });
}
