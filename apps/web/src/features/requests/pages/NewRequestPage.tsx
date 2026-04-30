// Per-role wrapper around the shared `NewRequestForm`. Resolves the
// principal's allowed-scope list (stake / per-bishopric-ward / all
// scopes for managers), seeds the form's scope set, and live-loads
// the buildings catalogue for the stake-scope checkbox group.
//
// Two routes mount this page: `/bishopric/new` and `/stake/new`. Each
// passes a `role` prop that constrains which scopes are offered:
//   - bishopric → principal's bishopric wards (or, for a manager, all
//     configured wards)
//   - stake     → the stake scope (always available to managers; only
//     to stake-claim members otherwise)
// Managers hold stake-wide authority (per spec §6 + invariant 7) so
// they can submit any scope on either route.

import { useMemo } from 'react';
import { usePrincipal } from '../../../lib/principal';
import { STAKE_ID } from '../../../lib/constants';
import { useFirestoreCollection } from '../../../lib/data';
import { buildingsCol, wardsCol } from '../../../lib/docs';
import { db } from '../../../lib/firebase';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import type { Building, Ward } from '@kindoo/shared';
import { NewRequestForm, type ScopeOption } from '../components/NewRequestForm';

type Role = 'bishopric' | 'stake';

export interface NewRequestPageProps {
  role: Role;
}

export function NewRequestPage({ role }: NewRequestPageProps) {
  const principal = usePrincipal();
  const isManager = principal.managerStakes.includes(STAKE_ID);

  const buildingsQuery = useMemo(() => buildingsCol(db, STAKE_ID), []);
  const buildings = useFirestoreCollection<Building>(buildingsQuery);

  // Managers + bishopric users on `/bishopric/new` need the live wards
  // catalogue: a manager picking a ward to submit against can only
  // legitimately pick a configured ward, and the form's scope dropdown
  // sources from there. Bishopric-only users derive their ward set
  // from claims, so the wards subscription is no-op-cheap when not
  // needed.
  const wardsQuery = useMemo(() => wardsCol(db, STAKE_ID), []);
  const wards = useFirestoreCollection<Ward>(wardsQuery);

  const scopes = useMemo<ScopeOption[]>(() => {
    if (role === 'stake') {
      // Managers + stake-claim members can submit stake-scope.
      if (isManager || principal.stakeMemberStakes.includes(STAKE_ID)) {
        return [{ value: 'stake', label: 'Stake' }];
      }
      return [];
    }
    // Bishopric route. Managers see every configured ward; bishopric
    // users see only their own ward(s).
    if (isManager) {
      return [...(wards.data ?? [])]
        .map((w) => w.ward_code)
        .sort((a, b) => a.localeCompare(b))
        .map((code) => ({ value: code, label: `Ward ${code}` }));
    }
    const claimed = principal.bishopricWards[STAKE_ID] ?? [];
    return claimed.map((w) => ({ value: w, label: `Ward ${w}` }));
  }, [role, isManager, principal.stakeMemberStakes, principal.bishopricWards, wards.data]);

  const heading = role === 'stake' ? 'New Stake Request' : 'New Kindoo Request';
  const subtitle =
    role === 'stake'
      ? 'Submit a manual or temporary stake-level access request.'
      : 'Submit a manual or temporary access request for your ward.';

  // Managers reach this page before the wards live-query lands; show
  // the spinner until both buildings + (if needed) wards resolve so
  // the dropdown isn't briefly empty.
  const wardsNeeded = role === 'bishopric' && isManager;
  const wardsLoading = wardsNeeded && (wards.isLoading || wards.data === undefined);

  return (
    <section>
      <h1>{heading}</h1>
      <p className="kd-page-subtitle">{subtitle}</p>
      {buildings.isLoading || buildings.data === undefined || wardsLoading ? (
        <LoadingSpinner />
      ) : (
        <NewRequestForm scopes={scopes} buildings={buildings.data} />
      )}
    </section>
  );
}
