// Component tests for the StakeSwitcher dropdown.
//   - Hidden for principals with < 2 accessible stakes.
//   - Renders the trigger when accessible.length >= 2.
//   - Click invokes the switcher (persist + invalidate).
//
// `useAccessibleStakes` is the principal-derived list, `useFirestoreDoc`
// is the per-stake parent-doc read. Both are mocked at the module
// boundary so the test can drive them deterministically.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const accessibleSpy: { current: string[] } = { current: [] };
const switcherSpy = vi.fn();
vi.mock('../../lib/useActiveStake', () => ({
  useAccessibleStakes: () => accessibleSpy.current,
  useActiveStakeSwitcher: () => switcherSpy,
}));

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
  accessibleSpy.current = [];
  switcherSpy.mockClear();
});

describe('StakeSwitcher visibility', () => {
  it('renders nothing when the principal has zero accessible stakes', () => {
    accessibleSpy.current = [];
    const { container } = render(<StakeSwitcher activeStakeId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the principal has exactly one accessible stake', () => {
    accessibleSpy.current = ['csnorth'];
    const { container } = render(<StakeSwitcher activeStakeId="csnorth" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when activeStakeId is null (zero-role superadmin) even with ≥ 2 stakes', () => {
    accessibleSpy.current = ['csnorth', 'ridgeline'];
    const { container } = render(<StakeSwitcher activeStakeId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the trigger button when the principal has ≥ 2 accessible stakes', () => {
    accessibleSpy.current = ['csnorth', 'ridgeline'];
    render(<StakeSwitcher activeStakeId="csnorth" />);
    expect(screen.getByTestId('stake-switcher-trigger')).toBeInTheDocument();
  });

  it('trigger renders as a chevron-only affordance (no duplicated stake name)', () => {
    // Operator decision: the brand-bar (`Shell.tsx` `.kd-brandbar-stake`)
    // already shows which stake the user is on. The switcher trigger
    // doesn't repeat the label; it's a chevron the user clicks to open
    // the dropdown.
    accessibleSpy.current = ['csnorth', 'ridgeline'];
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
});

describe('StakeSwitcher click handler', () => {
  it('opening the menu lists each accessible stake by display name', async () => {
    accessibleSpy.current = ['csnorth', 'ridgeline'];
    const user = userEvent.setup();
    render(<StakeSwitcher activeStakeId="csnorth" />);
    await user.click(screen.getByTestId('stake-switcher-trigger'));
    expect(screen.getByTestId('stake-switcher-item-csnorth')).toBeInTheDocument();
    expect(screen.getByTestId('stake-switcher-item-ridgeline')).toBeInTheDocument();
  });

  it('clicking a stake item invokes the switcher with that stake id', async () => {
    accessibleSpy.current = ['csnorth', 'ridgeline'];
    const user = userEvent.setup();
    render(<StakeSwitcher activeStakeId="csnorth" />);
    await user.click(screen.getByTestId('stake-switcher-trigger'));
    await user.click(screen.getByTestId('stake-switcher-item-ridgeline'));
    expect(switcherSpy).toHaveBeenCalledWith('ridgeline');
  });

  it('marks the active stake item with data-active="true"', async () => {
    accessibleSpy.current = ['csnorth', 'ridgeline'];
    const user = userEvent.setup();
    render(<StakeSwitcher activeStakeId="csnorth" />);
    await user.click(screen.getByTestId('stake-switcher-trigger'));
    expect(screen.getByTestId('stake-switcher-item-csnorth').dataset.active).toBe('true');
    expect(screen.getByTestId('stake-switcher-item-ridgeline').dataset.active).toBe('false');
  });
});
