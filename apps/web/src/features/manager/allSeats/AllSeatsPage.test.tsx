// Component tests for the manager All Seats page.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Building, Seat, Stake, Ward } from '@kindoo/shared';
import { makeSeat, makeWard } from '../../../../test/fixtures';

const useAllSeatsMock = vi.fn();
const useWardsMock = vi.fn();
const useBuildingsMock = vi.fn();
const useStakeDocMock = vi.fn();
const navigateMock = vi.fn().mockResolvedValue(undefined);

vi.mock('./hooks', () => ({
  useAllSeats: () => useAllSeatsMock(),
  useWards: () => useWardsMock(),
  useBuildings: () => useBuildingsMock(),
}));

vi.mock('../dashboard/hooks', () => ({
  useStakeDoc: () => useStakeDocMock(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

import { AllSeatsPage } from './AllSeatsPage';

function liveResult<T>(data: T[] | undefined, isLoading = false) {
  return {
    data,
    error: null,
    status: isLoading ? 'pending' : 'success',
    isPending: isLoading,
    isLoading,
    isSuccess: !isLoading,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  };
}

function mockAll(opts: {
  seats?: Seat[];
  wards?: Ward[];
  buildings?: Building[];
  stake?: Partial<Stake>;
}) {
  useAllSeatsMock.mockReturnValue(liveResult(opts.seats ?? []));
  useWardsMock.mockReturnValue(liveResult(opts.wards ?? []));
  useBuildingsMock.mockReturnValue(liveResult(opts.buildings ?? []));
  useStakeDocMock.mockReturnValue({
    data: opts.stake,
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
});

describe('<AllSeatsPage />', () => {
  it('renders the empty-state copy when filters return no rows', () => {
    mockAll({ seats: [], wards: [], buildings: [], stake: { stake_seat_cap: 200 } });
    render(<AllSeatsPage />);
    expect(screen.getByText(/no seats match the current filters/i)).toBeInTheDocument();
  });

  it('renders one row per seat with the scope chip', () => {
    mockAll({
      seats: [
        makeSeat({ scope: 'stake' }),
        makeSeat({ scope: 'CO', member_canonical: 'b@x.com', member_email: 'b@x.com' }),
      ],
      wards: [makeWard({ ward_code: 'CO' })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    expect(document.querySelectorAll('.roster-card-scope')).toHaveLength(2);
  });

  it('filters by ward when the ward filter is set', () => {
    mockAll({
      seats: [
        makeSeat({ scope: 'stake', member_canonical: 's@x.com', member_email: 's@x.com' }),
        makeSeat({ scope: 'CO' }),
      ],
      wards: [makeWard({ ward_code: 'CO' })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage initialWard="CO" />);
    expect(document.querySelectorAll('.roster-card')).toHaveLength(1);
  });

  it('filters by type', () => {
    mockAll({
      seats: [
        makeSeat({ type: 'auto' }),
        makeSeat({
          type: 'manual',
          member_canonical: 'b@x.com',
          member_email: 'b@x.com',
          callings: [],
          reason: 'r',
        }),
      ],
      wards: [],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage initialType="manual" />);
    expect(document.querySelectorAll('.roster-card')).toHaveLength(1);
    expect(document.querySelector('.roster-card')).toHaveClass('type-manual');
  });

  it('renders the overall utilization bar only when scope is "All"', () => {
    mockAll({
      seats: [makeSeat({ scope: 'stake' })],
      wards: [makeWard({ ward_code: 'CO', seat_cap: 20 })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    const { rerender } = render(<AllSeatsPage />);
    expect(screen.getByText(/1 \/ 200 seats used/)).toBeInTheDocument();
    rerender(<AllSeatsPage initialWard="CO" />);
    expect(screen.queryByText(/1 \/ 200 seats used/)).toBeNull();
  });

  it('renders one summary card per scope (with stake first)', () => {
    mockAll({
      seats: [
        makeSeat({ scope: 'stake' }),
        makeSeat({ scope: 'CO', member_canonical: 'a@x.com', member_email: 'a@x.com' }),
      ],
      wards: [makeWard({ ward_code: 'CO' })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    const cards = document.querySelectorAll('.kd-scope-summary-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent(/Stake/);
  });

  it('updates the URL when a filter changes', async () => {
    const user = (await import('@testing-library/user-event')).default;
    const u = user.setup();
    mockAll({
      seats: [],
      wards: [makeWard({ ward_code: 'CO' })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    await u.selectOptions(screen.getByLabelText(/Scope:/), 'CO');
    expect(navigateMock).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.objectContaining({ ward: 'CO' }) }),
    );
  });
});
