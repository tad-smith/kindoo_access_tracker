// Component tests for the StakeSwitcher dropdown.
//   - Hidden for principals whose menu source has < 2 entries.
//   - Renders the trigger when the menu source has >= 2 entries.
//   - Click invokes the switcher (persist + invalidate).
//   - Bootstrap-only entries (discovery found a not-yet-setup stake the
//     principal has no claim-derived role on) carry a "Setup needed"
//     badge.
//
// `useAccessibleStakesWithBootstrap` is the menu source (claim-derived
// stakes + bootstrap-discovery stakes, each flagged `needsSetup`),
// `useFirestoreDoc` is the per-stake parent-doc read. Both are mocked
// at the module boundary so the test can drive them deterministically.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccessibleStakeEntry } from '../../lib/useActiveStake';

const entriesSpy: { current: AccessibleStakeEntry[] } = { current: [] };
const switcherSpy = vi.fn();
vi.mock('../../lib/useActiveStake', () => ({
  useAccessibleStakesWithBootstrap: () => entriesSpy.current,
  useActiveStakeSwitcher: () => switcherSpy,
}));

function claimEntry(stakeId: string): AccessibleStakeEntry {
  return { stakeId, needsSetup: false };
}
function bootstrapEntry(stakeId: string): AccessibleStakeEntry {
  return { stakeId, needsSetup: true };
}

vi.mock('../../lib/data', () => ({
  useFirestoreDoc: (ref: { id?: string } | null) => ({
    data: ref ? { stake_name: `Stake ${ref.id ?? ''}` } : undefined,
    isLoading: false,
  }),
}));

vi.mock('../../lib/firebase', () => ({
  db: {} as unknown,
}));

vi.mock('../../lib/docs', () => ({
  stakeRef: (_db: unknown, stakeId: string) => ({ id: stakeId }),
}));

import { StakeSwitcher } from './StakeSwitcher';

beforeEach(() => {
  entriesSpy.current = [];
  switcherSpy.mockClear();
});

describe('StakeSwitcher visibility', () => {
  it('renders nothing when the principal has zero accessible stakes', () => {
    entriesSpy.current = [];
    const { container } = render(<StakeSwitcher activeStakeId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the principal has exactly one accessible stake', () => {
    entriesSpy.current = [claimEntry('csnorth')];
    const { container } = render(<StakeSwitcher activeStakeId="csnorth" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when activeStakeId is null (zero-role superadmin) even with ≥ 2 stakes', () => {
    entriesSpy.current = [claimEntry('csnorth'), claimEntry('ridgeline')];
    const { container } = render(<StakeSwitcher activeStakeId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the trigger button when the principal has ≥ 2 accessible stakes', () => {
    entriesSpy.current = [claimEntry('csnorth'), claimEntry('ridgeline')];
    render(<StakeSwitcher activeStakeId="csnorth" />);
    expect(screen.getByTestId('stake-switcher-trigger')).toBeInTheDocument();
  });

  it('trigger renders as a chevron-only affordance (no duplicated stake name)', () => {
    // Operator decision: the brand-bar (`Shell.tsx` `.kd-brandbar-stake`)
    // already shows which stake the user is on. The switcher trigger
    // doesn't repeat the label; it's a chevron the user clicks to open
    // the dropdown.
    entriesSpy.current = [claimEntry('csnorth'), claimEntry('ridgeline')];
    render(<StakeSwitcher activeStakeId="csnorth" />);
    const trigger = screen.getByTestId('stake-switcher-trigger');
    // No `stake-switcher-current` text element any more.
    expect(screen.queryByTestId('stake-switcher-current')).toBeNull();
    // The chevron carries no accessible label of its own, so the
    // button needs `aria-label` for assistive tech.
    expect(trigger).toHaveAttribute('aria-label', 'Switch active stake');
    // The trigger text content should be empty (chevron is aria-hidden).
    expect(trigger.textContent).toBe('');
  });

  it('renders the trigger when a manager of A is also the bootstrap admin of not-yet-setup B', () => {
    // The operator's exact scenario: one claim-derived stake plus one
    // bootstrap-discovery-only stake still totals ≥ 2 menu entries, so
    // the switcher must appear even though `useAccessibleStakes()`
    // alone (claim-derived only) would report just one.
    entriesSpy.current = [claimEntry('csnorth'), bootstrapEntry('ridgeline')];
    render(<StakeSwitcher activeStakeId="csnorth" />);
    expect(screen.getByTestId('stake-switcher-trigger')).toBeInTheDocument();
  });
});

describe('StakeSwitcher click handler', () => {
  it('opening the menu lists each accessible stake by display name', async () => {
    entriesSpy.current = [claimEntry('csnorth'), claimEntry('ridgeline')];
    const user = userEvent.setup();
    render(<StakeSwitcher activeStakeId="csnorth" />);
    await user.click(screen.getByTestId('stake-switcher-trigger'));
    expect(screen.getByTestId('stake-switcher-item-csnorth')).toBeInTheDocument();
    expect(screen.getByTestId('stake-switcher-item-ridgeline')).toBeInTheDocument();
  });

  it('clicking a stake item invokes the switcher with that stake id', async () => {
    entriesSpy.current = [claimEntry('csnorth'), claimEntry('ridgeline')];
    const user = userEvent.setup();
    render(<StakeSwitcher activeStakeId="csnorth" />);
    await user.click(screen.getByTestId('stake-switcher-trigger'));
    await user.click(screen.getByTestId('stake-switcher-item-ridgeline'));
    expect(switcherSpy).toHaveBeenCalledWith('ridgeline');
  });

  it('marks the active stake item with data-active="true"', async () => {
    entriesSpy.current = [claimEntry('csnorth'), claimEntry('ridgeline')];
    const user = userEvent.setup();
    render(<StakeSwitcher activeStakeId="csnorth" />);
    await user.click(screen.getByTestId('stake-switcher-trigger'));
    expect(screen.getByTestId('stake-switcher-item-csnorth').dataset.active).toBe('true');
    expect(screen.getByTestId('stake-switcher-item-ridgeline').dataset.active).toBe('false');
  });

  it('badges a bootstrap-only entry as "Setup needed"; leaves claim-derived entries unbadged', async () => {
    entriesSpy.current = [claimEntry('csnorth'), bootstrapEntry('ridgeline')];
    const user = userEvent.setup();
    render(<StakeSwitcher activeStakeId="csnorth" />);
    await user.click(screen.getByTestId('stake-switcher-trigger'));
    expect(screen.getByTestId('stake-switcher-setup-badge-ridgeline')).toHaveTextContent(
      'Setup needed',
    );
    expect(screen.queryByTestId('stake-switcher-setup-badge-csnorth')).toBeNull();
  });

  it('selecting a bootstrap-only entry invokes the switcher with that stake id', async () => {
    entriesSpy.current = [claimEntry('csnorth'), bootstrapEntry('ridgeline')];
    const user = userEvent.setup();
    render(<StakeSwitcher activeStakeId="csnorth" />);
    await user.click(screen.getByTestId('stake-switcher-trigger'));
    await user.click(screen.getByTestId('stake-switcher-item-ridgeline'));
    expect(switcherSpy).toHaveBeenCalledWith('ridgeline');
  });
});
