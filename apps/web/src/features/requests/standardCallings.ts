// Canonical calling names used for typeahead on the New Request / Edit
// Seat `reason` field. Callers resolve a scope to its list through
// `callingsForScope`. Free-text values outside these lists are still
// accepted on submit; the lists are suggestion hints only.
//
// NOTHING HERE NAMES A CALLING (T-99).
//
// The two lists are the two bands of `@kindoo/shared`'s calling table,
// re-exported under the names this feature uses. This file held a
// hand-maintained copy of all 92 names until T-99, because the shared
// table was module-private and `callingSortOrder` exported only a
// name→order *lookup*, which cannot be enumerated. The copy cost a real
// bug: T-96's seven branch callings landed in `shared`, reached the sort
// table, the app-access sets and the extension, and silently not here —
// a Branch President was unselectable on the New Request form and
// nothing failed. Adding a churchwide calling is now an edit to
// `packages/shared/src/callingSortOrder.ts` alone.
//
// The stake/unit split is not made here either: `shared` exports the two
// bands, so the boundary stays a property of the table rather than an
// `indexOf('Bishop')` in this file.
//
// WHAT IS STILL HAND-MAINTAINED: the two hide-sets below. They encode a
// product ruling about which ward callings a branch replaces — not a
// churchwide fact — so they stay here. They are also the one thing that
// can still go stale silently: subtraction of a name the shared table no
// longer spells simply removes nothing, and the wrong entry appears in a
// branch's typeahead. `tests/standardCallings.test.ts` pins every
// hide-set name against the shared unit band for that reason.
//
// THE UNIT LIST IS SPLIT BY UNIT KIND (operator ruling, 2026-08-09).
//
// `UNIT_CALLINGS` is the union — both kinds interleaved, as the shared
// table's unit band has them. It is the ordered source the two
// scope-specific lists subtract from. Callers do not use it directly;
// they go through `callingsForScope`.
//
// The ruling: swap only the callings that have a branch counterpart, and
// carry everything else over.
//
//   - At a BRANCH, the seven ward callings with a branch counterpart are
//     hidden and the counterpart shown instead (Bishop → Branch
//     President, Ward Clerk → Branch Clerk, and so on).
//   - Ward Executive Secretary and Ward Assistant Executive Secretary are
//     hidden at a branch with NO replacement. Branches have no executive
//     secretary at all — the same fact behind T-96's deliberate omission
//     of a "Branch Executive Secretary" from the shared table.
//   - Everything else carries over unchanged: Elders Quorum, Relief
//     Society, Primary, Young Women, Sunday School, Ward Mission Leader,
//     Building Representative, Technology Specialist, and the rest.
//     T-96's four families are NOT an exhaustive whitelist of what a
//     branch may call someone.
//   - At a WARD, the seven branch callings do not appear.
//
// The two lists are computed by subtraction rather than written out, so
// a new entry in the shared table reaches both automatically and only
// the two small hide-sets ever need editing.

import { STAKE_CALLING_ORDER, UNIT_CALLING_ORDER, unitType, type Ward } from '@kindoo/shared';

/**
 * Standard stake-level callings — the shared table's stake band.
 * Surfaced when the request scope is `'stake'`.
 */
export const STAKE_CALLINGS: readonly string[] = STAKE_CALLING_ORDER;

/**
 * Every unit-level calling, both kinds — the shared table's unit band,
 * each branch calling immediately after its ward counterpart. The union
 * the two scope-specific lists subtract from, and the fallback when a
 * unit scope cannot be resolved; see {@link callingsForScope}.
 */
export const UNIT_CALLINGS: readonly string[] = UNIT_CALLING_ORDER;

/**
 * Branch-specific callings — hidden at a ward scope.
 *
 * Exported so the test can pin every name against the shared unit band:
 * a name the table no longer spells subtracts nothing, silently.
 */
export const BRANCH_ONLY_CALLINGS: ReadonlySet<string> = new Set([
  'Branch President',
  'Branch Presidency First Counselor',
  'Branch Presidency Second Counselor',
  'Branch Clerk',
  'Branch Assistant Clerk',
  'Branch Assistant Clerk--Membership',
  'Branch Assistant Clerk--Finance',
]);

/**
 * Ward callings hidden at a branch scope. The first seven are swapped for
 * their branch counterpart; the two executive-secretary entries are
 * dropped outright, because a branch has no executive secretary.
 *
 * Exported for the same pinning reason as {@link BRANCH_ONLY_CALLINGS}.
 */
export const WARD_ONLY_CALLINGS: ReadonlySet<string> = new Set([
  'Bishop',
  'Bishopric First Counselor',
  'Bishopric Second Counselor',
  'Ward Clerk',
  'Ward Assistant Clerk',
  'Ward Assistant Clerk--Membership',
  'Ward Assistant Clerk--Finance',
  'Ward Executive Secretary',
  'Ward Assistant Executive Secretary',
]);

/** Callings offered at a ward scope: the unit band without the branch-only entries. */
export const WARD_CALLINGS: readonly string[] = UNIT_CALLINGS.filter(
  (c) => !BRANCH_ONLY_CALLINGS.has(c),
);

/** Callings offered at a branch scope: the unit band without the ward-only entries. */
export const BRANCH_CALLINGS: readonly string[] = UNIT_CALLINGS.filter(
  (c) => !WARD_ONLY_CALLINGS.has(c),
);

/**
 * Suggestion list for a submission scope.
 *
 * `'stake'` → {@link STAKE_CALLINGS}, whatever the unit catalogue holds.
 * A unit scope resolves through the ward doc's NAME — `unitType` reads
 * the `" Branch"` suffix (D31), and `ward_code` is a slug that cannot be
 * trusted to carry it.
 *
 * An unresolvable unit scope falls back to the full {@link UNIT_CALLINGS}
 * union rather than an empty list. This is not merely defensive: callers
 * pass `wards` straight from a live query, so during the fetch every
 * scope is unresolvable, and a blank typeahead mid-load is worse than a
 * superset. Offering a few inapplicable entries costs nothing here — the
 * combobox filters as you type, and free text is accepted on submit
 * regardless.
 */
export function callingsForScope(scope: string, wards: readonly Ward[]): readonly string[] {
  if (scope === 'stake') return STAKE_CALLINGS;
  const ward = wards.find((w) => w.ward_code === scope);
  if (!ward?.ward_name) return UNIT_CALLINGS;
  return unitType(ward.ward_name) === 'branch' ? BRANCH_CALLINGS : WARD_CALLINGS;
}
