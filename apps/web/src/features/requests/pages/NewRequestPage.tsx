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
import { STAKE_ID } from '../../../lib/constants';
import { useFirestoreCollection } from '../../../lib/data';
import { buildingsCol, wardsCol } from '../../../lib/docs';
import { db } from '../../../lib/firebase';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import type { Building, Ward } from '@kindoo/shared';
import { NewRequestForm } from '../components/NewRequestForm';
import { allowedScopesFor } from '../scopeOptions';

export function NewRequestPage() {
  const principal = usePrincipal();

  // Buildings catalogue (for stake-scope checkbox group). The form
  // needs it whenever 'stake' is one of the available scopes; cheap
  // no-op subscription otherwise.
  const buildingsQuery = useMemo(() => buildingsCol(db, STAKE_ID), []);
  const buildings = useFirestoreCollection<Building>(buildingsQuery);

  // Wards catalogue. Used by the form to auto-populate building_names
  // for ward-scope requests from each ward's `building_name`.
  const wardsQuery = useMemo(() => wardsCol(db, STAKE_ID), []);
  const wards = useFirestoreCollection<Ward>(wardsQuery);

  const scopes = useMemo(() => allowedScopesFor(principal, STAKE_ID), [principal]);

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
