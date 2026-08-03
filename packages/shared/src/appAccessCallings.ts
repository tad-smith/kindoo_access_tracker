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
 * Importer callings that confer LIMITED app access rather than full.
 * Empty today: every calling the importer grants is full-tier. The next
 * step (Elders Quorum Presidents get limited access) adds
 * `EQ_PRESIDENT_CALLING` here — which also requires re-minting claims for
 * existing EQ-President access docs, since `syncAccessClaims` only fires
 * on access-doc writes.
 */
export const LIMITED_ACCESS_CALLINGS: ReadonlySet<string> = new Set<string>();

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
 * True when `calling` sits in the limited-access set — i.e. holding it
 * confers limited rather than full app access. Both sides are matched on
 * the trim+lowercase key the access sets use, so `limitedCallings` may
 * hold titles in display casing. `limitedCallings` is injectable so a
 * caller (and the tests) can exercise the non-empty path while the
 * shipped set is still empty.
 */
export function isLimitedAccessCalling(
  calling: string,
  limitedCallings: ReadonlySet<string> = LIMITED_ACCESS_CALLINGS,
): boolean {
  if (limitedCallings.size === 0) return false;
  const key = normalize(calling);
  for (const limited of limitedCallings) {
    if (normalize(limited) === key) return true;
  }
  return false;
}
