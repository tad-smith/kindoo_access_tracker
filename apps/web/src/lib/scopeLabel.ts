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

import { useMemo } from 'react';
import type { Ward } from '@kindoo/shared';
import { useFirestoreCollection } from './data';
import { db } from './firebase';
import { wardsCol } from './docs';
import { useActiveStake } from './useActiveStake';

/**
 * Pure: map a stored scope to its display label against a wards list.
 * Tested in `scopeLabel.test.ts`.
 */
export function scopeLabel(scope: string, wards: readonly Ward[]): string {
  if (scope === 'stake') return 'Stake';
  const match = wards.find((w) => w.ward_code === scope);
  return match ? match.ward_name : scope;
}

/**
 * Thin hook wrapping the live wards subscription. Returns a stable
 * `(scope) => string` closure so call sites can label scopes without
 * threading the wards array through every component. Wards default to an
 * empty list while the subscription hydrates — unresolved scopes fall
 * back to the raw code until the names arrive.
 *
 * Prefer the pure `scopeLabel(scope, wards)` form when the caller already
 * subscribes to the wards catalogue; this hook spawns its own
 * subscription, so use it only on pages that don't already read wards.
 */
export function useScopeLabel(): (scope: string) => string {
  const activeStakeId = useActiveStake();
  const wardsQuery = useMemo(
    () => (activeStakeId ? wardsCol(db, activeStakeId) : null),
    [activeStakeId],
  );
  const wards = useFirestoreCollection<Ward>(wardsQuery);
  // Key on `wards.data` (stable per snapshot; `undefined` is a stable
  // primitive) so the closure only rebuilds when the catalogue changes.
  return useMemo(() => {
    const list = wards.data ?? [];
    return (scope: string) => scopeLabel(scope, list);
  }, [wards.data]);
}
