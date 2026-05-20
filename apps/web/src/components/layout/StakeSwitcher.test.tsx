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

// Each call to `useFirestoreDoc` returns a stake-name-only doc keyed
// on the ref id; tests that need the loading state (data: undefined)
// flip `firestoreDataOverride` to suppress doc data for a specific
// stake id.
const firestoreDataOverride: { suppressFor: Set<string> } = { suppressFor: new Set() };
vi.mock('../../lib/data', () => ({
  useFirestoreDoc: (ref: { id?: string } | null) => {
    if (!ref) return { data: undefined, isLoading: false };
    if (firestoreDataOverride.suppressFor.has(ref.id ?? '')) {
      return { data: undefined, isLoading: true };
    }
    return { data: { stake_name: `Stake ${ref.id ?? ''}` }, isLoading: false };
  },
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
  firestoreDataOverride.suppressFor = new Set();
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

  it('trigger label shows the active stake display name (item 6)', () => {
    accessibleSpy.current = ['csnorth', 'ridgeline'];
    render(<StakeSwitcher activeStakeId="csnorth" />);
    // The mocked `useFirestoreDoc` returns `Stake ${ref.id}` for the
    // display name — the trigger should render that, not the static
    // "Switch stake" label the previous design used.
    expect(screen.getByTestId('stake-switcher-current')).toHaveTextContent('Stake csnorth');
    expect(screen.getByTestId('stake-switcher-current')).not.toHaveTextContent('Switch stake');
  });

  it('trigger label falls back to the slug while the stake doc is loading', () => {
    accessibleSpy.current = ['csnorth', 'ridgeline'];
    firestoreDataOverride.suppressFor = new Set(['csnorth']);
    render(<StakeSwitcher activeStakeId="csnorth" />);
    // No data for the active stake — the trigger uses the slug as a
    // placeholder rather than "Switch stake."
    expect(screen.getByTestId('stake-switcher-current')).toHaveTextContent('csnorth');
    expect(screen.getByTestId('stake-switcher-current')).not.toHaveTextContent('Switch stake');
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
