// Per-role wrapper around the shared `NewRequestForm`. Resolves the
// principal's allowed-scope list (stake / per-bishopric-ward), seeds
// the form's scope set, and live-loads the buildings catalogue for
// the stake-scope checkbox group.
//
// Two routes mount this page: `/bishopric/new` and `/stake/new`. Each
// passes a `role` prop that constrains which scopes are offered:
//   - bishopric → only the principal's bishopric wards
//   - stake     → only the stake scope
// The shared form renders a dropdown only when ≥2 scopes are
// available. Multi-role principals reach the right scope set via the
// nav-link's per-role route — they see the bishopric wards on
// `/bishopric/new` and the stake scope on `/stake/new`. Picking is
// fixed via the route, not via the form.

import { useMemo } from 'react';
import { usePrincipal } from '../../../lib/principal';
import { STAKE_ID } from '../../../lib/constants';
import { useFirestoreCollection } from '../../../lib/data';
import { buildingsCol } from '../../../lib/docs';
import { db } from '../../../lib/firebase';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import type { Building } from '@kindoo/shared';
import { NewRequestForm, type ScopeOption } from '../components/NewRequestForm';

type Role = 'bishopric' | 'stake';

export interface NewRequestPageProps {
  role: Role;
}

export function NewRequestPage({ role }: NewRequestPageProps) {
  const principal = usePrincipal();
  const scopes = useMemo<ScopeOption[]>(() => {
    if (role === 'stake') {
      if (principal.stakeMemberStakes.includes(STAKE_ID)) {
        return [{ value: 'stake', label: 'Stake' }];
      }
      return [];
    }
    const wards = principal.bishopricWards[STAKE_ID] ?? [];
    return wards.map((w) => ({ value: w, label: `Ward ${w}` }));
  }, [role, principal.stakeMemberStakes, principal.bishopricWards]);

  const buildingsQuery = useMemo(() => buildingsCol(db, STAKE_ID), []);
  const buildings = useFirestoreCollection<Building>(buildingsQuery);

  const heading = role === 'stake' ? 'New Stake Request' : 'New Kindoo Request';
  const subtitle =
    role === 'stake'
      ? 'Submit a manual or temporary stake-level access request.'
      : 'Submit a manual or temporary access request for your ward.';

  return (
    <section>
      <h1>{heading}</h1>
      <p className="kd-page-subtitle">{subtitle}</p>
      {buildings.isLoading || buildings.data === undefined ? (
        <LoadingSpinner />
      ) : (
        <NewRequestForm scopes={scopes} buildings={buildings.data} />
      )}
    </section>
  );
}
