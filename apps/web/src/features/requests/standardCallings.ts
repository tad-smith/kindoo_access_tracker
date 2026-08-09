// Canonical calling names used for typeahead on the New Request / Edit
// Seat `reason` field. Stake-scoped requests filter against
// `STAKE_CALLINGS`; unit-scoped against `UNIT_CALLINGS`. Free-text
// values outside these lists are still accepted on submit; the lists
// are suggestion hints only.
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
// UNIT_CALLINGS SPANS BOTH KINDS OF UNIT. It carries ward and branch
// callings interleaved, mirroring the shared table: a scope-specific
// split (offering a branch only branch-appropriate callings, and vice
// versa) would need `unitType(ward.ward_name)` threaded to
// `CallingCombobox`, and — more to the point — a ruling on which ward
// callings apply to a branch. T-96 enumerated the four families that do
// but did not make that list exhaustive, so the split is deliberately not
// built here. Offering a few extra entries costs little: the combobox
// filters as you type and free text is accepted regardless.

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
 * Standard unit-level callings — ward and branch alike. Surfaced when the
 * request scope is a unit (any scope other than `'stake'`). Each branch
 * calling sits immediately after its ward counterpart, matching the
 * shared table's unit band.
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
