// Synthetic actor identifiers stamped on `lastActor` (or substituted by
// the audit trigger) for system-driven writes.
//
// These literals are written by `functions/src/lib/systemActors.ts` and
// rendered by `apps/web/src/features/manager/auditLog/AuditLogPage.tsx`
// (and the dashboard recent-activity list). Centralised here so the
// writer and renderer can't drift; functions imports the const ActorRef
// values from its local module, and apps/web imports `isAutomatedActor`
// from here to decide whether to paint the `actor-automated` chip.
//
//   - `ExpiryTrigger` — stamped by the daily seat-expiry scheduled job.
//   - `RemoveTrigger` — stamped by `removeSeatOnRequestComplete` when
//     it edits or deletes a seat in response to a completed remove
//     request. Distinct from the human completer attribution that
//     lands on the request doc.
//   - `OutOfBand` — substituted by the audit trigger when a write
//     changed tracked fields without touching `lastActor` (Firestore
//     Console edits, ad-hoc `gcloud firestore` tweaks, Admin-SDK
//     scripts that forgot to stamp it). See B-5 in docs/BUGS.md.
//   - `Migration` — stamped by one-shot Admin-SDK migration callables
//     (e.g. T-42's `backfillKindooSiteId`). Recognised so the audit
//     row's chip styling matches the other automated actors.
//   - `SyncActor:<code>` — stamped by the `syncApplyFix` callable when
//     a Kindoo Manager clicks a per-row Fix button in the extension's
//     Sync Phase 2 drift report. The discrepancy `code` rides in the
//     suffix so the audit row preserves which drift class triggered
//     the write. Recognised via the `SYNC_ACTOR_PREFIX` literal rather
//     than enumerated in `AUTOMATED_ACTOR_NAMES` because the `<code>`
//     suffix is open-ended.
//
// Legacy note: pre-T-45 audit rows stamped with `"Importer"` still
// exist in the audit log; `isAutomatedActor` below matches that
// literal via the `LEGACY_IMPORTER_ACTOR_NAME` fallback rather than
// via this enum (the `<code>` suffix on `SyncActor:*` and the
// open-ended legacy stamp make a flat enum a poor fit).

export const AUTOMATED_ACTOR_NAMES = [
  'ExpiryTrigger',
  'RemoveTrigger',
  'OutOfBand',
  'Migration',
] as const;

export type AutomatedActorName = (typeof AUTOMATED_ACTOR_NAMES)[number];

/** Current discrepancy codes that drive a `SyncActor:*` stamp. Mirrors
 * the SBA-side-write codes in `extension/docs/sync-design.md`. `sba-only`
 * is an SBA-side delete (Kindoo is authoritative — an SBA seat with no
 * Kindoo presence is an orphan); the rest mutate an existing seat.
 *
 * This is the set of codes the `syncApplyFix` callable can be invoked
 * with today (it types `syncActor`'s input). Historical codes that may
 * still appear on EXISTING audit rows live in
 * `HISTORICAL_SYNC_DISCREPANCY_CODES` below — recognised for audit-row
 * classification but never stamped on new writes. */
export const SYNC_DISCREPANCY_CODES = [
  'kindoo-only',
  'callings-mismatch',
  'scope-mismatch',
  'type-mismatch',
  'kindoo-unparseable',
  'buildings-mismatch',
  'sba-only',
] as const;

export type SyncDiscrepancyCode = (typeof SYNC_DISCREPANCY_CODES)[number];

/** Deprecated/historical discrepancy codes retained ONLY for audit-row
 * recognition. These are no longer valid `syncApplyFix` inputs (the
 * callable's switch has no case for them, so they can't be invoked) and
 * `syncActor` won't accept them — but production audit rows already
 * stamped `SyncActor:<code>` must keep classifying as automated, not as
 * human actors. Append here when a code is renamed; never remove.
 *
 *   - `extra-kindoo-calling` — renamed to `callings-mismatch` (the
 *     APPEND→REPLACE corrective fix). Rows from the original #178/#179
 *     ship may carry this stamp. */
export const HISTORICAL_SYNC_DISCREPANCY_CODES = ['extra-kindoo-calling'] as const;

/** All `SyncActor:<code>` codes recognised as automated for audit-row
 * classification — current inputs plus deprecated/historical codes. */
const RECOGNISED_SYNC_DISCREPANCY_CODES: readonly string[] = [
  ...SYNC_DISCREPANCY_CODES,
  ...HISTORICAL_SYNC_DISCREPANCY_CODES,
];

/** Prefix that identifies a `SyncActor:<code>` stamp. */
export const SYNC_ACTOR_PREFIX = 'SyncActor:' as const;

/** Build the stamped actor string for a Sync-Phase-2 fix write. */
export function syncActorName(code: SyncDiscrepancyCode): string {
  return `${SYNC_ACTOR_PREFIX}${code}`;
}

/** Extract the discrepancy code from a `SyncActor:*` stamp, or `null` if `s`
 * doesn't match the prefix / a known code. */
export function parseSyncActorCode(s: string): SyncDiscrepancyCode | null {
  if (!s.startsWith(SYNC_ACTOR_PREFIX)) return null;
  const code = s.slice(SYNC_ACTOR_PREFIX.length);
  return (SYNC_DISCREPANCY_CODES as readonly string[]).includes(code)
    ? (code as SyncDiscrepancyCode)
    : null;
}

/** Legacy literal — pre-T-45 audit rows still carry this actor name.
 *  The renderer matches it so historical rows paint with the automated
 *  chip; new writes never produce it. */
export const LEGACY_IMPORTER_ACTOR_NAME = 'Importer';

/** True iff the given actor identifier matches a synthetic system actor.
 * Recognises the static names in `AUTOMATED_ACTOR_NAMES`, the legacy
 * `Importer` actor for pre-T-45 audit rows, and the `SyncActor:<code>`
 * prefix — for BOTH current codes and deprecated/historical codes that
 * survive on existing audit rows (so a renamed code never demotes its
 * historical rows to "human actor"). */
export function isAutomatedActor(s: string): boolean {
  if ((AUTOMATED_ACTOR_NAMES as readonly string[]).includes(s)) return true;
  if (s === LEGACY_IMPORTER_ACTOR_NAME) return true;
  if (!s.startsWith(SYNC_ACTOR_PREFIX)) return false;
  return RECOGNISED_SYNC_DISCREPANCY_CODES.includes(s.slice(SYNC_ACTOR_PREFIX.length));
}
