// Single "New Request" page — one entry point for every role
// permitted to submit. The scope dropdown is filtered strictly by the
// roles the user holds in this stake; manager / superadmin status
// alone does not grant ward-scope creation rights (see `scopeOptions.ts`
// for the full rule table — the B-3 bug fix).
//
//   - Stake-claim member: 'stake'.
//   - Bishopric (per-ward): that ward.
//   - Stake + bishopric: 'stake' plus those wards (no others).
//   - No stake / no bishopric: empty scope list → form renders the
//     not-authorized message.
//
// The form body is role-agnostic; it auto-collapses to a "Requesting
// for: <scope>" line when only one scope is offered, and renders a
// dropdown otherwise. See `NewRequestForm`.
//
// Mounts at `/new`. The legacy `/bishopric/new` and `/stake/new`
// paths route here via TanStack-Router redirects so external links
// keep working.

import { useMemo } from 'react';
import { usePrincipal } from '../../../lib/principal';
import { useActiveStake } from '../../../lib/useActiveStake';
import { useFirestoreCollection } from '../../../lib/data';
import { buildingsCol, wardsCol } from '../../../lib/docs';
import { db } from '../../../lib/firebase';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import type { Building, Ward } from '@kindoo/shared';
import { NewRequestForm } from '../components/NewRequestForm';
import { allowedScopesFor } from '../scopeOptions';

export function NewRequestPage() {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();

  // Buildings catalogue (for stake-scope checkbox group). The form
  // needs it whenever 'stake' is one of the available scopes; cheap
  // no-op subscription otherwise.
  const buildingsQuery = useMemo(
    () => (activeStakeId ? buildingsCol(db, activeStakeId) : null),
    [activeStakeId],
  );
  const buildings = useFirestoreCollection<Building>(buildingsQuery);

  // Wards catalogue. Used by the form to auto-populate building_names
  // for ward-scope requests from each ward's `building_name`.
  const wardsQuery = useMemo(
    () => (activeStakeId ? wardsCol(db, activeStakeId) : null),
    [activeStakeId],
  );
  const wards = useFirestoreCollection<Ward>(wardsQuery);

  const scopes = useMemo(
    () => (activeStakeId ? allowedScopesFor(principal, activeStakeId, wards.data ?? []) : []),
    [principal, activeStakeId, wards.data],
  );

  return (
    <section className="kd-page-narrow">
      <h1>New Request</h1>
      <p className="kd-page-subtitle">Submit a manual or temporary access request.</p>
      {buildings.isLoading || buildings.data === undefined ? (
        <LoadingSpinner />
      ) : (
        <NewRequestForm scopes={scopes} buildings={buildings.data} wards={wards.data ?? []} />
      )}
    </section>
  );
}
