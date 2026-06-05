// Hard-coded sets of callings that grant in-app access, replacing the
// per-stake calling-template config. Ward callings apply to every ward
// scope; stake callings apply to the stake scope. Names match
// `callingSortOrder.ts` verbatim (typo-guarded by a unit test).

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

// Normalisation key — same scheme as `callingSortOrder.ts` (trim +
// lowercase). Matching is exact on this key.
function normalize(calling: string): string {
  return calling.trim().toLowerCase();
}

const WARD_SET: ReadonlySet<string> = new Set(WARD_APP_ACCESS_CALLINGS.map(normalize));
const STAKE_SET: ReadonlySet<string> = new Set(STAKE_APP_ACCESS_CALLINGS.map(normalize));

/**
 * Normalised app-access calling set for a scope. `'stake'` → the stake
 * set; any other scope (a ward_code) → the ward set.
 */
export function appAccessCallingsForScope(scope: string): ReadonlySet<string> {
  return scope === 'stake' ? STAKE_SET : WARD_SET;
}

/**
 * Subset of `callings` whose normalised form grants app access for the
 * given scope. Original casing is preserved on the returned values.
 */
export function filterAppAccessCallings(scope: string, callings: readonly string[]): string[] {
  const allowed = appAccessCallingsForScope(scope);
  return callings.filter((c) => allowed.has(normalize(c)));
}
