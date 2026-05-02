// AccessPage sort helpers.
//
// - Card view: scope-banded grouping (stake first, wards alpha), then
//   doc-level `sort_order` ascending within each band. Operator confirms
//   no cross-scope overlap in real data, so the importer-denormalised
//   doc-level `sort_order` (MIN of `sheet_order` across `importer_callings`)
//   equals the only-scope's calling order.
// - Table view: per-row scope-banded sort using a (scope, calling)
//   `sheet_order` lookup built from the live calling-template
//   collections. Manual grants (free-text reasons that don't match a
//   template) and wildcard-matched callings fall through to
//   `+Infinity` and sort to the bottom of their scope band.
//
// Wildcard handling: NOT supported in v1. The importer's `matchTemplate`
// (functions/src/lib/parser.ts) handles `Counselor *` at write time
// and denormalises `sort_order` onto the seat / access docs anyway.
// Most callings are exact ("Bishop", "EQ President"); upgrade to
// wildcard semantics (port `matchTemplate` from the importer) if the
// operator surfaces a problem.

import type { Access, CallingTemplate } from '@kindoo/shared';

/**
 * Map key shape: `${scope}::${calling}` for stake (scope === 'stake')
 * and ward scopes alike. Ward calling templates are stake-wide
 * (per-stake collection, not per-ward) so every ward scope reuses the
 * same `wardTemplates` pool — we replicate the calling under each
 * ward_code to keep the lookup uniform.
 */
export type SheetOrderLookup = ReadonlyMap<string, number>;

/**
 * Build a `(scope, calling) → sheet_order` lookup from the live
 * template collections. Pass the wards' `ward_code` list so each ward
 * scope inherits the ward-templates pool. Wildcard names (`Counselor *`)
 * skip — see file-level comment.
 */
export function buildSheetOrderLookup(opts: {
  stakeTemplates: ReadonlyArray<CallingTemplate>;
  wardTemplates: ReadonlyArray<CallingTemplate>;
  wardCodes: ReadonlyArray<string>;
}): SheetOrderLookup {
  const map = new Map<string, number>();
  for (const t of opts.stakeTemplates) {
    if (!t.calling_name || t.calling_name.indexOf('*') !== -1) continue;
    map.set(`stake::${t.calling_name}`, t.sheet_order);
  }
  for (const t of opts.wardTemplates) {
    if (!t.calling_name || t.calling_name.indexOf('*') !== -1) continue;
    for (const code of opts.wardCodes) {
      map.set(`${code}::${t.calling_name}`, t.sheet_order);
    }
  }
  return map;
}

/** `+Infinity` when missing — same orphan convention as `lib/sort/seats.ts`. */
export function lookupSheetOrder(map: SheetOrderLookup, scope: string, calling: string): number {
  const v = map.get(`${scope}::${calling}`);
  return typeof v === 'number' ? v : Number.POSITIVE_INFINITY;
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
 * Uses the doc-level `sort_order` (importer-denormalised MIN of
 * `sheet_order` across `importer_callings`) — under the no-cross-scope-
 * overlap assumption that's the order of the user's only relevant
 * calling.
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
