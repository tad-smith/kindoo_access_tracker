// Component tests for the Stake Roster page. Same mock-the-hook
// pattern as the bishopric Roster page test.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AccessRequest, Seat, Stake, Ward } from '@kindoo/shared';
import { makeRequest, makeSeat, makeWard } from '../../../test/fixtures';

const useStakeRosterMock = vi.fn();
const useStakeWardsMock = vi.fn();
const useFirestoreDocMock = vi.fn();
const usePendingRequestsForScopeMock = vi.fn();

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
  usePendingRequestsForScope: (scope: string | null) => usePendingRequestsForScopeMock(scope),
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

function mockPendingRequests(requests: AccessRequest[]) {
  usePendingRequestsForScopeMock.mockReturnValue({
    data: requests,
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
  // Default: no pending requests.
  mockPendingRequests([]);
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

  describe('pending requests surfaced inline', () => {
    it('shows the Outstanding Requests section with a Pending badge for a stake-scope add', () => {
      mockSeats([makeSeat({ scope: 'stake' })]);
      mockStakeDoc({ stake_seat_cap: 200 });
      mockPendingRequests([
        makeRequest({
          request_id: 'r1',
          type: 'add_manual',
          scope: 'stake',
          member_canonical: 'newhire@x.com',
          member_email: 'newhire@x.com',
          member_name: 'New Hire',
          building_names: ['North Building'],
        }),
      ]);
      render(<StakeRosterPage />);
      expect(screen.getByTestId('roster-pending-adds-section')).toBeInTheDocument();
      expect(screen.getByText('New Hire')).toBeInTheDocument();
      expect(screen.getByTestId('pending-add-badge')).toBeInTheDocument();
    });

    it('marks a roster card with the Pending Removal badge when a remove is pending', () => {
      mockSeats([
        makeSeat({
          scope: 'stake',
          member_canonical: 'leaving@x.com',
          member_email: 'leaving@x.com',
          member_name: 'Leaving Soon',
          type: 'manual',
          callings: [],
        }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      mockPendingRequests([
        makeRequest({
          request_id: 'r1',
          type: 'remove',
          scope: 'stake',
          member_canonical: 'leaving@x.com',
          member_email: 'leaving@x.com',
        }),
      ]);
      render(<StakeRosterPage />);
      expect(screen.getByTestId('pending-removal-badge-leaving@x.com')).toBeInTheDocument();
      const card = document.querySelector('[data-seat-id="leaving@x.com"]');
      expect(card?.className).toContain('has-removal-pending');
    });
  });
});
