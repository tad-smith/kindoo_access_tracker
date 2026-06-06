// Pure helper: build the allowed `New Request` scope list from the
// principal's role union for a given stake. The list filters strictly
// by the roles the user actually holds — manager / superadmin status
// alone does not grant scope options for creating requests (B-3).
// Powers the roster-page New Request affordances' gating and the
// dialog's scope-label lookup.
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

import type { Seat, Ward } from '@kindoo/shared';
import type { Principal } from '../../lib/principal';
import { scopeLabel } from '../../lib/scopeLabel';
import type { ScopeOption } from './components/NewRequestForm';

/**
 * Derive the ordered list of `ScopeOption`s a principal may submit a
 * new request against, for the given stake. The option `value` is the
 * scope key (`'stake'` or a ward_code); the `label` is the ward name,
 * resolved from `wards` (falls back to the raw code when unresolved).
 * Pure; no SDK calls. Tested in `tests/scopeOptions.test.ts`.
 */
export function allowedScopesFor(
  principal: Principal,
  stakeId: string,
  wards: readonly Ward[],
): ScopeOption[] {
  const out: ScopeOption[] = [];

  if (principal.stakeMemberStakes.includes(stakeId)) {
    out.push({ value: 'stake', label: 'Stake' });
  }

  const bishopricWards = principal.bishopricWards[stakeId] ?? [];
  const sorted = [...bishopricWards].sort((a, b) => a.localeCompare(b));
  for (const code of sorted) {
    out.push({ value: code, label: scopeLabel(code, wards) });
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

/**
 * "Can this principal submit an edit for this seat?" Two gates:
 *
 *   1. **Policy 1 — stake-scope auto seats are non-editable.** Church-
 *      granted access to every stake building; nothing to add or
 *      constrain. Hidden everywhere; no UI affordance. Ward-scope auto
 *      seats ARE editable from the roster pages via `EditSeatDialog`'s
 *      constrained `edit_auto` sub-mode (currently-granted buildings
 *      locked; additions only) — Policy 1 covers the stake-scope case
 *      only.
 *
 *   2. **Role-for-scope.** Same `isScopeAllowed` predicate as the per-
 *      row Remove button — if you can Remove, you can Edit. A bishopric
 *      can edit ward-scope seats in their ward; a stake member can edit
 *      stake-scope seats; manager status alone is not enough.
 *
 * Pure helper; tested in `tests/scopeOptions.test.ts`.
 */
export function canEditSeat(principal: Principal, stakeId: string, seat: Seat): boolean {
  if (seat.type === 'auto' && seat.scope === 'stake') return false;
  return isScopeAllowed(principal, stakeId, seat.scope);
}
