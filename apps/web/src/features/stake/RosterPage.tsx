// Stake Presidency Roster page (live). Scope is `'stake'` — broadened
// in Phase B (spec §15) to include any seat whose primary scope OR any
// `duplicate_grants[]` entry's scope matches `'stake'`. Single row per
// person; columns reflect the matched grant.
//
// Rules: `seats.read` allows stake-presidency reads unrestricted via
// `isStakeMember(stakeId)` (no scope predicate), so no rule change
// is needed for this surface — the broadened reads were already
// allowed by today's rules. The bishopric clause widening (Phase B
// AC #10) handles the bishopric surface.

import { useMemo } from 'react';
import type { Seat } from '@kindoo/shared';
import { useFirestoreDoc } from '../../lib/data';
import { stakeRef } from '../../lib/docs';
import { db } from '../../lib/firebase';
import { useActiveStake } from '../../lib/useActiveStake';
import { usePrincipal } from '../../lib/principal';
import { useKindooSites, useStakeBuildings, useStakeRoster, useStakeWards } from './hooks';
import { sortOrganizations, useOrganizations } from '../organizations/hooks';
import { resolveGrantOrgId } from '../../lib/grants';
import { sortSeatsWithinScope } from '../../lib/sort/seats';
import { RosterUtilization } from '../../lib/render/RosterUtilization';
import { stakeAvailablePoolSize } from '../../lib/render/stakePool';
import { LoadingSpinner } from '../../lib/render/LoadingSpinner';
import { EmptyState } from '../../lib/render/EmptyState';
import { PerGrantRosterCard } from '../../components/roster/PerGrantRosterCard';
import { PendingAddRequestsSection } from '../requests/components/PendingAddRequestsSection';
import { NewRequestAffordance } from '../requests/components/NewRequestAffordance';
import { usePendingRequestsForScope } from '../requests/hooks';
import { partitionPendingForRoster, pendingRemoveKey } from '../requests/rosterPending';
import { canEditSeat, isScopeAllowed } from '../requests/scopeOptions';
import { pickGrantForScope, type GrantView } from '../../lib/grants';

export function StakeRosterPage() {
  const principal = usePrincipal();
  const activeStakeId = useActiveStake();
  const seats = useStakeRoster();
  const wards = useStakeWards();
  const buildings = useStakeBuildings();
  // Live subscription for the stake doc — `useFirestoreOnce` was
  // empty in production for this page; live keeps the cap fresh.
  const stakeDocResult = useFirestoreDoc(activeStakeId ? stakeRef(db, activeStakeId) : null);
  const stakeDoc = stakeDocResult.data;
  const kindooSites = useKindooSites();
  const organizations = useOrganizations();

  // Stake app access gates the inline org-edit affordance (defense/UX —
  // the page is already stake-member-gated; this mirrors the rule's
  // `request.auth.token.stakes[sid].stake === true` check).
  const hasStakeAccess =
    activeStakeId !== null && principal.stakeMemberStakes.includes(activeStakeId);

  // Pair every seat with the grant that matched the stake scope.
  const seatsWithGrant = useMemo(() => {
    const rows: Array<{ seat: Seat; grant: GrantView }> = [];
    for (const s of seats.data ?? []) {
      const grant = pickGrantForScope(s, 'stake');
      if (grant) rows.push({ seat: s, grant });
    }
    return rows;
  }, [seats.data]);

  // Sort by the matched grant's fields. The intra-band calling-order
  // sort keys on the seat's `callings` (auto) / `reason` (manual); the
  // shim doesn't override those, so a duplicate-matched row sorts at
  // the primary's calling rank. See spec §15 Phase B (roster-pages
  // subsection) for the operator-accepted limitation.
  const sortedRows = useMemo(() => {
    const shims = seatsWithGrant.map(({ seat, grant }) => ({
      ...seat,
      type: grant.type,
      ...(grant.start_date !== undefined ? { start_date: grant.start_date } : {}),
      ...(grant.end_date !== undefined ? { end_date: grant.end_date } : {}),
    }));
    const sorted = sortSeatsWithinScope(shims);
    const byCanonical = new Map(seatsWithGrant.map((r) => [r.seat.member_canonical, r]));
    return sorted
      .map((s) => byCanonical.get(s.member_canonical))
      .filter((r): r is { seat: Seat; grant: GrantView } => r !== undefined);
  }, [seatsWithGrant]);

  const seatCount = sortedRows.length;

  // Committed per-organization counts, keyed on each row's resolved
  // stake-grant `organization_id`. `null` (No Organization) is tracked
  // too but not surfaced as a bar. Committed-only — pending adds/removes
  // are NOT split per org (locked design).
  const orgCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { seat, grant } of sortedRows) {
      const orgId = resolveGrantOrgId(seat, grant);
      if (orgId == null) continue;
      counts.set(orgId, (counts.get(orgId) ?? 0) + 1);
    }
    return counts;
  }, [sortedRows]);

  // Pending requests for the stake scope.
  const pendingRequests = usePendingRequestsForScope('stake');
  const { pendingAdds, pendingRemovesByKey } = useMemo(
    () => partitionPendingForRoster(pendingRequests.data ?? [], 'stake'),
    [pendingRequests.data],
  );
  const cap = stakeAvailablePoolSize(
    stakeDoc?.stake_seat_cap,
    wards.data ?? [],
    buildings.data ?? [],
  );

  // One committed bar per organization (alpha-sorted). Orgs with zero
  // matching seats still render a bar (`total` falls back to 0). Cap is
  // display-only; the bar's ratio drives ok / warn / over.
  const orgRows = useMemo(
    () =>
      sortOrganizations(organizations.data).map((org) => ({
        name: org.name,
        total: orgCounts.get(org.organization_id) ?? 0,
        cap: org.seat_cap,
      })),
    [organizations.data, orgCounts],
  );

  // The header "New Request" affordance shows only for principals with
  // stake-scope request authority — the same predicate that gates the
  // 'stake' option in the New Request dropdown. Manager-only users (who
  // can land here but can't ADD to the stake scope) don't see it.
  const canRequest = activeStakeId !== null && isScopeAllowed(principal, activeStakeId, 'stake');

  return (
    <section>
      <div className="kd-page-title-row">
        <h1>Stake Roster</h1>
        {canRequest ? (
          <NewRequestAffordance scope="stake" testId="stake-roster-new-request" />
        ) : null}
      </div>

      <div className="kd-utilization-host">
        <RosterUtilization
          committedTotal={seatCount}
          cap={cap}
          pendingAdds={pendingAdds.length}
          pendingRemoves={pendingRemovesByKey.size}
          committedOverCap={typeof cap === 'number' && cap > 0 && seatCount > cap}
          orgRows={orgRows}
        />
      </div>

      {seats.isLoading || seats.data === undefined ? (
        <LoadingSpinner />
      ) : (
        <>
          {sortedRows.length === 0 ? (
            <EmptyState message="No stake seats yet. The next import seeds auto-seats from the LCR Stake tab; manual additions land via the New Kindoo Request page." />
          ) : (
            <div className="roster-cards">
              {sortedRows.map(({ seat, grant }) => {
                const canEdit =
                  activeStakeId !== null &&
                  grant.isPrimary &&
                  canEditSeat(principal, activeStakeId, seat);
                const canRemove =
                  activeStakeId !== null &&
                  grant.type !== 'auto' &&
                  isScopeAllowed(principal, activeStakeId, grant.scope);
                const isPendingRemoval = pendingRemovesByKey.has(
                  pendingRemoveKey(seat.member_canonical, grant.scope, grant.kindoo_site_id),
                );
                return (
                  <PerGrantRosterCard
                    key={seat.member_canonical}
                    seat={seat}
                    grant={grant}
                    canEdit={canEdit}
                    canRemove={canRemove}
                    isPendingRemoval={isPendingRemoval}
                    wards={wards.data ?? []}
                    buildings={buildings.data ?? []}
                    sites={kindooSites.data ?? []}
                    org={{
                      orgs: organizations.data ?? [],
                      orgId: resolveGrantOrgId(seat, grant),
                      // Editable only on the primary stake grant; a
                      // duplicate stake grant's org is set via the
                      // request form, so render it read-only.
                      editable: hasStakeAccess && grant.isPrimary,
                    }}
                  />
                );
              })}
            </div>
          )}
          <PendingAddRequestsSection pendingAdds={pendingAdds} />
        </>
      )}
    </section>
  );
}
