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
import type { GrantView } from '../../lib/grants';
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
 * "Does this principal hold LIMITED app access in this stake?" (D24).
 *
 * `limited` is a narrowing flag on an existing role, not a role of its
 * own — a limited user still needs the bishopric / stake claim that
 * `isScopeAllowed` tests. What the flag removes is authority over the
 * durable seat types: a limited user may only ever touch `temp` seats,
 * and only within a 90-day window. Every gate below consults this
 * predicate rather than reading `limitedStakes` directly, so the
 * narrowing lands on all call sites at once.
 */
export function isLimitedInStake(principal: Principal, stakeId: string): boolean {
  return principal.limitedStakes.includes(stakeId);
}

/**
 * "Can this principal submit an edit for this seat?" Three gates:
 *
 *   1. **Policy 1 — stake-scope auto seats are non-editable.** Church-
 *      granted access to every stake building; nothing to add or
 *      constrain. Hidden everywhere; no UI affordance. Ward-scope auto
 *      seats ARE editable from the roster pages via `EditSeatDialog`'s
 *      constrained `edit_auto` sub-mode (currently-granted buildings
 *      locked; additions only) — Policy 1 covers the stake-scope case
 *      only.
 *
 *   2. **D24 — a limited user edits temp seats and nothing else.** Auto
 *      and manual seats are durable grants outside their authority, so
 *      the Edit affordance never renders on those rows. Placing the gate
 *      here (rather than at each roster page) means all three roster
 *      pages and `EditSeatAffordance` inherit it, and `EditSeatDialog`
 *      can assume `edit_temp` is the only sub-mode a limited user
 *      reaches.
 *
 *   3. **Role-for-scope.** Same `isScopeAllowed` predicate as the per-
 *      row Remove button — if you can Remove, you can Edit. A bishopric
 *      can edit ward-scope seats in their ward; a stake member can edit
 *      stake-scope seats; manager status alone is not enough.
 *
 * Pure helper; tested in `tests/scopeOptions.test.ts`.
 */
export function canEditSeat(principal: Principal, stakeId: string, seat: Seat): boolean {
  if (seat.type === 'auto' && seat.scope === 'stake') return false;
  if (isLimitedInStake(principal, stakeId) && seat.type !== 'temp') return false;
  return isScopeAllowed(principal, stakeId, seat.scope);
}

/**
 * "Can this principal submit a removal for this grant row?" The base
 * gate is `isScopeAllowed` against the GRANT's scope (a seat can carry
 * duplicate grants in scopes the viewer has no authority over), plus the
 * D24 narrowing: a limited user may remove temp grants only.
 *
 * **Deliberately stricter than the rules.** `limitedRemoveTargetIsTemp`
 * checks only the SEAT's primary `type`, because a rules `get()` can
 * read the seat doc but can't cheaply prove which `duplicate_grants[]`
 * row a removal targets. The client knows exactly which row the button
 * sits on, so it additionally requires the grant row itself to be temp.
 * The asymmetry is one-directional and safe: everything this predicate
 * admits, the rules also admit. It exists so the UI never renders a
 * Remove button whose submit the server would reject — a limited user
 * looking at the temp primary of a seat that also carries a manual
 * duplicate grant sees Remove on the temp row only.
 *
 * Callers keep their own `grant.type !== 'auto'` gate: auto grants are
 * LCR-managed for everyone, limited or not.
 *
 * Pure helper; tested in `tests/scopeOptions.test.ts`.
 */
export function canRemoveSeat(
  principal: Principal,
  stakeId: string,
  seat: Seat,
  grant: Pick<GrantView, 'scope' | 'type'>,
): boolean {
  if (isLimitedInStake(principal, stakeId) && (seat.type !== 'temp' || grant.type !== 'temp')) {
    return false;
  }
  return isScopeAllowed(principal, stakeId, grant.scope);
}
