// Platform Superadmin → Stake List page. Lists every stake parent doc
// readable by an `isPlatformSuperadmin === true` principal (gated
// server-side via the `stakes/{stakeId}` rule and client-side via the
// route's `useRequireRole('platformSuperadmin')`).
//
// Per spec §5.4: one row per stake with `stake_name`, doc-id slug,
// `created_at` (in the stake's own timezone), `setup_complete` pill,
// and a deep-link to that stake's normal landing page (the manager
// Dashboard while the active-stake selector is still single-stake;
// 12.4 turns the link into a stake-switch). The Create Stake form is
// rendered inline above the list.
//
// Stable order: ascending `created_at` (oldest first). At target scale
// — a handful of stakes platform-wide — no pagination is needed.

import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import type { Stake } from '@kindoo/shared';
import { LoadingSpinner } from '../../lib/render/LoadingSpinner';
import { EmptyState } from '../../lib/render/EmptyState';
import { formatDate } from '../../lib/render/formatDate';
import { CreateStakeForm } from './CreateStakeForm';
import { useStakes } from './hooks';

/**
 * Per-stake landing target. Deep-links into the manager Dashboard
 * with the target stake as `?stake=<slug>`. `useActiveStake()` on
 * the destination's first render reads the param, persists it to both
 * sessionStorage + localStorage, and strips it via `history.replaceState`
 * (spec §2.1). The role gate on `/manager/dashboard` redirects out to
 * the user's actual landing for that stake if they don't hold the
 * manager role there.
 */
function landingTargetFor(stake: Stake): { to: string; search: { stake: string } } {
  return { to: '/manager/dashboard', search: { stake: stake.stake_id } };
}

function timestampToMillis(value: Stake['created_at']): number {
  // `TimestampLike.toMillis()` is the canonical accessor. Firestore
  // Timestamps satisfy this; server-written docs always carry one.
  return typeof value?.toMillis === 'function' ? value.toMillis() : 0;
}

export function SuperadminStakeListPage() {
  const stakes = useStakes();

  const sorted = useMemo(() => {
    const rows = [...(stakes.data ?? [])];
    rows.sort((a, b) => timestampToMillis(a.created_at) - timestampToMillis(b.created_at));
    return rows;
  }, [stakes.data]);

  return (
    <section className="kd-page-medium" data-testid="superadmin-stake-list">
      <h1>Stake List</h1>
      <p className="kd-page-subtitle">Every stake on the platform.</p>

      <CreateStakeForm />

      {stakes.isLoading || stakes.data === undefined ? (
        <LoadingSpinner variant="block" />
      ) : sorted.length === 0 ? (
        <EmptyState message="No stakes provisioned yet." />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="superadmin-stake-list-items">
          {sorted.map((stake) => (
            <StakeRow key={stake.stake_id} stake={stake} />
          ))}
        </ul>
      )}
    </section>
  );
}

interface StakeRowProps {
  stake: Stake;
}

function StakeRow({ stake }: StakeRowProps) {
  // Render `created_at` in the stake's own timezone — every stake
  // carries its IANA tz on the parent doc.
  const created = formatDate(stake.created_at?.toDate?.() ?? null, stake.timezone);
  const setupComplete = stake.setup_complete === true;

  return (
    <li
      className="flex flex-col gap-2 rounded border border-gray-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between"
      data-testid={`superadmin-stake-row-${stake.stake_id}`}
    >
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <Link
            {...landingTargetFor(stake)}
            className="text-base font-semibold text-[color:var(--kd-primary)] hover:underline"
            data-testid={`superadmin-stake-link-${stake.stake_id}`}
          >
            {stake.stake_name}
          </Link>
          <span
            className="text-xs text-gray-500"
            data-testid={`superadmin-stake-slug-${stake.stake_id}`}
          >
            {stake.stake_id}
          </span>
        </div>
        <div className="text-xs text-gray-600">Created {created || '—'}</div>
      </div>
      <SetupPill complete={setupComplete} />
    </li>
  );
}

function SetupPill({ complete }: { complete: boolean }) {
  if (complete) {
    return (
      <span
        className="inline-flex items-center self-start rounded border border-kd-success-br bg-kd-success-tint px-2 py-0.5 text-xs font-medium text-kd-success-fg sm:self-auto"
        data-testid="superadmin-stake-setup-complete"
      >
        Setup complete
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center self-start rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 sm:self-auto"
      data-testid="superadmin-stake-setup-pending"
    >
      Setup pending
    </span>
  );
}
