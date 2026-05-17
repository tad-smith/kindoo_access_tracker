// Manager Dashboard page (live). Five live cards:
//   - Pending Requests (per-type counts; deep-links to /manager/queue)
//   - Utilization (per-ward + stake bars)
//   - Warnings (over-cap pools from stake.last_over_caps_json)
//   - Recent Activity (last 10 audit rows; deep-links to audit log
//     filtered by entity_id)
//   - Last Operations (last_import_at / last_expiry_at)
//
// Each card subscribes via its own `useFirestoreCollection` so the
// dashboard is fully reactive — pending counts tick up live as a
// bishopric submits, utilization bars patch as the importer runs,
// audit rows stream in real time.

import { Link } from '@tanstack/react-router';
import { isAutomatedActor } from '@kindoo/shared';
import type { AccessRequest, AuditLog, OverCapEntry, Seat, Stake, Ward } from '@kindoo/shared';
import {
  usePendingRequests,
  useRecentAuditLog,
  useStakeDoc,
  useStakeSeats,
  useStakeWards,
} from './hooks';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/Card';
import { Skeleton } from '../../../components/ui/Skeleton';
import { UtilizationBar } from '../../../lib/render/UtilizationBar';
import { stakeAvailablePoolSize } from '../../../lib/render/stakePool';
import { summariseAuditRow } from '../auditLog/summarise';

/**
 * Phase B (spec §15 AC #5): a seat counts on a scope's bar when its
 * primary scope matches OR any `duplicate_grants[]` entry's scope
 * matches. Same-scope within-site duplicates collapse — count one
 * per `member_canonical` per scope, not one per grant.
 *
 * INTENTIONAL DIVERGENCE: this widens via `duplicate_grants` for
 * visibility, but the server-side over-cap calc
 * (`functions/src/lib/overCaps.ts`) intentionally stays primary-only —
 * over-cap warnings represent actual home-stake Kindoo-license-pool
 * consumption, which the primary represents. A bar can render "over"
 * visually without firing `over_cap_warning`. If you change one side,
 * change the other or document why they should continue to diverge.
 * Spec §15 Phase B.
 */
function countSeatsForScope(seats: readonly Seat[], scope: string): number {
  let n = 0;
  for (const s of seats) {
    if (s.scope === scope) {
      n += 1;
      continue;
    }
    const dupes = s.duplicate_grants ?? [];
    if (dupes.some((d) => d.scope === scope)) n += 1;
  }
  return n;
}

export function ManagerDashboardPage() {
  const pending = usePendingRequests();
  const audit = useRecentAuditLog();
  const seats = useStakeSeats();
  const wards = useStakeWards();
  const stake = useStakeDoc();

  return (
    <section>
      <h1>Dashboard</h1>
      <p className="kd-page-subtitle">
        Manager landing. Click any card&apos;s content to jump to the relevant page.
      </p>

      <div className="kd-dashboard-grid" data-testid="dashboard-grid">
        <PendingCard
          loading={pending.isLoading || pending.data === undefined}
          requests={pending.data ?? []}
        />
        <UtilizationCard
          loading={seats.isLoading || wards.isLoading || stake.isLoading}
          seats={seats.data ?? []}
          wards={wards.data ?? []}
          stakeSeatCap={stake.data?.stake_seat_cap}
        />
        <WarningsCard loading={stake.isLoading} overCaps={stake.data?.last_over_caps_json ?? []} />
        <RecentActivityCard
          loading={audit.isLoading || audit.data === undefined}
          rows={audit.data ?? []}
        />
        <LastOpsCard loading={stake.isLoading} stake={stake.data} />
      </div>
    </section>
  );
}

interface PendingCardProps {
  loading: boolean;
  requests: readonly AccessRequest[];
}

function PendingCard({ loading, requests }: PendingCardProps) {
  if (loading) {
    return (
      <Card data-testid="dashboard-card-pending">
        <CardHeader>
          <CardTitle>Pending Requests</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-6 w-24" />
        </CardContent>
      </Card>
    );
  }
  const total = requests.length;
  if (total === 0) {
    return (
      <Card data-testid="dashboard-card-pending">
        <CardHeader>
          <CardTitle>Pending Requests</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="kd-dashboard-card-empty">No pending requests. Queue is empty. Nice.</p>
        </CardContent>
      </Card>
    );
  }
  const byType: Record<string, number> = {};
  for (const r of requests) byType[r.type] = (byType[r.type] ?? 0) + 1;
  const order: Array<AccessRequest['type']> = ['add_manual', 'add_temp', 'remove'];
  return (
    <Card data-testid="dashboard-card-pending">
      <CardHeader>
        <CardTitle>Pending Requests</CardTitle>
      </CardHeader>
      <CardContent>
        <Link to="/manager/queue" className="kd-dashboard-link">
          <div className="kd-dashboard-card-total">{total}</div>
          <ul className="kd-dashboard-list">
            {order
              .filter((t) => byType[t])
              .map((t) => (
                <li key={t}>
                  <span>{t}</span>
                  <strong>{byType[t]}</strong>
                </li>
              ))}
          </ul>
        </Link>
      </CardContent>
    </Card>
  );
}

interface UtilizationCardProps {
  loading: boolean;
  seats: readonly Seat[];
  wards: readonly Ward[];
  stakeSeatCap: number | undefined;
}

function UtilizationCard({ loading, seats, wards, stakeSeatCap }: UtilizationCardProps) {
  if (loading) {
    return (
      <Card data-testid="dashboard-card-utilization">
        <CardHeader>
          <CardTitle>Utilization</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="mb-2 h-4" />
          <Skeleton className="mb-2 h-4" />
          <Skeleton className="h-4" />
        </CardContent>
      </Card>
    );
  }
  // Per-scope counts. Phase B (spec §15 AC #5): widen inclusion so a
  // seat with primary `scope='stake'` and a `duplicate_grants[]`
  // entry for ward 'CO' counts on the CO bar too. Count once per
  // distinct `(member_canonical, scope)` pair across the seat's
  // grants so a within-site same-scope duplicate doesn't
  // double-count on the same bar.
  //
  // Intentional behaviour change vs pre-Phase B: wardCounts is now
  // driven off the wards catalogue (one entry per known ward), not
  // off the seat scopes. Orphan-scope seats (`seat.scope` pointing
  // at a ward that no longer exists — a misconfiguration / mid-
  // rename state) used to surface their own dashboard row; they
  // now drop silently. Operator-accepted: an orphan-scope seat is
  // an upstream-data problem the Manager Audit Log + AllSeats page
  // surface; the Dashboard's per-ward bars stay aligned with the
  // ward catalogue.
  const stakeCount = countSeatsForScope(seats, 'stake');
  const wardCounts = new Map<string, number>();
  for (const w of wards) {
    if (w.ward_code === 'stake') continue;
    wardCounts.set(w.ward_code, countSeatsForScope(seats, w.ward_code));
  }
  const sortedWards = [...wards].sort((a, b) => a.ward_code.localeCompare(b.ward_code));

  // Stake pool denominator nets out wards' pre-allocated reservations.
  const stakePoolCap = stakeAvailablePoolSize(stakeSeatCap, wards);

  return (
    <Card data-testid="dashboard-card-utilization">
      <CardHeader>
        <CardTitle>Utilization</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="kd-dashboard-list" style={{ gap: '10px' }}>
          <li style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
            <Link to="/manager/seats" search={{ ward: 'stake' }} className="kd-dashboard-link">
              Stake
            </Link>
            <UtilizationBar
              total={stakeCount}
              cap={stakePoolCap}
              overCap={
                typeof stakePoolCap === 'number' && stakePoolCap > 0 && stakeCount > stakePoolCap
              }
            />
          </li>
          {sortedWards.map((w) => {
            const count = wardCounts.get(w.ward_code) ?? 0;
            return (
              <li
                key={w.ward_code}
                style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}
              >
                <Link
                  to="/manager/seats"
                  search={{ ward: w.ward_code }}
                  className="kd-dashboard-link"
                >
                  {w.ward_name} ({w.ward_code})
                </Link>
                <UtilizationBar total={count} cap={w.seat_cap} overCap={count > w.seat_cap} />
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

interface WarningsCardProps {
  loading: boolean;
  overCaps: readonly OverCapEntry[];
}

function WarningsCard({ loading, overCaps }: WarningsCardProps) {
  if (loading) {
    return (
      <Card data-testid="dashboard-card-warnings">
        <CardHeader>
          <CardTitle>Warnings</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-4" />
        </CardContent>
      </Card>
    );
  }
  if (overCaps.length === 0) {
    return (
      <Card data-testid="dashboard-card-warnings">
        <CardHeader>
          <CardTitle>Warnings</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="kd-dashboard-card-empty">No warnings. All pools within cap.</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card data-testid="dashboard-card-warnings">
      <CardHeader>
        <CardTitle>Warnings</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="kd-dashboard-list">
          {overCaps.map((p) => (
            <li key={p.pool}>
              <span>
                <strong>{p.pool === 'stake' ? 'Stake' : `Ward ${p.pool}`}</strong>: {p.count} /{' '}
                {p.cap} (over by {p.over_by})
              </span>
              <Link to="/manager/seats" search={{ ward: p.pool }}>
                view
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

interface RecentActivityCardProps {
  loading: boolean;
  rows: readonly AuditLog[];
}

function RecentActivityCard({ loading, rows }: RecentActivityCardProps) {
  if (loading) {
    return (
      <Card data-testid="dashboard-card-recent">
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="mb-2 h-4" />
          <Skeleton className="mb-2 h-4" />
          <Skeleton className="h-4" />
        </CardContent>
      </Card>
    );
  }
  if (rows.length === 0) {
    return (
      <Card data-testid="dashboard-card-recent">
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="kd-dashboard-card-empty">No recent activity.</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card data-testid="dashboard-card-recent">
      <CardHeader>
        <CardTitle>Recent Activity</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="kd-dashboard-list">
          {rows.map((r) => {
            const isAutomated = isAutomatedActor(r.actor_email);
            return (
              <li key={r.audit_id} style={{ flexWrap: 'wrap' }}>
                <Link to="/manager/audit" search={{ entity_id: r.entity_id }} style={{ flex: 1 }}>
                  <span
                    className={
                      isAutomated ? 'kd-audit-card-actor actor-automated' : 'kd-audit-card-actor'
                    }
                  >
                    {r.actor_email}
                  </span>{' '}
                  {summariseAuditRow(r)}
                </Link>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

interface LastOpsCardProps {
  loading: boolean;
  stake: Stake | undefined;
}

function LastOpsCard({ loading, stake }: LastOpsCardProps) {
  if (loading) {
    return (
      <Card data-testid="dashboard-card-ops">
        <CardHeader>
          <CardTitle>Last Operations</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-4" />
        </CardContent>
      </Card>
    );
  }
  const fmt = (ts: { toDate?: () => Date } | undefined) => {
    if (!ts || !ts.toDate) return 'never';
    return ts.toDate().toISOString().replace('T', ' ').slice(0, 16);
  };
  return (
    <Card data-testid="dashboard-card-ops">
      <CardHeader>
        <CardTitle>Last Operations</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="kd-dashboard-list">
          <li>
            <span>Last import</span>
            <span>{fmt(stake?.last_import_at)}</span>
          </li>
          <li>
            <span>Last expiry</span>
            <span>{fmt(stake?.last_expiry_at)}</span>
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}
