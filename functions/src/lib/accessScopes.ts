// Access-doc scope bookkeeping shared by the Sync fix callable and the
// request-completion remove trigger.
//
// It lives here because BOTH paths end a grant: `syncApplyFix`'s `sba-only`
// when Kindoo has already dropped the user, and `removeSeatOnRequestComplete`
// when a manager completes a remove request — the ordinary way a grant goes
// away. Since the surfaced-grant threading (B-16) let a DUPLICATE's scope
// hold `importer_callings`, either path leaving the entry behind strands a
// live claim: nothing can name a scope once no grant on the seat carries it.

import { FieldValue } from 'firebase-admin/firestore';
import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import { filterLimitedTierCallings } from '@kindoo/shared';
import type { Access, ActorRef } from '@kindoo/shared';

/**
 * Recompute `importer_limited_callings` for a write that has just
 * resolved `finalImporter`. Scopes other than `scope` keep their prior
 * stamp (and are dropped when the scope itself is gone from
 * `finalImporter`); `scope` is re-stamped from the writer-side policy
 * against the callings being written.
 */
export function buildLimitedMap(opts: {
  priorLimited: Record<string, string[]> | undefined;
  finalImporter: Record<string, string[]>;
  scope: string;
  callings: string[];
}): Record<string, string[]> {
  const { priorLimited, finalImporter, scope, callings } = opts;
  const out: Record<string, string[]> = {};
  for (const [s, c] of Object.entries(priorLimited ?? {})) {
    if (s === scope) continue;
    // Never strand a stamp for a scope that no longer has callings.
    if (!(s in finalImporter)) continue;
    if (Array.isArray(c) && c.length > 0) out[s] = [...c];
  }
  const limited = filterLimitedTierCallings(callings);
  if (limited.length > 0) out[scope] = limited;
  return out;
}

/**
 * Clear `importer_callings[scope]` (and its `importer_limited_callings`
 * tier stamp) for an access doc when its corresponding auto seat flips
 * away from auto. If the final `importer_callings` is empty AND
 * `manual_grants` is empty, the access doc is deleted; otherwise it is
 * updated in place.
 *
 * The doc-existence test deliberately ignores `importer_limited_callings`:
 * it is a stamp ON grants, never a grant, so it must not keep an
 * otherwise-empty doc alive.
 */
export function clearImporterCallingsForScope(
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
  // Nothing granted for `scope` any more, so nothing to stamp for it.
  const finalLimited = buildLimitedMap({
    priorLimited: access.importer_limited_callings,
    finalImporter,
    scope,
    callings: [],
  });
  const hasManual = Object.values(access.manual_grants ?? {}).some((arr) => arr && arr.length > 0);
  const finalImporterEmpty = Object.keys(finalImporter).length === 0;

  if (finalImporterEmpty && !hasManual) {
    tx.delete(ref);
    return;
  }

  // `tx.update` (not `tx.set merge`) so both maps are REPLACED
  // wholesale. A `set merge` deep-merges nested maps key-by-key, which
  // would leave the cleared scope's stale entry behind whenever another
  // scope survives. `update` replaces the named fields entirely while
  // leaving `manual_grants` (and every other unmentioned field)
  // untouched.
  tx.update(ref, {
    importer_callings: finalImporter,
    importer_limited_callings: finalLimited,
    sort_order: finalImporterEmpty ? null : (access.sort_order ?? null),
    last_modified_at: FieldValue.serverTimestamp(),
    last_modified_by: actor,
    lastActor: actor,
  });
}
