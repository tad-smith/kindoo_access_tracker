// Single "New Request" page — one entry point for every role
// permitted to submit. Resolves the principal's allowed scopes and
// hands the shared `<NewRequestForm>` an ordered scope list:
//
//   - Manager (or platform superadmin): stake + every configured ward.
//   - Stake-claim member: stake.
//   - Bishopric (per-ward): the user's bishopric wards.
//   - Mixed (e.g., stake + bishopric): the union, deduplicated.
//
// The form body itself is role-agnostic; it auto-collapses to a
// "Requesting for: <scope>" line when only one scope is offered, and
// renders a dropdown otherwise. See `NewRequestForm`.
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
import { NewRequestForm, type ScopeOption } from '../components/NewRequestForm';

export function NewRequestPage() {
  const principal = usePrincipal();
  const isManager = principal.isPlatformSuperadmin || principal.managerStakes.includes(STAKE_ID);
  const isStake = principal.stakeMemberStakes.includes(STAKE_ID);
  const bishopricWards = principal.bishopricWards[STAKE_ID] ?? [];
  const hasBishopric = bishopricWards.length > 0;

  // Buildings catalogue (for stake-scope checkbox group). The form
  // needs it whether or not stake-scope is the chosen scope, because
  // the user can switch the dropdown.
  const buildingsQuery = useMemo(() => buildingsCol(db, STAKE_ID), []);
  const buildings = useFirestoreCollection<Building>(buildingsQuery);

  // Wards catalogue. Loaded for managers (their scope list spans
  // every configured ward); cheap no-op for users whose scope list
  // is purely claims-derived.
  const wardsQuery = useMemo(() => wardsCol(db, STAKE_ID), []);
  const wards = useFirestoreCollection<Ward>(wardsQuery);

  const scopes = useMemo<ScopeOption[]>(() => {
    const out: ScopeOption[] = [];
    const seen = new Set<string>();
    const push = (value: string, label: string) => {
      if (seen.has(value)) return;
      seen.add(value);
      out.push({ value, label });
    };

    if (isManager || isStake) {
      push('stake', 'Stake');
    }
    if (isManager) {
      // Every configured ward — sorted by ward_code.
      const allWards = [...(wards.data ?? [])]
        .map((w) => w.ward_code)
        .sort((a, b) => a.localeCompare(b));
      for (const code of allWards) {
        push(code, `Ward ${code}`);
      }
    } else if (hasBishopric) {
      // Bishopric-only (no manager): restrict to claimed wards.
      const sorted = [...bishopricWards].sort((a, b) => a.localeCompare(b));
      for (const code of sorted) {
        push(code, `Ward ${code}`);
      }
    }
    return out;
  }, [isManager, isStake, hasBishopric, bishopricWards, wards.data]);

  // Managers need the wards catalogue resolved before the dropdown
  // can render its full set; show the spinner until it lands.
  const wardsLoading = isManager && (wards.isLoading || wards.data === undefined);

  return (
    <section className="kd-page-narrow">
      <h1>New Request</h1>
      <p className="kd-page-subtitle">Submit a manual or temporary access request.</p>
      {buildings.isLoading || buildings.data === undefined || wardsLoading ? (
        <LoadingSpinner />
      ) : (
        <NewRequestForm scopes={scopes} buildings={buildings.data} />
      )}
    </section>
  );
}
