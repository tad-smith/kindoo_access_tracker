// Hardcoded canonical calling names used for typeahead on the New
// Request form's `reason` field. Stake-scoped requests filter against
// `STAKE_CALLINGS`; ward-scoped against `WARD_CALLINGS`. Free-text
// values outside these lists are still accepted on submit; the lists
// are suggestion hints only.
//
// Names + order are the operator's authoritative calling list (the same
// hierarchy as the compiled sort table in
// `@kindoo/shared/callingSortOrder`): STAKE_CALLINGS = entries 1–42
// (Stake President … Patriarch); WARD_CALLINGS = entries 43–85 (Bishop
// … Technology Specialist), split at the `Bishop` boundary. Order is
// intentional (organisational hierarchy) — preserve it. Edit by source
// control; this file is the source of truth for the typeahead.

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

/** Standard ward-level callings. Surfaced when the request scope is a ward. */
export const WARD_CALLINGS: readonly string[] = [
  'Bishop',
  'Bishopric First Counselor',
  'Bishopric Second Counselor',
  'Ward Executive Secretary',
  'Ward Assistant Executive Secretary',
  'Ward Clerk',
  'Ward Assistant Clerk',
  'Ward Assistant Clerk--Membership',
  'Ward Assistant Clerk--Finance',
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
