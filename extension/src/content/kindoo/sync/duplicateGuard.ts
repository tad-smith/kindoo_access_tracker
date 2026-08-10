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
//
// `scope-mismatch` is deliberately absent, and it is not clean either: it
// rewrites the primary's `scope`, re-stamps `kindoo_site_id`, deletes
// `organization_id`, and sends the UNFILTERED segment (B-25). It stays
// because scope drift has no other route to convergence and its write
// replaces a field rather than reaping a grant. Revisit with B-16.
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
  'type-mismatch',
  'buildings-mismatch',
  'kindoo-unparseable',
]);

/** Note appended to a duplicate-surfaced row whose fix is withheld, so
 * the operator sees a reason rather than a silently missing button. */
export const DUPLICATE_SURFACED_NOTE =
  ' Surfaced through a parallel-site grant rather than the seat’s primary, so this fix is' +
  ' unavailable — applying it would write the primary instead (B-16 / B-24).';
