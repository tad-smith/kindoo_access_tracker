// AccessPage sort helpers.
//
// - Card view: scope-banded grouping (stake first, wards alpha), then
//   doc-level `sort_order` ascending within each band. Operator confirms
//   no cross-scope overlap in real data, so the Sync-denormalised
//   doc-level `sort_order` (MIN canonical `seatCallingOrder` across
//   `importer_callings`) equals the only-scope's calling order.
// - Table view: per-row scope-banded sort using the canonical churchwide
//   calling order (`callingSortOrder`). Manual grants (free-text reasons
//   that aren't callings) fall through to `+Infinity` and sort to the
//   bottom of their scope band.

import { callingSortOrder } from '@kindoo/shared';
import type { Access } from '@kindoo/shared';

/**
 * Calling sort priority for a row. Trimmed + case-insensitive exact
 * match against the canonical churchwide order; `+Infinity` when the
 * calling isn't in the table (manual free-text reasons) — same orphan
 * convention as `lib/sort/seats.ts`. The `scope` argument is accepted
 * for call-site symmetry but the order is scope-independent.
 */
export function lookupSheetOrder(_scope: string, calling: string): number {
  const order = callingSortOrder(calling);
  return order === null ? Number.POSITIVE_INFINITY : order;
}

/**
 * Stake-first scope band ordering: `'stake'` first, wards alphabetical
 * by `ward_code`. Pure ordinal comparator (negative / positive / zero).
 */
export function compareScopeBand(a: string, b: string): number {
  if (a === b) return 0;
  if (a === 'stake') return -1;
  if (b === 'stake') return 1;
  return a.localeCompare(b);
}

/**
 * Derive the access doc's "primary scope" for card-view banding.
 * `'stake'` wins when present (importer or manual). Otherwise the
 * first ward_code found in `importer_callings` then `manual_grants`,
 * preferring lexically smaller codes for determinism. `'_unknown'`
 * (sorts to bottom under `compareScopeBand`) for the empty-doc case.
 */
export function primaryScopeFor(a: Access): string {
  if ((a.importer_callings?.['stake']?.length ?? 0) > 0) return 'stake';
  if ((a.manual_grants?.['stake']?.length ?? 0) > 0) return 'stake';
  const importerWardKeys = Object.keys(a.importer_callings ?? {})
    .filter((k) => k !== 'stake' && (a.importer_callings?.[k]?.length ?? 0) > 0)
    .sort();
  if (importerWardKeys.length > 0) return importerWardKeys[0]!;
  const manualWardKeys = Object.keys(a.manual_grants ?? {})
    .filter((k) => k !== 'stake' && (a.manual_grants?.[k]?.length ?? 0) > 0)
    .sort();
  if (manualWardKeys.length > 0) return manualWardKeys[0]!;
  return '_unknown';
}

/**
 * Comparator for the card view: scope band → `sort_order` ascending
 * (null/undefined → bottom of band) → alpha by `member_email`.
 *
 * Uses the doc-level `sort_order` (Sync-denormalised MIN canonical
 * `seatCallingOrder` across `importer_callings`) — under the
 * no-cross-scope-overlap assumption that's the order of the user's only
 * relevant calling.
 */
export function compareAccessForCard(a: Access, b: Access): number {
  const aScope = primaryScopeFor(a);
  const bScope = primaryScopeFor(b);
  const scopeCmp = compareScopeBand(aScope, bScope);
  if (scopeCmp !== 0) return scopeCmp;
  const aOrder = typeof a.sort_order === 'number' ? a.sort_order : Number.POSITIVE_INFINITY;
  const bOrder = typeof b.sort_order === 'number' ? b.sort_order : Number.POSITIVE_INFINITY;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return (a.member_email || a.member_canonical).localeCompare(b.member_email || b.member_canonical);
}
