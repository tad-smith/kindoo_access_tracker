// Per-grant roster card. Renders a single grant view (primary OR a
// matched duplicate) — used by the Phase B broadened-inclusion roster
// pages where a seat appears under a scope its primary may not match
// (spec §15 Phase B). Same visual rhythm as `<RosterCardList>` so the
// pages stay consistent.
//
// The card is presentational. Callers compute the matched grant,
// pending-removal flag, edit / remove gates; we render.

import type { Building, Organization, Seat, KindooSite, Ward } from '@kindoo/shared';
import { Badge } from '../ui/Badge';
import type { GrantView } from '../../lib/grants';
import { siteLabelForGrant } from '../../lib/kindooSites';
import { EditSeatAffordance } from '../../features/requests/components/EditSeatAffordance';
import { RemovalAffordance } from '../../features/requests/components/RemovalAffordance';
import { OrganizationChip } from './OrganizationChip';
import { RosterMemberLine } from './RosterMemberLine';

/**
 * Organization-chip props. Opt-in: only the Stake Roster passes this
 * (the org concept is stake-scope), so ward / bishopric surfaces that
 * reuse this card render no chip. The caller resolves the grant's org id
 * (primary → `seat.organization_id`; duplicate → that duplicate's
 * `organization_id`) and the inline-edit gate.
 */
export interface RosterCardOrg {
  /** Live organizations catalogue (id→name + the menu). */
  orgs: readonly Organization[];
  /** Resolved org id for the rendered grant; `null` → "No Organization". */
  orgId: string | null;
  /** True iff the inline editor renders (stake access AND primary stake grant). */
  editable: boolean;
  /**
   * True once the org catalogue snapshot has landed. Until then the chip
   * stays read-only with a neutral placeholder — see `<OrganizationChip>`.
   */
  orgsReady: boolean;
}

export interface PerGrantRosterCardProps {
  seat: Seat;
  grant: GrantView;
  /** True iff `<EditSeatAffordance>` should render. */
  canEdit: boolean;
  /** True iff `<RemovalAffordance>` should render. */
  canRemove: boolean;
  /** True iff the matching grant has a pending remove request. */
  isPendingRemoval: boolean;
  /**
   * True iff this is a temp grant whose end date has passed (spec §7).
   * Marks the row and mutes it. When the caller has also withheld the
   * row's controls on that basis the card explains why, so their absence
   * reads as an answer rather than a missing affordance.
   */
  isExpired?: boolean;
  wards: readonly Ward[];
  buildings: readonly Building[];
  sites: readonly KindooSite[];
  /** Organization chip — Stake Roster only; omitted on other surfaces. */
  org?: RosterCardOrg;
}

export function PerGrantRosterCard({
  seat,
  grant,
  canEdit,
  canRemove,
  isPendingRemoval,
  isExpired = false,
  wards,
  buildings,
  sites,
  org,
}: PerGrantRosterCardProps) {
  const siteLabel = siteLabelForGrant(grant, wards, buildings, sites);

  const callingChip =
    grant.type === 'auto' && grant.callings.length > 0 ? (
      <span className="roster-card-chip">
        <span className="label">Calling:</span>
        <span className="roster-card-calling">{grant.callings.join(', ')}</span>
      </span>
    ) : (grant.type === 'manual' || grant.type === 'temp') && grant.reason ? (
      <span className="roster-card-chip">
        <span className="label">Reason:</span>
        <span className="roster-card-reason">{grant.reason}</span>
      </span>
    ) : null;

  const buildingsChip =
    grant.building_names.length > 0 ? (
      <span className="roster-card-chip">
        <span className="label">Buildings:</span>
        {grant.building_names.join(', ')}
      </span>
    ) : null;

  const datesLine =
    grant.type === 'temp' && (grant.start_date || grant.end_date) ? (
      <div className="roster-card-line2">
        <span className="roster-card-chip">
          <span className="label">Dates:</span>
          {grant.start_date ?? '?'} → {grant.end_date ?? '?'}
        </span>
      </div>
    ) : null;

  const callingLine = callingChip ? <div className="roster-card-line2">{callingChip}</div> : null;

  const buildingsLine = buildingsChip ? (
    <div className="roster-card-line2">{buildingsChip}</div>
  ) : null;

  // Only for the viewer who lost the row's controls to the expiry. A
  // manager keeps them, and telling them nothing needs doing beside
  // actions they can still take would contradict itself.
  //
  // Withheld again when a remove is already in flight: "no request
  // needed" beside a `Pending Removal` badge tells the requester their
  // own request was pointless, and that pairing is not an edge case —
  // it is exactly the population this feature exists for (removes filed
  // on temp seats near their end date, plus everything already queued at
  // rollout). The badge carries the state on its own; the request
  // resolves through the R-1 no-op path either way (spec §6).
  const expiredNote =
    isExpired && !canRemove && !isPendingRemoval ? (
      <div className="roster-card-line2 roster-card-expired-note">
        Access has already ended. The seat clears the next time a Kindoo Manager runs Sync — no
        request needed.
      </div>
    ) : null;

  return (
    <div
      className={`roster-card roster-card--two-line type-${grant.type}${isPendingRemoval ? ' has-removal-pending' : ''}${isExpired ? ' is-expired' : ''}`}
      data-seat-id={seat.member_canonical}
      data-grant-kind={grant.isPrimary ? 'primary' : 'duplicate'}
    >
      <div className="roster-card-line1">
        <span className="roster-card-badges">
          <Badge variant={grant.type}>{grant.type}</Badge>
          {isExpired ? (
            <Badge variant="expired" data-testid={`expired-badge-${seat.member_canonical}`}>
              Expired
            </Badge>
          ) : null}
          {isPendingRemoval ? (
            <Badge variant="danger" data-testid={`pending-removal-badge-${seat.member_canonical}`}>
              Pending Removal
            </Badge>
          ) : null}
          {grant.hasSameScopeDuplicates ? (
            <Badge
              variant="manual"
              data-testid={`grant-duplicate-badge-${seat.member_canonical}`}
              title="This user was manually granted access to additional buildings."
            >
              {grant.type === 'auto' ? 'edited' : 'duplicate'}
            </Badge>
          ) : null}
          {siteLabel ? (
            <Badge variant="info" data-testid={`kindoo-site-badge-${seat.member_canonical}`}>
              {siteLabel}
            </Badge>
          ) : null}
        </span>
        {org ? (
          <OrganizationChip
            orgs={org.orgs}
            orgId={org.orgId}
            editable={org.editable}
            orgsReady={org.orgsReady}
            memberCanonical={seat.member_canonical}
          />
        ) : null}
        {canEdit || canRemove ? (
          <span className="roster-card-actions" style={{ display: 'inline-flex', gap: 8 }}>
            {canEdit ? <EditSeatAffordance seat={seat} /> : null}
            {canRemove ? (
              <RemovalAffordance
                seat={seat}
                grant={{
                  scope: grant.scope,
                  type: grant.type,
                  kindoo_site_id: grant.kindoo_site_id,
                }}
              />
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="roster-card-member-line">
        <span className="roster-card-member">
          <RosterMemberLine name={seat.member_name} email={seat.member_email} />
        </span>
      </div>
      {callingLine}
      {buildingsLine}
      {datesLine}
      {expiredNote}
    </div>
  );
}
