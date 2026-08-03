// Fixed sets of callings that grant in-app access, replacing the
// per-stake calling-template config. Ward callings apply to every ward
// scope; stake callings apply to the stake scope. Names match
// `callingSortOrder.ts` verbatim (typo-guarded by a unit test).
//
// The two arrays below are the churchwide base list and are the same for
// every stake. One further ward calling — Elders Quorum President — is
// stake-gated rather than hard-coded: it grants access only when the
// stake opts in via `stake.eq_president_app_access`, threaded through as
// `AppAccessOptions.eqPresidentAccess`. The stake set is never affected
// by the opt-in.

export const WARD_APP_ACCESS_CALLINGS = [
  'Bishop',
  'Bishopric First Counselor',
  'Bishopric Second Counselor',
  'Ward Clerk',
  'Ward Executive Secretary',
] as const;

export const STAKE_APP_ACCESS_CALLINGS = [
  'Stake President',
  'Stake Presidency First Counselor',
  'Stake Presidency Second Counselor',
  'Stake Clerk',
  'Stake Executive Secretary',
  'Stake High Councilor',
] as const;

/** The one stake-gated ward calling. Exact title only — the quorum's
 * counselors and secretary never grant access. */
export const EQ_PRESIDENT_CALLING = 'Elders Quorum President';

/**
 * WRITER-SIDE POLICY (D26). App-access callings whose derived access is
 * the LIMITED tier (D25) rather than full.
 *
 * Consulted **only** where a writer inserts or replaces an access
 * record's calling list — `syncApplyFix` and `backfillEqPresidentAccess`
 * — and never on a read path. The tier is decided once, at write time,
 * and stored in `Access.importer_limited_callings[scope]`; every reader
 * (claim minter, App Access page) reads that stored field. Deriving a
 * tier from a calling name at read time would let the page and the claim
 * minter disagree, and would silently re-tier existing records the moment
 * this constant changed.
 *
 * Consequence of storing it: changing this set does NOT re-tier records
 * already written. They keep whatever the writer stamped until that scope
 * is next written.
 */
export const LIMITED_TIER_CALLINGS: ReadonlySet<string> = new Set<string>([EQ_PRESIDENT_CALLING]);

export interface AppAccessOptions {
  /** Pass `stake.eq_president_app_access === true`. Adds Elders Quorum
   * President to the WARD set only; the stake set is unaffected. */
  eqPresidentAccess?: boolean;
}

// Normalisation key — same scheme as `callingSortOrder.ts` (trim +
// lowercase). Matching is exact on this key.
function normalize(calling: string): string {
  return calling.trim().toLowerCase();
}

const LIMITED_TIER_SET: ReadonlySet<string> = new Set([...LIMITED_TIER_CALLINGS].map(normalize));
const WARD_SET: ReadonlySet<string> = new Set(WARD_APP_ACCESS_CALLINGS.map(normalize));
const STAKE_SET: ReadonlySet<string> = new Set(STAKE_APP_ACCESS_CALLINGS.map(normalize));
const WARD_SET_WITH_EQ: ReadonlySet<string> = new Set(
  [...WARD_APP_ACCESS_CALLINGS, EQ_PRESIDENT_CALLING].map(normalize),
);

/**
 * Normalised app-access calling set for a scope. `'stake'` → the stake
 * set; any other scope (a ward_code) → the ward set. With
 * `opts.eqPresidentAccess`, the ward set additionally carries Elders
 * Quorum President; the stake set is returned unchanged either way.
 */
export function appAccessCallingsForScope(
  scope: string,
  opts?: AppAccessOptions,
): ReadonlySet<string> {
  if (scope === 'stake') return STAKE_SET;
  return opts?.eqPresidentAccess === true ? WARD_SET_WITH_EQ : WARD_SET;
}

/**
 * Subset of `callings` whose normalised form grants app access for the
 * given scope. Original casing is preserved on the returned values.
 */
export function filterAppAccessCallings(
  scope: string,
  callings: readonly string[],
  opts?: AppAccessOptions,
): string[] {
  const allowed = appAccessCallingsForScope(scope, opts);
  return callings.filter((c) => allowed.has(normalize(c)));
}

/**
 * WRITER-SIDE. Subset of `callings` whose normalised form is
 * limited-tier ({@link LIMITED_TIER_CALLINGS}). Original casing is
 * preserved, so the result is a literal subset of the input and can be
 * stored verbatim in `Access.importer_limited_callings[scope]` beside the
 * `importer_callings[scope]` it was derived from.
 *
 * Callers pass the already-app-access-filtered list
 * (`filterAppAccessCallings`), so the result names exactly the granted
 * callings that confer limited access. Never call this on a read path —
 * readers consult the stored field.
 */
export function filterLimitedTierCallings(callings: readonly string[]): string[] {
  return callings.filter((c) => LIMITED_TIER_SET.has(normalize(c)));
}
