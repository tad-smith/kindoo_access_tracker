// Pure helper: build the allowed `New Request` scope list from the
// principal's role union for a given stake. The dropdown on
// `NewRequestPage` filters strictly by the roles the user actually
// holds — manager / superadmin status alone does not grant scope
// options for creating requests (B-3).
//
// Rules (per the operator-stated spec):
//   - `stake` claim          → 'stake' option
//   - per-ward bishopric     → that ward's option
//   - stake + N bishopric    → 'stake' plus those wards (no others)
//   - no stake / no ward     → empty list (page renders not-authorized)
//
// Wards are returned in stable lexicographic order so the dropdown
// renders deterministically across renders. The 'stake' option, when
// present, always sorts first; ward options follow.

import type { Principal } from '../../lib/principal';
import type { ScopeOption } from './components/NewRequestForm';

/**
 * Derive the ordered list of `ScopeOption`s a principal may submit a
 * new request against, for the given stake. Pure; no SDK calls. Tested
 * in `tests/scopeOptions.test.ts`.
 */
export function allowedScopesFor(principal: Principal, stakeId: string): ScopeOption[] {
  const out: ScopeOption[] = [];

  if (principal.stakeMemberStakes.includes(stakeId)) {
    out.push({ value: 'stake', label: 'Stake' });
  }

  const wards = principal.bishopricWards[stakeId] ?? [];
  const sorted = [...wards].sort((a, b) => a.localeCompare(b));
  for (const code of sorted) {
    out.push({ value: code, label: `Ward ${code}` });
  }

  return out;
}

/**
 * "Does this principal have authority over the given scope?" Symmetric
 * with `allowedScopesFor` — if a user can ADD for a scope, they can
 * also REMOVE for it. Powers the per-row Remove button on every
 * roster page so the affordance only appears where the request rule
 * would actually accept the submit.
 *
 * Pure; mirrors the same role logic used by the New Request scope
 * dropdown so the two surfaces stay in sync.
 */
export function isScopeAllowed(principal: Principal, stakeId: string, scope: string): boolean {
  if (scope === 'stake') {
    return principal.stakeMemberStakes.includes(stakeId);
  }
  const wards = principal.bishopricWards[stakeId] ?? [];
  return wards.includes(scope);
}
