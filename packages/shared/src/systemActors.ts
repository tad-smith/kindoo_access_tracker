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
//   - `Importer` — stamped by the LCR-sheet importer service.
//   - `ExpiryTrigger` — stamped by the daily seat-expiry scheduled job.
//   - `RemoveTrigger` — stamped by `removeSeatOnRequestComplete` when
//     it edits or deletes a seat in response to a completed remove
//     request. Distinct from the human completer attribution that
//     lands on the request doc.
//   - `OutOfBand` — substituted by the audit trigger when a write
//     changed tracked fields without touching `lastActor` (Firestore
//     Console edits, ad-hoc `gcloud firestore` tweaks, Admin-SDK
//     scripts that forgot to stamp it). See B-5 in docs/BUGS.md.
//   - `SyncActor:<code>` — stamped by the `syncApplyFix` callable when
//     a Kindoo Manager clicks a per-row Fix button in the extension's
//     Sync Phase 2 drift report. The discrepancy `code` rides in the
//     suffix so the audit row preserves which drift class triggered
//     the write. Recognised via the `SYNC_ACTOR_PREFIX` literal rather
//     than enumerated in `AUTOMATED_ACTOR_NAMES` because the `<code>`
//     suffix is open-ended.

export const AUTOMATED_ACTOR_NAMES = [
  'Importer',
  'ExpiryTrigger',
  'RemoveTrigger',
  'OutOfBand',
] as const;

export type AutomatedActorName = (typeof AUTOMATED_ACTOR_NAMES)[number];

/** Discrepancy codes that drive a `SyncActor:*` stamp. Mirrors the five
 * SBA-side-write codes in `extension/docs/sync-design.md`. */
export const SYNC_DISCREPANCY_CODES = [
  'kindoo-only',
  'extra-kindoo-calling',
  'scope-mismatch',
  'type-mismatch',
  'buildings-mismatch',
] as const;

export type SyncDiscrepancyCode = (typeof SYNC_DISCREPANCY_CODES)[number];

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

/** True iff the given actor identifier matches a synthetic system actor.
 * Recognises both the static names in `AUTOMATED_ACTOR_NAMES` and the
 * `SyncActor:<code>` prefix. */
export function isAutomatedActor(s: string): boolean {
  if ((AUTOMATED_ACTOR_NAMES as readonly string[]).includes(s)) return true;
  return parseSyncActorCode(s) !== null;
}
