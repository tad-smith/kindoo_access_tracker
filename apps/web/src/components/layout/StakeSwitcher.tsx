// Stake-switcher dropdown. Renders immediately to the RIGHT of the
// brand-bar stake name (`Shell.tsx` `.kd-brandbar-stake-slot`, inside
// `.kd-brandbar-brand`) when the principal's menu source (claim-derived
// accessible stakes plus any bootstrap-only stakes discovery has found)
// has ≥ 2 entries (spec §2.1). Hidden entirely otherwise. The trigger is
// a chevron-only affordance — the adjacent stake name already shows
// WHICH stake the user is on, so the trigger doesn't duplicate the
// label; the chevron is the "switch" affordance. The menu is
// start-aligned so it opens rightward from the trigger, away from the
// name it trails.
//
// Click on an option persists the chosen stake to both sessionStorage
// and localStorage and invalidates per-stake TanStack Query caches so
// downstream subscriptions refetch against the newly-selected stake.
//
// Each menu item is labelled with the stake's `stake_name` (read live
// from `stakes/{stakeId}`); the doc-id slug appears as a smaller
// caption so a stake-name collision still distinguishes itself.
// Bootstrap-only entries (the principal has no claim-derived role on
// the stake — they're only its designated not-yet-setup bootstrap
// admin) carry a "Setup needed" badge so a manager of stake A who's
// also the bootstrap admin of stake B can find and switch into B's
// wizard.

import { ChevronDown, Check } from 'lucide-react';
import { useMemo } from 'react';
import type { Stake } from '@kindoo/shared';
import { useFirestoreDoc } from '../../lib/data';
import { db } from '../../lib/firebase';
import { stakeRef } from '../../lib/docs';
import { useAccessibleStakesWithBootstrap, useActiveStakeSwitcher } from '../../lib/useActiveStake';
import { cn } from '../../lib/cn';
import { Badge } from '../ui/Badge';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Popover';

interface StakeSwitcherProps {
  /**
   * The currently-active stake ID. Pass `null` when no active stake is
   * resolved (zero-role superadmin) — the component returns `null` in
   * that case too.
   */
  activeStakeId: string | null;
}

export function StakeSwitcher({ activeStakeId }: StakeSwitcherProps) {
  const entries = useAccessibleStakesWithBootstrap();
  const switchStake = useActiveStakeSwitcher();

  // Hidden when the menu source has < 2 entries.
  if (entries.length < 2) return null;
  if (activeStakeId === null) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center justify-center rounded border border-kd-border bg-white p-1 text-gray-700 shadow-sm hover:bg-gray-50',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--kd-primary)]',
          )}
          aria-label="Switch active stake"
          data-testid="stake-switcher-trigger"
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="min-w-[12rem] p-1"
        data-testid="stake-switcher-menu"
      >
        <ul className="flex flex-col">
          {entries.map(({ stakeId, needsSetup }) => (
            <StakeSwitcherItem
              key={stakeId}
              stakeId={stakeId}
              isActive={stakeId === activeStakeId}
              needsSetup={needsSetup}
              onSelect={() => switchStake(stakeId)}
            />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

interface StakeSwitcherItemProps {
  stakeId: string;
  isActive: boolean;
  needsSetup: boolean;
  onSelect: () => void;
}

function StakeSwitcherItem({ stakeId, isActive, needsSetup, onSelect }: StakeSwitcherItemProps) {
  const ref = useMemo(() => stakeRef(db, stakeId), [stakeId]);
  const doc = useFirestoreDoc<Stake>(ref);
  const stakeName = doc.data?.stake_name ?? stakeId;

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-gray-100',
          isActive && 'font-semibold',
        )}
        data-testid={`stake-switcher-item-${stakeId}`}
        data-active={isActive ? 'true' : 'false'}
      >
        <span className="flex flex-col">
          <span className="flex items-center gap-1.5">
            {stakeName}
            {needsSetup ? (
              <Badge variant="warning" data-testid={`stake-switcher-setup-badge-${stakeId}`}>
                Setup needed
              </Badge>
            ) : null}
          </span>
          {stakeName !== stakeId ? <span className="text-xs text-gray-500">{stakeId}</span> : null}
        </span>
        {isActive ? <Check size={14} aria-hidden="true" /> : null}
      </button>
    </li>
  );
}
