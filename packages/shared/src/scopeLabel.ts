// Resolve a stored scope value to a human-facing label.
//
// A scope is either the literal `'stake'` or a `ward_code` (e.g. `"CO"`).
// Everywhere a scope is shown to a user we render the ward NAME, not the
// code:
//   - `'stake'`              → `"Stake"`
//   - a resolvable ward_code → that ward's `ward_name`
//   - an unresolved code     → the raw scope unchanged (fallback)
//
// The Configuration → Wards admin screen is the one exception — it keeps
// the code, since that's where the code↔name mapping is managed.
//
// Pure (no DOM, no subscription) so it works in both the web SPA and the
// Chrome extension panel. The web app re-exports this and layers a
// Firestore-backed `useScopeLabel` hook on top.

import type { Ward } from './types/ward.js';

/**
 * Map a stored scope to its display label against a wards list. An empty
 * or unresolved wards list falls back to the raw scope.
 */
export function scopeLabel(scope: string, wards: readonly Ward[]): string {
  if (scope === 'stake') return 'Stake';
  const match = wards.find((w) => w.ward_code === scope);
  return match ? match.ward_name : scope;
}
