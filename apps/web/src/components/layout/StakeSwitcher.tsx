// Stake-switcher dropdown. Renders next to the current stake name in
// the brand bar when the principal has any role on ≥ 2 stakes (spec
// §2.1). Hidden entirely otherwise.
//
// Click on an option persists the chosen stake to both sessionStorage
// and localStorage and invalidates per-stake TanStack Query caches so
// downstream subscriptions refetch against the newly-selected stake.
//
// Each menu item is labelled with the stake's `stake_name` (read live
// from `stakes/{stakeId}`); the doc-id slug appears as a smaller
// caption so a stake-name collision still distinguishes itself.

import { ChevronDown, Check } from 'lucide-react';
import { useMemo } from 'react';
import type { Stake } from '@kindoo/shared';
import { useFirestoreDoc } from '../../lib/data';
import { db } from '../../lib/firebase';
import { stakeRef } from '../../lib/docs';
import { useAccessibleStakes, useActiveStakeSwitcher } from '../../lib/useActiveStake';
import { cn } from '../../lib/cn';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Popover';

interface StakeSwitcherProps {
  /**
   * The currently-active stake ID; the trigger renders its display
   * name. Pass `null` when no active stake is resolved (zero-role
   * superadmin) — the component returns `null` in that case too.
   */
  activeStakeId: string | null;
}

export function StakeSwitcher({ activeStakeId }: StakeSwitcherProps) {
  const accessible = useAccessibleStakes();
  const switchStake = useActiveStakeSwitcher();
  // Read the active stake's display name so the trigger labels itself
  // with WHICH stake the user is currently on — matching the brand-bar
  // pattern from Shell. The dropdown reveals the alternatives.
  const activeStakeRef = useMemo(
    () => (activeStakeId !== null ? stakeRef(db, activeStakeId) : null),
    [activeStakeId],
  );
  const activeStakeDoc = useFirestoreDoc<Stake>(activeStakeRef);
  const activeStakeName = activeStakeDoc.data?.stake_name ?? activeStakeId;

  // Hidden when the user has < 2 accessible stakes.
  if (accessible.length < 2) return null;
  if (activeStakeId === null) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 rounded border border-kd-border bg-white px-2 py-1 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--kd-primary)]',
          )}
          aria-label="Switch active stake"
          data-testid="stake-switcher-trigger"
        >
          <span data-testid="stake-switcher-current">{activeStakeName}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="min-w-[12rem] p-1"
        data-testid="stake-switcher-menu"
      >
        <ul className="flex flex-col">
          {accessible.map((stakeId) => (
            <StakeSwitcherItem
              key={stakeId}
              stakeId={stakeId}
              isActive={stakeId === activeStakeId}
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
  onSelect: () => void;
}

function StakeSwitcherItem({ stakeId, isActive, onSelect }: StakeSwitcherItemProps) {
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
          <span>{stakeName}</span>
          {stakeName !== stakeId ? <span className="text-xs text-gray-500">{stakeId}</span> : null}
        </span>
        {isActive ? <Check size={14} aria-hidden="true" /> : null}
      </button>
    </li>
  );
}
