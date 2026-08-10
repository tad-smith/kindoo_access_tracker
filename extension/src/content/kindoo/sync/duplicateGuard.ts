// The one list of discrepancy codes whose fix must not be offered when
// the row was surfaced through a `duplicate_grants[]` entry.
//
// It lives in its own module because BOTH sides need it and they must
// never disagree: `fixActionsFor` withholds the buttons, and the
// detector appends the explanatory note to the row's reason. Those two
// drifted apart once already — the note was attached per code at two
// sites while the withholding covered four, so a `buildings-mismatch`
// row rendered with no button and no explanation.
//
// Every entry writes the PRIMARY grant's fields, which on such a row is
// not the grant the operator is looking at (B-16, B-24):
//
//   - `callings-mismatch`   replaces the primary's callings + reaps its access
//   - `type-mismatch`       DEMOTE clears the primary's callings + reaps access
//   - `buildings-mismatch`  replaces the primary's buildings with another site's
//   - `kindoo-unparseable`  restakes the primary to `stake`, drops its site
//                           stamp, overwrites callings, reaps the old scope —
//                           a strict superset of the rest
//   - `scope-mismatch`      rewrites the primary's `scope` — the field that
//                           decides which grant it IS — plus its site stamp,
//                           and deletes `organization_id`
//
// `scope-mismatch` was exempted twice on the grounds that "scope drift has
// no other route to convergence". That is the one property it lacks here:
// the write never touches the duplicate that produced the row, so the row
// stops re-emitting only because the PRIMARY has been dragged onto the
// duplicate's site. Concretely, on a merged seat (`stake` primary + foreign
// ward duplicate) whose member moves to another ward on that foreign site,
// the row reads "SBA=Kettle Creek, Kindoo=Meadow Ridge" — the operator is
// looking at the duplicate — and the click restakes their STAKE grant to a
// foreign ward: licence pools move (`computeOverCaps` counts the primary's
// `scope`), rules-based read access flips, `organization_id` is deleted,
// and `importer_callings.stake` is orphaned with nothing left to reap it.
// Strictly more destructive than the `type-mismatch` PROMOTE next to it.
// It also sends the UNFILTERED segment (B-26).
//
// Delete this module — don't extend it — once the handlers take the
// surfaced grant's `(scope, kindoo_site_id)`; then every code can act on
// the grant that produced the row.

import type { DiscrepancyCode } from './detector';

// `sba-only` was the first entry here and is deliberately NO LONGER in
// the set: B-24's threading landed, so `applySbaOnlyRemove` drops the
// grant the row names instead of guessing `duplicate_grants[0]`. Keeping
// it withheld was what left a merged auto grant with no removal path
// anywhere in the product — Sync withheld it and every web Remove
// affordance gates on `grant.type !== 'auto'`.
export const WITHHELD_ON_DUPLICATE_SURFACED: ReadonlySet<DiscrepancyCode> = new Set([
  'callings-mismatch',
  'scope-mismatch',
  'type-mismatch',
  'buildings-mismatch',
  'kindoo-unparseable',
]);

/** Note appended to a duplicate-surfaced row whose fix is withheld, so
 * the operator sees a reason rather than a silently missing button. */
export const DUPLICATE_SURFACED_NOTE =
  ' Surfaced through a parallel-site grant rather than the seat’s primary, so this fix is' +
  ' unavailable — applying it would write the primary instead (B-16 / B-24).';
