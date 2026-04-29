// Field names treated as bookkeeping by the audit machinery.
//
// Two consumers, both using this list as a filter:
//
//   1. `functions/src/lib/auditDiff.ts` — the trigger excludes these
//      from its no-op-detection diff. A write whose only changed
//      fields are bookkeeping (e.g. a `lastActor` refresh with no
//      real field change) emits no audit row.
//
//   2. `apps/web/src/features/manager/auditLog/summarise.ts` — the
//      renderer excludes these from the visible field-by-field diff
//      table. The values are still in the stored `before`/`after`
//      snapshots; they're hidden in the human view.
//
// Keep one list, two filters. If the trigger needs to ignore a field
// for no-op detection, the renderer almost always wants to hide it
// from the human view too — they're the same concept (server
// plumbing, not user-visible data). Adding a renderer-only or
// trigger-only exclusion is a smell; add it here first and document
// why one consumer skips the other case if so.

/** Bookkeeping fields — never appear in the audit diff or trigger
 *  no-op check. */
export const BOOKKEEPING_FIELDS: ReadonlySet<string> = new Set<string>([
  // Last-write integrity check (rules' lastActorMatchesAuth).
  'lastActor',
  // Doc-level mirrors of the same actor info; written by SPA / triggers.
  'last_modified_at',
  'last_modified_by',
  // Per-row creation / change timestamps the SPA + importer stamp.
  'created_at',
  'created_by',
  'added_at',
  'added_by',
  'granted_at',
  'granted_by',
  'detected_at',
  'updated_at',
]);
