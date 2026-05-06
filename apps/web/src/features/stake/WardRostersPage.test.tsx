// Component tests for the Stake Ward Rosters page.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccessRequest, Seat, Ward } from '@kindoo/shared';
import { makeRequest, makeSeat, makeWard } from '../../../test/fixtures';

const useStakeWardsMock = vi.fn();
const useWardSeatsMock = vi.fn();
const usePendingRequestsForScopeMock = vi.fn();
const navigateMock = vi.fn().mockResolvedValue(undefined);

vi.mock('./hooks', () => ({
  useStakeWards: () => useStakeWardsMock(),
  useWardSeats: (ward: string | null) => useWardSeatsMock(ward),
}));

vi.mock('../requests/hooks', () => ({
  usePendingRequestsForScope: (scope: string | null) => usePendingRequestsForScopeMock(scope),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

import { WardRostersPage } from './WardRostersPage';

function mockWards(wards: Ward[] | undefined, isLoading = false) {
  useStakeWardsMock.mockReturnValue({
    data: wards,
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

function mockSeats(seats: Seat[] | undefined, isLoading = false) {
  useWardSeatsMock.mockReturnValue({
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
  navigateMock.mockResolvedValue(undefined);
  // Default: no pending requests.
  mockPendingRequests([]);
});

describe('<WardRostersPage />', () => {
  it('shows the "Pick a ward" placeholder when nothing is selected', () => {
    mockWards([makeWard({ ward_code: 'CO' }), makeWard({ ward_code: 'GE' })]);
    mockSeats(undefined);
    render(<WardRostersPage />);
    expect(screen.getByText(/pick a ward above/i)).toBeInTheDocument();
  });

  it('lists every ward in the dropdown sorted alphabetically', () => {
    mockWards([
      makeWard({ ward_code: 'GE', ward_name: 'Genoa' }),
      makeWard({ ward_code: 'CO', ward_name: 'Cordera' }),
    ]);
    mockSeats(undefined);
    render(<WardRostersPage />);
    const opts = screen.getAllByRole('option').map((o) => o.textContent);
    // "Choose a ward…" is at index 0; CO comes before GE alphabetically.
    expect(opts.slice(1)).toEqual(['Cordera (CO)', 'Genoa (GE)']);
  });

  it('renders the chosen ward’s roster with its utilization bar', async () => {
    const user = userEvent.setup();
    mockWards([makeWard({ ward_code: 'CO', ward_name: 'Cordera', seat_cap: 20 })]);
    mockSeats([
      makeSeat({ scope: 'CO' }),
      makeSeat({ scope: 'CO', member_canonical: 'b@x.com', member_email: 'b@x.com' }),
    ]);
    render(<WardRostersPage />);
    await user.selectOptions(screen.getByLabelText(/^Ward:/), 'CO');
    expect(screen.getByText(/2 \/ 20 seats used/)).toBeInTheDocument();
  });

  it('honours the initialWard prop (URL deep link)', () => {
    mockWards([makeWard({ ward_code: 'CO', ward_name: 'Cordera', seat_cap: 20 })]);
    mockSeats([makeSeat({ scope: 'CO' })]);
    render(<WardRostersPage initialWard="CO" />);
    expect(useWardSeatsMock).toHaveBeenCalledWith('CO');
  });

  it('falls back from an unknown deep-link ward', () => {
    mockWards([makeWard({ ward_code: 'CO' })]);
    mockSeats(undefined);
    render(<WardRostersPage initialWard="ZZ" />);
    // The select drops back to "Choose a ward…" once wards load.
    const select = screen.getByLabelText(/^Ward:/) as HTMLSelectElement;
    expect(select.value).toBe('');
  });

  describe('pending requests surfaced inline', () => {
    it('shows the Outstanding Requests section when an add is pending for the selected ward', () => {
      mockWards([makeWard({ ward_code: 'CO', ward_name: 'Cordera', seat_cap: 20 })]);
      mockSeats([makeSeat({ scope: 'CO' })]);
      mockPendingRequests([
        makeRequest({
          request_id: 'r1',
          type: 'add_manual',
          scope: 'CO',
          member_canonical: 'newhire@x.com',
          member_email: 'newhire@x.com',
          member_name: 'New Hire',
        }),
      ]);
      render(<WardRostersPage initialWard="CO" />);
      expect(screen.getByTestId('roster-pending-adds-section')).toBeInTheDocument();
      expect(screen.getByText('New Hire')).toBeInTheDocument();
    });

    it('marks a roster card with the Pending Removal badge when a remove is pending for the selected ward', () => {
      mockWards([makeWard({ ward_code: 'CO', ward_name: 'Cordera', seat_cap: 20 })]);
      mockSeats([
        makeSeat({
          scope: 'CO',
          member_canonical: 'leaving@x.com',
          member_email: 'leaving@x.com',
          member_name: 'Leaving Soon',
          type: 'manual',
          callings: [],
        }),
      ]);
      mockPendingRequests([
        makeRequest({
          request_id: 'r1',
          type: 'remove',
          scope: 'CO',
          member_canonical: 'leaving@x.com',
          member_email: 'leaving@x.com',
        }),
      ]);
      render(<WardRostersPage initialWard="CO" />);
      expect(screen.getByTestId('pending-removal-badge-leaving@x.com')).toBeInTheDocument();
      const card = document.querySelector('[data-seat-id="leaving@x.com"]');
      expect(card?.className).toContain('has-removal-pending');
    });
  });
});
