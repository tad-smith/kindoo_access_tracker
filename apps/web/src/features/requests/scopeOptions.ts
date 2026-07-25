// Pure helper: build the allowed `New Request` scope list from the
// principal's role union for a given stake. Powers the roster-page New
// Request affordances' gating and the dialog's scope-label lookup.
//
// Rules (per the operator-stated spec):
//   - Kindoo Manager claim   → every scope: 'stake' plus every ward
//   - `stake` claim          → 'stake' option
//   - per-ward bishopric     → that ward's option
//   - stake + N bishopric    → 'stake' plus those wards (no others)
//   - no manager / stake / ward → empty list (page renders not-authorized)
//
// A Kindoo Manager in the stake may request in any scope without
// holding a separate `access` row; the matching `requests` create rule
// admits `isManager(stakeId)` unconditionally. Platform superadmin
// status alone grants nothing here — only the per-stake manager claim
// does.
//
// Wards are returned in stable lexicographic order so the dropdown
// renders deterministically across renders. The 'stake' option, when
// present, always sorts first; ward options follow. Overlapping claims
// (manager + stake + bishopric) never duplicate a scope.

import type { Seat, Ward } from '@kindoo/shared';
import type { Principal } from '../../lib/principal';
import { scopeLabel } from '../../lib/scopeLabel';
import type { ScopeOption } from './components/NewRequestForm';

/**
 * Derive the ordered list of `ScopeOption`s a principal may submit a
 * new request against, for the given stake. The option `value` is the
 * scope key (`'stake'` or a ward_code); the `label` is the ward name,
 * resolved from `wards` (falls back to the raw code when unresolved).
 *
 * A Kindoo Manager in `stakeId` gets `'stake'` plus every ward in the
 * catalogue. Otherwise the list is the union of the stake claim and the
 * per-ward bishopric claims. Pure; no SDK calls. Tested in
 * `tests/scopeOptions.test.ts`.
 */
export function allowedScopesFor(
  principal: Principal,
  stakeId: string,
  wards: readonly Ward[],
): ScopeOption[] {
  const isManager = principal.managerStakes.includes(stakeId);
  const out: ScopeOption[] = [];

  if (isManager || principal.stakeMemberStakes.includes(stakeId)) {
    out.push({ value: 'stake', label: 'Stake' });
  }

  // Set-union so a manager who also holds bishopric claims never gets a
  // ward twice. A bishopric ward missing from the catalogue still
  // appears (labelled by its raw code).
  const codes = new Set(principal.bishopricWards[stakeId] ?? []);
  if (isManager) {
    for (const w of wards) codes.add(w.ward_code);
  }

  for (const code of [...codes].sort((a, b) => a.localeCompare(b))) {
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
 * A Kindoo Manager in `stakeId` holds authority over every scope —
 * stake and every ward — with no `access` row of their own. Platform
 * superadmin status alone grants nothing; only the per-stake manager
 * claim does.
 *
 * Pure; mirrors the same role logic used by the New Request scope
 * dropdown so the two surfaces stay in sync.
 */
export function isScopeAllowed(principal: Principal, stakeId: string, scope: string): boolean {
  if (principal.managerStakes.includes(stakeId)) return true;
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
 *      stake-scope seats; a Kindoo Manager can edit any scope.
 *
 * Gate 1 runs first and is absolute: a manager still cannot edit a
 * stake-scope auto seat.
 *
 * Pure helper; tested in `tests/scopeOptions.test.ts`.
 */
export function canEditSeat(principal: Principal, stakeId: string, seat: Seat): boolean {
  if (seat.type === 'auto' && seat.scope === 'stake') return false;
  return isScopeAllowed(principal, stakeId, seat.scope);
}
