// Component tests for the Stake Roster page. Same mock-the-hook
// pattern as the bishopric Roster page test.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Seat, Stake, Ward } from '@kindoo/shared';
import { makeSeat, makeWard } from '../../../test/fixtures';

const useStakeRosterMock = vi.fn();
const useStakeWardsMock = vi.fn();
const useFirestoreDocMock = vi.fn();

vi.mock('./hooks', () => ({
  useStakeRoster: () => useStakeRosterMock(),
  useStakeWards: () => useStakeWardsMock(),
}));

vi.mock('../../lib/data', () => ({
  useFirestoreDoc: (ref: unknown) => useFirestoreDocMock(ref),
}));

vi.mock('../requests/hooks', () => ({
  usePendingRemoveRequests: () => ({
    data: [],
    error: null,
    status: 'success',
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  }),
  useSubmitRequest: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { StakeRosterPage } from './RosterPage';

function mockSeats(seats: Seat[] | undefined, isLoading = false) {
  useStakeRosterMock.mockReturnValue({
    data: seats,
    error: null,
    status: isLoading ? 'pending' : 'success',
    isPending: isLoading,
    isLoading,
    isSuccess: !isLoading,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  });
}

function mockWards(wards: Ward[]) {
  useStakeWardsMock.mockReturnValue({
    data: wards,
    error: null,
    status: 'success',
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  });
}

function mockStakeDoc(stake: Partial<Stake> | undefined) {
  useFirestoreDocMock.mockReturnValue({
    data: stake,
    error: null,
    status: 'success',
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no wards. Tests that exercise the new pool denominator
  // override via mockWards.
  mockWards([]);
});

describe('<StakeRosterPage />', () => {
  it('renders the empty state when there are no stake seats', () => {
    mockSeats([]);
    mockStakeDoc({ stake_seat_cap: 200 });
    render(<StakeRosterPage />);
    expect(screen.getByText(/no stake seats yet/i)).toBeInTheDocument();
  });

  it('renders one card per stake seat', () => {
    mockSeats([
      makeSeat({ scope: 'stake', member_canonical: 'a@x.com', member_email: 'a@x.com' }),
      makeSeat({ scope: 'stake', member_canonical: 'b@x.com', member_email: 'b@x.com' }),
    ]);
    mockStakeDoc({ stake_seat_cap: 200 });
    render(<StakeRosterPage />);
    expect(document.querySelectorAll('.roster-card')).toHaveLength(2);
  });

  it('displays the utilization bar against the stake-presidency pool size', () => {
    // No wards seeded → pool size equals stake_seat_cap.
    mockSeats([makeSeat({ scope: 'stake' })]);
    mockStakeDoc({ stake_seat_cap: 200 });
    render(<StakeRosterPage />);
    expect(screen.getByText(/1 \/ 200 seats used/)).toBeInTheDocument();
  });

  it('subtracts every ward seat_cap from the stake cap for the pool denominator', () => {
    mockSeats([makeSeat({ scope: 'stake' })]);
    mockStakeDoc({ stake_seat_cap: 200 });
    mockWards([
      makeWard({ ward_code: 'CO', seat_cap: 50 }),
      makeWard({ ward_code: 'GE', seat_cap: 50 }),
      makeWard({ ward_code: 'PR', seat_cap: 50 }),
    ]);
    render(<StakeRosterPage />);
    // 200 - (50 + 50 + 50) = 50.
    expect(screen.getByText(/1 \/ 50 seats used/)).toBeInTheDocument();
  });

  it('renders the computed cap (not the cap-unset variant) when stake doc + wards are loaded', () => {
    // Regression: with `useFirestoreOnce` the stake doc was reliably
    // empty in production and the helper returned null, falling
    // through to "(cap unset)". The live `useFirestoreDoc` keeps the
    // doc populated so the bar renders the real ratio.
    mockSeats([makeSeat({ scope: 'stake' })]);
    mockStakeDoc({ stake_seat_cap: 200 });
    mockWards([makeWard({ ward_code: 'CO', seat_cap: 20 })]);
    render(<StakeRosterPage />);
    expect(screen.queryByText(/cap unset/i)).toBeNull();
    expect(screen.getByText(/1 \/ 180 seats used/)).toBeInTheDocument();
  });
});
