// Parameterised audit trigger — fans audit rows for every write to an
// audited collection per `docs/firebase-schema.md` §4.10.
//
// One `onDocumentWritten` registration per audited path. Each registration
// is a thin wrapper around `emitAuditRow`, which:
//
//   - Determines `action` from before/after (`create_*`, `update_*`,
//     `delete_*`) and the entity type. Special-cases `setup_complete`
//     when the stake doc's `setup_complete` flag flips false → true.
//     Requests are status-driven: the action follows the status
//     transition (`complete_request`, `reject_request`, `cancel_request`).
//   - Pulls `lastActor` from the AFTER state (or BEFORE for deletes —
//     the deleter is almost always the last-toucher). Falls back to
//     `'unknown'` if absent.
//   - Skips writes whose diff (excluding bookkeeping: `lastActor`,
//     `last_modified_*`, etc.) is empty.
//   - Writes the row at a deterministic doc ID — `auditId(writeTime,
//     '<collection>_<docId>')` — so retries land idempotently on the
//     same row.
//   - Stamps a 365-day `ttl` field. The Firestore TTL policy itself is
//     a project-level gcloud configuration (see `infra/runbooks` and
//     TASKS.md T-15) — until that policy is enabled, audit rows
//     accumulate without auto-expiry.

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import { auditId } from '@kindoo/shared';
import type { AuditAction, AuditEntityType, AuditLog } from '@kindoo/shared';
import { getDb } from '../lib/admin.js';
import { deepEqual, isNoOpUpdate } from '../lib/auditDiff.js';
import { OUT_OF_BAND_ACTOR } from '../lib/systemActors.js';

// ===== Per-collection registrations =====
//
// One export per audited path. The Cloud Functions runtime fans each
// onDocumentWritten registration into its own deployable function.

export const auditStakeWrites = onDocumentWritten('stakes/{stakeId}', async (event) => {
  const { stakeId } = event.params as { stakeId: string };
  if (!event.data) return;
  await emitAuditRow({
    stakeId,
    collection: 'stake',
    docId: stakeId,
    entityType: 'stake',
    before: snapshotData(event.data.before),
    after: snapshotData(event.data.after),
    eventTime: event.time,
  });
});

export const auditWardWrites = onDocumentWritten(
  'stakes/{stakeId}/wards/{wardId}',
  async (event) => {
    const { stakeId, wardId } = event.params as { stakeId: string; wardId: string };
    if (!event.data) return;
    await emitAuditRow({
      stakeId,
      collection: 'wards',
      docId: wardId,
      // Wards/buildings/calling-templates aren't first-class entity
      // types in the audit schema; they audit as `entity_type='stake'`
      // with a structured `entity_id`. This matches §4.10's enum, which
      // only carries seat/request/access/manager/stake/system. The doc
      // id makes the row unambiguous.
      entityType: 'stake',
      entityIdOverride: `ward:${wardId}`,
      before: snapshotData(event.data.before),
      after: snapshotData(event.data.after),
      eventTime: event.time,
    });
  },
);

export const auditBuildingWrites = onDocumentWritten(
  'stakes/{stakeId}/buildings/{buildingId}',
  async (event) => {
    const { stakeId, buildingId } = event.params as { stakeId: string; buildingId: string };
    if (!event.data) return;
    await emitAuditRow({
      stakeId,
      collection: 'buildings',
      docId: buildingId,
      entityType: 'stake',
      entityIdOverride: `building:${buildingId}`,
      before: snapshotData(event.data.before),
      after: snapshotData(event.data.after),
      eventTime: event.time,
    });
  },
);

export const auditManagerWrites = onDocumentWritten(
  'stakes/{stakeId}/kindooManagers/{memberCanonical}',
  async (event) => {
    const { stakeId, memberCanonical } = event.params as {
      stakeId: string;
      memberCanonical: string;
    };
    if (!event.data) return;
    await emitAuditRow({
      stakeId,
      collection: 'kindooManagers',
      docId: memberCanonical,
      entityType: 'kindooManager',
      before: snapshotData(event.data.before),
      after: snapshotData(event.data.after),
      eventTime: event.time,
    });
  },
);

export const auditAccessWrites = onDocumentWritten(
  'stakes/{stakeId}/access/{memberCanonical}',
  async (event) => {
    const { stakeId, memberCanonical } = event.params as {
      stakeId: string;
      memberCanonical: string;
    };
    if (!event.data) return;
    await emitAuditRow({
      stakeId,
      collection: 'access',
      docId: memberCanonical,
      entityType: 'access',
      before: snapshotData(event.data.before),
      after: snapshotData(event.data.after),
      eventTime: event.time,
    });
  },
);

export const auditSeatWrites = onDocumentWritten(
  'stakes/{stakeId}/seats/{memberCanonical}',
  async (event) => {
    const { stakeId, memberCanonical } = event.params as {
      stakeId: string;
      memberCanonical: string;
    };
    if (!event.data) return;
    await emitAuditRow({
      stakeId,
      collection: 'seats',
      docId: memberCanonical,
      entityType: 'seat',
      before: snapshotData(event.data.before),
      after: snapshotData(event.data.after),
      eventTime: event.time,
    });
  },
);

export const auditRequestWrites = onDocumentWritten(
  'stakes/{stakeId}/requests/{requestId}',
  async (event) => {
    const { stakeId, requestId } = event.params as { stakeId: string; requestId: string };
    if (!event.data) return;
    await emitAuditRow({
      stakeId,
      collection: 'requests',
      docId: requestId,
      entityType: 'request',
      before: snapshotData(event.data.before),
      after: snapshotData(event.data.after),
      eventTime: event.time,
    });
  },
);

export const auditWardCallingTemplateWrites = onDocumentWritten(
  'stakes/{stakeId}/wardCallingTemplates/{calling}',
  async (event) => {
    const { stakeId, calling } = event.params as { stakeId: string; calling: string };
    if (!event.data) return;
    await emitAuditRow({
      stakeId,
      collection: 'wardCallingTemplates',
      docId: calling,
      entityType: 'stake',
      entityIdOverride: `wardCallingTemplate:${calling}`,
      before: snapshotData(event.data.before),
      after: snapshotData(event.data.after),
      eventTime: event.time,
    });
  },
);

export const auditStakeCallingTemplateWrites = onDocumentWritten(
  'stakes/{stakeId}/stakeCallingTemplates/{calling}',
  async (event) => {
    const { stakeId, calling } = event.params as { stakeId: string; calling: string };
    if (!event.data) return;
    await emitAuditRow({
      stakeId,
      collection: 'stakeCallingTemplates',
      docId: calling,
      entityType: 'stake',
      entityIdOverride: `stakeCallingTemplate:${calling}`,
      before: snapshotData(event.data.before),
      after: snapshotData(event.data.after),
      eventTime: event.time,
    });
  },
);

// ===== Shared helper =====

/** Audit-trigger context — what the per-path wrappers pass to the helper. */
export type EmitContext = {
  stakeId: string;
  /** The Firestore subcollection name (or `'stake'` for the parent doc). */
  collection: AuditCollection;
  /** The doc ID under that collection (for `'stake'`, the stakeId). */
  docId: string;
  /** Maps to `auditLog.entity_type`. */
  entityType: AuditEntityType;
  /**
   * Optional override for `auditLog.entity_id`. Defaults to `docId`.
   * Used for entities not in the audit-schema enum (wards, buildings,
   * calling templates) so the entry remains unambiguous.
   */
  entityIdOverride?: string;
  /** Pre-write snapshot data, or null for a create. */
  before: Record<string, unknown> | null;
  /** Post-write snapshot data, or null for a delete. */
  after: Record<string, unknown> | null;
  /** ISO timestamp from the CloudEvent. */
  eventTime: string;
};

export type AuditCollection =
  | 'stake'
  | 'wards'
  | 'buildings'
  | 'kindooManagers'
  | 'access'
  | 'seats'
  | 'requests'
  | 'wardCallingTemplates'
  | 'stakeCallingTemplates';

/**
 * Compute the audit row from a write event and persist it. Idempotent:
 * the doc id is deterministic from `(eventTime, collection, docId)`.
 */
export async function emitAuditRow(ctx: EmitContext): Promise<void> {
  const { before, after } = ctx;

  // Defensive: writes that are neither create, update, nor delete shouldn't
  // exist, but if they do, do nothing.
  if (!before && !after) return;

  // Skip no-op updates — writes whose only changed fields are
  // bookkeeping (lastActor, timestamps).
  if (before && after && isNoOpUpdate(before, after)) return;

  const action = resolveAction(ctx, before, after);
  const actor = resolveActor(before, after);
  const memberCanonical = resolveMemberCanonical(ctx, before, after);

  const writeTime = new Date(ctx.eventTime);
  const ttl = Timestamp.fromMillis(writeTime.getTime() + TTL_MS);
  const docIdSuffix = `${ctx.collection}_${ctx.docId}`;
  const auditDocId = auditId(writeTime, docIdSuffix);

  const row: AuditLog = {
    audit_id: auditDocId,
    timestamp: Timestamp.fromDate(writeTime),
    actor_email: actor.email,
    actor_canonical: actor.canonical,
    action,
    entity_type: ctx.entityType,
    entity_id: ctx.entityIdOverride ?? ctx.docId,
    before,
    after,
    ttl,
    ...(memberCanonical ? { member_canonical: memberCanonical } : {}),
  };

  await getDb().doc(`stakes/${ctx.stakeId}/auditLog/${auditDocId}`).set(row);
}

/** 365 days in ms. The TTL policy is configured per-project via gcloud. */
const TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Extract a snapshot's data, or `null` when the snapshot is empty/missing. */
function snapshotData(
  snap: { exists: boolean; data: () => unknown } | undefined,
): Record<string, unknown> | null {
  if (!snap || !snap.exists) return null;
  const d = snap.data();
  return (d as Record<string, unknown>) ?? null;
}

/** Resolve the audit action from the change shape + entity type. */
function resolveAction(
  ctx: EmitContext,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): AuditAction {
  // Stake parent doc — `setup_complete` flip false → true is its own
  // distinguished action so the audit log shows the wizard close
  // explicitly. All other stake updates fold to `update_stake`.
  if (ctx.entityType === 'stake' && ctx.collection === 'stake') {
    if (before && after && before['setup_complete'] === false && after['setup_complete'] === true) {
      return 'setup_complete';
    }
    return 'update_stake';
  }

  // Wards / buildings / calling templates also map to `update_stake`
  // since they share the `entity_type='stake'` enum slot. Create/delete
  // collapse there too for the same reason.
  if (ctx.entityType === 'stake') {
    return 'update_stake';
  }

  // Requests are status-driven: the action follows the status
  // transition rather than a generic create/update/delete. Rules
  // forbid request deletion; deletes here would only happen via
  // Admin SDK and are bucketed under the closest terminal status if we
  // can read it.
  if (ctx.entityType === 'request') {
    return resolveRequestAction(before, after);
  }

  // Seat deletes by the daily expiry trigger map to `auto_expire`.
  // Detection: Expiry stamps `lastActor.canonical='ExpiryTrigger'` on
  // the seat just before deleting; the bookkeeping-only update is
  // skipped by `isNoOpUpdate`, then this trigger fires on the delete
  // with that stamped BEFORE state.
  if (ctx.entityType === 'seat' && before && !after) {
    const lastActor = before['lastActor'] as { canonical?: unknown } | undefined;
    if (lastActor?.canonical === 'ExpiryTrigger') {
      return 'auto_expire';
    }
  }

  if (!before) return CREATE_ACTION[ctx.entityType];
  if (!after) return DELETE_ACTION[ctx.entityType];
  return UPDATE_ACTION[ctx.entityType];
}

/**
 * Request action mapping. The `requests` doc moves through
 * pending → {complete, rejected, cancelled} via status writes; each
 * transition gets its own audit action per the §4.10 enum. A
 * non-terminal update (status unchanged) falls back to
 * `submit_request` — rare in practice (rules largely lock requests to
 * status flips) but keeps the action set aligned with the schema enum.
 */
function resolveRequestAction(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): AuditAction {
  if (!before && after) return 'create_request';
  if (after) {
    const status = after['status'];
    if (status === 'complete') return 'complete_request';
    if (status === 'rejected') return 'reject_request';
    if (status === 'cancelled') return 'cancel_request';
  }
  // Delete (no after) or status === 'pending' update — bucket as a
  // submit so the row still lands in an enum slot.
  return 'submit_request';
}

const CREATE_ACTION: Record<AuditEntityType, AuditAction> = {
  seat: 'create_seat',
  access: 'create_access',
  request: 'create_request',
  kindooManager: 'create_manager',
  stake: 'update_stake',
  system: 'update_stake',
};

const UPDATE_ACTION: Record<AuditEntityType, AuditAction> = {
  seat: 'update_seat',
  access: 'update_access',
  request: 'submit_request', // requests use status-derived action; see resolveRequestAction
  kindooManager: 'update_manager',
  stake: 'update_stake',
  system: 'update_stake',
};

const DELETE_ACTION: Record<AuditEntityType, AuditAction> = {
  seat: 'delete_seat',
  access: 'delete_access',
  request: 'cancel_request', // rules forbid request deletion; surfaced if Admin SDK does it
  kindooManager: 'delete_manager',
  stake: 'update_stake',
  system: 'update_stake',
};

/**
 * Resolve actor `{email, canonical}` from the doc's `lastActor` field.
 * For deletes we read BEFORE (no after state to read from); for create
 * + update we read AFTER. Falls back to `'unknown'` if the field is
 * missing — a defensive default that surfaces in the audit log so an
 * operator can see something went sideways.
 *
 * Out-of-band writes (Firestore Console edits, ad-hoc `gcloud firestore`
 * tweaks, Admin-SDK scripts that forgot to stamp `lastActor`) leave the
 * canonical write path's bookkeeping fields untouched. We detect them
 * by requiring BOTH `lastActor` AND `last_modified_at` to be unchanged
 * across before/after on an update. Two conditions matter:
 *
 *   - `lastActor` unchanged alone is insufficient. The same operator
 *     touching the same doc twice in a row produces identical
 *     `lastActor` values on both sides — a false positive that tags
 *     legitimate in-band writes as OutOfBand (B-5 follow-up).
 *
 *   - Every in-band writer (SPA, callable, importer, expiry trigger)
 *     stamps `last_modified_at` as `FieldValue.serverTimestamp()`. Two
 *     consecutive in-band writes always produce distinct resolved
 *     timestamps, so requiring BOTH fields unchanged narrows the
 *     sentinel to real out-of-band writes.
 *
 * Carve-out: some audited collections (`kindooManagers`, `requests`,
 * `wardCallingTemplates`, `stakeCallingTemplates`) have no
 * `last_modified_at` field. When both sides lack it, treat it as
 * trivially unchanged — the heuristic reduces to the original
 * "lastActor unchanged" check for those collections. That's the best
 * available signal there; an out-of-band edit to one of those docs
 * still falls through to the sentinel as long as `lastActor` wasn't
 * touched.
 *
 * See B-5 in docs/BUGS.md.
 */
function resolveActor(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { email: string; canonical: string } {
  if (before && after && isOutOfBandUpdate(before, after)) {
    return { email: OUT_OF_BAND_ACTOR.email, canonical: OUT_OF_BAND_ACTOR.canonical };
  }
  const source = after ?? before;
  const lastActor = (source?.['lastActor'] as { email?: unknown; canonical?: unknown }) ?? {};
  const email = typeof lastActor.email === 'string' ? lastActor.email : 'unknown';
  const canonical = typeof lastActor.canonical === 'string' ? lastActor.canonical : 'unknown';
  return { email, canonical };
}

/**
 * True iff an update looks out-of-band — i.e. both `lastActor` and
 * `last_modified_at` are structurally unchanged across before/after.
 * Uses the audit-diff `deepEqual` (key-order-tolerant per B-6) rather
 * than `JSON.stringify` so timestamp objects compare by value. When
 * `last_modified_at` is absent on both sides, the carve-out kicks in
 * and only `lastActor` equality is required.
 */
function isOutOfBandUpdate(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  if (!deepEqual(before['lastActor'], after['lastActor'])) return false;
  return deepEqual(before['last_modified_at'], after['last_modified_at']);
}

/**
 * Resolve `member_canonical` for cross-collection per-user filtering.
 *
 *   - seats / access / kindooManagers — the doc id IS the canonical.
 *     Pull from `member_canonical` field when present, else the doc id.
 *   - requests — the request body carries the subject's canonical.
 *   - stake / system — no per-user dimension; field stays absent.
 */
function resolveMemberCanonical(
  ctx: EmitContext,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string | undefined {
  const source = after ?? before;
  if (!source) return undefined;

  if (
    ctx.collection === 'seats' ||
    ctx.collection === 'access' ||
    ctx.collection === 'kindooManagers'
  ) {
    const declared = source['member_canonical'];
    return typeof declared === 'string' ? declared : ctx.docId;
  }

  if (ctx.collection === 'requests') {
    const declared = source['member_canonical'];
    return typeof declared === 'string' ? declared : undefined;
  }

  return undefined;
}
