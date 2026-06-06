// Scope → human label, web edition.
//
// The pure resolver lives in `@kindoo/shared` (`scopeLabel`) as the single
// source of truth shared with the Chrome extension panel. This module
// re-exports it so existing web call sites keep importing from here, and
// layers a Firestore-backed `useScopeLabel` hook on top for pages that
// don't already subscribe to the wards catalogue.

import { useMemo } from 'react';
import { scopeLabel, type Ward } from '@kindoo/shared';
import { useFirestoreCollection } from './data';
import { db } from './firebase';
import { wardsCol } from './docs';
import { useActiveStake } from './useActiveStake';

export { scopeLabel };

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
