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
//   - `OutOfBand` — substituted by the audit trigger when a write
//     changed tracked fields without touching `lastActor` (Firestore
//     Console edits, ad-hoc `gcloud firestore` tweaks, Admin-SDK
//     scripts that forgot to stamp it). See B-5 in docs/BUGS.md.

export const AUTOMATED_ACTOR_NAMES = ['Importer', 'ExpiryTrigger', 'OutOfBand'] as const;

export type AutomatedActorName = (typeof AUTOMATED_ACTOR_NAMES)[number];

/** True iff the given actor identifier matches a synthetic system actor. */
export function isAutomatedActor(s: string): s is AutomatedActorName {
  return (AUTOMATED_ACTOR_NAMES as readonly string[]).includes(s);
}
