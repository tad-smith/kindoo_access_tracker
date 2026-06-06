// Organizations — a neutral, dependency-light read module shared by
// the manager Configuration "Organizations" tab, the request forms (the
// optional org selector on stake-scope add/edit), and the Stake Roster
// (the org chip + per-organization utilization bars).
//
// Importable by features/manager, features/requests, and features/stake
// without circular deps: it depends only on `lib/` (the DIY data hook,
// the SDK singleton, the doc refs, the active-stake selector) and
// `@kindoo/shared`, never on a sibling feature.

import { useMemo } from 'react';
import type { Organization } from '@kindoo/shared';
import { useFirestoreCollection, type FirestoreCollectionResult } from '../../lib/data';
import { db } from '../../lib/firebase';
import { organizationsCol } from '../../lib/docs';
import { useActiveStake } from '../../lib/useActiveStake';

/** Label rendered when a grant has no organization (id null / absent / unresolved). */
export const NO_ORGANIZATION_LABEL = 'No Organization';

/**
 * Live organizations catalogue for the active stake. Empty when the
 * stake has no organizations yet; `null` active stake (zero-role
 * superadmin) disables the subscription.
 */
export function useOrganizations(): FirestoreCollectionResult<Organization> {
  const activeStakeId = useActiveStake();
  const q = useMemo(
    () => (activeStakeId ? organizationsCol(db, activeStakeId) : null),
    [activeStakeId],
  );
  return useFirestoreCollection<Organization>(q);
}

/**
 * Resolve an `organization_id` to its display name. Returns
 * `'No Organization'` when the id is null / absent, and falls back to
 * `'No Organization'` when the id doesn't resolve against `orgs` (e.g.
 * the catalogue is still loading or the org was deleted). Renames
 * resolve here at render time — seats / requests reference the immutable
 * slug id, never the name.
 */
export function organizationName(
  orgs: Organization[] | undefined,
  id: string | null | undefined,
): string {
  if (id == null) return NO_ORGANIZATION_LABEL;
  const match = orgs?.find((o) => o.organization_id === id);
  return match ? match.name : NO_ORGANIZATION_LABEL;
}

/**
 * Alpha sort by `name`, case-insensitive. Returns a new array; does not
 * mutate the input.
 */
export function sortOrganizations(orgs: Organization[] | undefined): Organization[] {
  if (!orgs) return [];
  return [...orgs].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
