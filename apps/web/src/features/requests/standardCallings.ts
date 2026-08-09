// Canonical calling names used for typeahead on the New Request / Edit
// Seat `reason` field. Callers resolve a scope to its list through
// `callingsForScope`. Free-text values outside these lists are still
// accepted on submit; the lists are suggestion hints only.
//
// WHY THIS IS A COPY, AND WHAT KEEPS IT HONEST
//
// These two lists together reproduce `@kindoo/shared/callingSortOrder`'s
// table exactly — same names, same order, split at the `Bishop` boundary
// where the stake band ends and the unit band begins. That is
// duplication of a churchwide fact, and `packages/shared/CLAUDE.md` says
// such a fact belongs in `shared`. It is a copy only because the table
// itself (`CALLING_ORDER`) is module-private there: `callingSortOrder`
// exports a name→order *lookup*, which cannot be enumerated, so the
// typeahead has nothing to derive a list from.
//
// The fix is to export the ordered table from `packages/shared` and
// derive both lists from it. Until then `tests/standardCallings.test.ts`
// pins this file against the shared table: every entry must resolve, the
// concatenation must be strictly ascending by `callingSortOrder`, and the
// indices covered must be gap-free. A rename, a reorder, or an insertion
// in the shared table fails that test instead of silently stranding an
// entry — which is exactly how the seven branch callings went missing
// here after they landed in `shared` (T-96).
//
// Order is intentional (organisational hierarchy) — preserve it, and
// keep it in step with the shared table.
//
// THE UNIT LIST IS SPLIT BY UNIT KIND (operator ruling, 2026-08-09).
//
// `UNIT_CALLINGS` below is the union — both kinds interleaved, mirroring
// the shared table's unit band. It is the ordered source the two
// scope-specific lists subtract from, and the list the conformance test
// checks. Callers do not use it directly; they go through
// `callingsForScope`.
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

import { unitType, type Ward } from '@kindoo/shared';

/** Standard stake-level callings. Surfaced when the request scope is `'stake'`. */
export const STAKE_CALLINGS: readonly string[] = [
  'Stake President',
  'Stake Presidency First Counselor',
  'Stake Presidency Second Counselor',
  'Stake Clerk',
  'Stake Executive Secretary',
  'Stake Assistant Executive Secretary',
  'Stake Assistant Clerk',
  'Stake Assistant Clerk--Membership',
  'Stake Assistant Clerk--Finance',
  'Stake High Councilor',
  'Stake Relief Society President',
  'Stake Relief Society First Counselor',
  'Stake Relief Society Second Counselor',
  'Stake Relief Society Secretary',
  'Stake Young Men President',
  'Stake Young Men First Counselor',
  'Stake Young Men Second Counselor',
  'Stake Young Men Secretary',
  'Stake Young Women President',
  'Stake Young Women First Counselor',
  'Stake Young Women Second Counselor',
  'Stake Young Women Secretary',
  'Stake Sunday School President',
  'Stake Sunday School First Counselor',
  'Stake Sunday School Second Counselor',
  'Stake Sunday School Secretary',
  'Stake Primary President',
  'Stake Primary First Counselor',
  'Stake Primary Second Counselor',
  'Stake Primary Secretary',
  'Stake Building Representative',
  'Stake Building Specialist',
  'Stake Technology Specialist',
  'Stake Single Adult Adviser',
  'Stake Single Adult Representative',
  'Stake Young Single Adult Advisor',
  'Stake Young Single Adult Representative',
  'Stake Music Chairman',
  'Audit Committee Chairman',
  'Audit Committee Member',
  'Auditor',
  'Patriarch',
];

/**
 * Every unit-level calling, both kinds — the union the two scope-specific
 * lists subtract from, in the shared table's unit-band order (each branch
 * calling immediately after its ward counterpart). Also the fallback when
 * a unit scope cannot be resolved; see {@link callingsForScope}.
 */
export const UNIT_CALLINGS: readonly string[] = [
  'Bishop',
  'Branch President',
  'Bishopric First Counselor',
  'Branch Presidency First Counselor',
  'Bishopric Second Counselor',
  'Branch Presidency Second Counselor',
  // No Branch Executive Secretary — branches have no counterpart to
  // Ward Executive Secretary (T-96, confirmed deliberate).
  'Ward Executive Secretary',
  'Ward Assistant Executive Secretary',
  'Ward Clerk',
  'Branch Clerk',
  'Ward Assistant Clerk',
  'Branch Assistant Clerk',
  'Ward Assistant Clerk--Membership',
  'Branch Assistant Clerk--Membership',
  'Ward Assistant Clerk--Finance',
  'Branch Assistant Clerk--Finance',
  // The families below are shared: the same entries name a branch's
  // people as a ward's.
  'Elders Quorum President',
  'Elders Quorum First Counselor',
  'Elders Quorum Second Counselor',
  'Elders Quorum Secretary',
  'Elders Quorum Assistant Secretary',
  'Relief Society President',
  'Relief Society First Counselor',
  'Relief Society Second Counselor',
  'Relief Society Secretary',
  'Aaronic Priesthood Advisors',
  'Aaronic Priesthood Specialist',
  'Young Women President',
  'Young Women First Counselor',
  'Young Women Second Counselor',
  'Young Women Secretary',
  'Young Women Specialist',
  'Young Women Class Adviser',
  'Sunday School President',
  'Sunday School First Counselor',
  'Sunday School Second Counselor',
  'Sunday School Secretary',
  'Primary President',
  'Primary First Counselor',
  'Primary Second Counselor',
  'Primary Secretary',
  'Valiant Activities Leader',
  'Ward Mission Leader',
  'Assistant Ward Mission Leader',
  'Ward Temple and Family History Leader',
  'Young Single Adult Adviser',
  'Building Representative',
  'History Specialist',
  'Email Communication Specialist',
  'Technology Specialist',
];

/** Branch-specific callings — hidden at a ward scope. */
const BRANCH_ONLY_CALLINGS: ReadonlySet<string> = new Set([
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
 */
const WARD_ONLY_CALLINGS: ReadonlySet<string> = new Set([
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
