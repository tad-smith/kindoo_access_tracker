// Per-grant roster card. Renders a single grant view (primary OR a
// matched duplicate) — used by the Phase B broadened-inclusion roster
// pages where a seat appears under a scope its primary may not match
// (spec §15 Phase B). Same visual rhythm as `<RosterCardList>` so the
// pages stay consistent.
//
// The card is presentational. Callers compute the matched grant,
// pending-removal flag, edit / remove gates; we render.

import type { Seat, KindooSite, Ward } from '@kindoo/shared';
import { Badge } from '../ui/Badge';
import type { GrantView } from '../../lib/grants';
import { siteLabelForGrant } from '../../lib/kindooSites';
import { EditSeatAffordance } from '../../features/requests/components/EditSeatAffordance';
import { RemovalAffordance } from '../../features/requests/components/RemovalAffordance';

export interface PerGrantRosterCardProps {
  seat: Seat;
  grant: GrantView;
  /** True iff `<EditSeatAffordance>` should render. */
  canEdit: boolean;
  /** True iff `<RemovalAffordance>` should render. */
  canRemove: boolean;
  /** True iff the matching grant has a pending remove request. */
  isPendingRemoval: boolean;
  wards: readonly Ward[];
  sites: readonly KindooSite[];
}

export function PerGrantRosterCard({
  seat,
  grant,
  canEdit,
  canRemove,
  isPendingRemoval,
  wards,
  sites,
}: PerGrantRosterCardProps) {
  const siteLabel = siteLabelForGrant(grant, wards, sites);

  const memberInner = seat.member_name ? (
    <>
      <span className="roster-card-name">{seat.member_name}</span>{' '}
      <span>
        (
        <span className="roster-email" title={seat.member_email}>
          {seat.member_email}
        </span>
        )
      </span>
    </>
  ) : (
    <span className="roster-email" title={seat.member_email}>
      {seat.member_email}
    </span>
  );

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

  const detailLine =
    callingChip || buildingsChip ? (
      <div className="roster-card-line2">
        {callingChip}
        {buildingsChip}
      </div>
    ) : null;

  return (
    <div
      className={`roster-card type-${grant.type}${isPendingRemoval ? ' has-removal-pending' : ''}`}
      data-seat-id={seat.member_canonical}
      data-grant-kind={grant.isPrimary ? 'primary' : 'duplicate'}
    >
      <div className="roster-card-line1">
        <span className="roster-card-badges">
          <Badge variant={grant.type}>{grant.type}</Badge>
          {isPendingRemoval ? (
            <Badge variant="danger" data-testid={`pending-removal-badge-${seat.member_canonical}`}>
              Pending Removal
            </Badge>
          ) : null}
          {siteLabel ? (
            <Badge variant="info" data-testid={`kindoo-site-badge-${seat.member_canonical}`}>
              {siteLabel}
            </Badge>
          ) : null}
        </span>
        <span className="roster-card-member">{memberInner}</span>
        {canEdit || canRemove ? (
          <span className="roster-card-actions" style={{ display: 'inline-flex', gap: 8 }}>
            {canEdit ? <EditSeatAffordance seat={seat} /> : null}
            {canRemove ? (
              <RemovalAffordance
                seat={seat}
                grant={{ scope: grant.scope, kindoo_site_id: grant.kindoo_site_id }}
              />
            ) : null}
          </span>
        ) : null}
      </div>
      {datesLine}
      {detailLine}
    </div>
  );
}
