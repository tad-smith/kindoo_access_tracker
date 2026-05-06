// Component tests for the manager All Seats page.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Building, Seat, Stake, Ward } from '@kindoo/shared';
import { makeSeat, makeWard } from '../../../../test/fixtures';

const useAllSeatsMock = vi.fn();
const useWardsMock = vi.fn();
const useBuildingsMock = vi.fn();
const useStakeDocMock = vi.fn();
const usePrincipalMock = vi.fn();
const inlineEditMutate = vi.fn().mockResolvedValue(undefined);
const reconcileMutate = vi.fn().mockResolvedValue(undefined);
const navigateMock = vi.fn().mockResolvedValue(undefined);

vi.mock('./hooks', () => ({
  useAllSeats: () => useAllSeatsMock(),
  useWards: () => useWardsMock(),
  useBuildings: () => useBuildingsMock(),
  useInlineSeatEditMutation: () => ({ mutateAsync: inlineEditMutate, isPending: false }),
  useReconcileSeatMutation: () => ({ mutateAsync: reconcileMutate, isPending: false }),
}));

vi.mock('../dashboard/hooks', () => ({
  useStakeDoc: () => useStakeDocMock(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

// The roster card's RemovalAffordance subscribes via these request
// hooks; mock them so the component tree renders without a real
// QueryClient / Firestore listener.
vi.mock('../../requests/hooks', () => ({
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

vi.mock('../../../lib/principal', () => ({
  usePrincipal: () => usePrincipalMock(),
}));

function principal(opts: { stake?: boolean; wards?: string[] } = {}): unknown {
  return {
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    email: 'manager@example.com',
    canonical: 'manager@example.com',
    isPlatformSuperadmin: false,
    managerStakes: ['csnorth'],
    stakeMemberStakes: opts.stake ? ['csnorth'] : [],
    bishopricWards: opts.wards ? { csnorth: opts.wards } : {},
    hasAnyRole: () => true,
    wardsInStake: () => opts.wards ?? [],
  };
}

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
  // Default principal: manager who is also a stake member + bishop of
  // every ward in the test fixtures (CO, GE, BA). This keeps existing
  // tests passing under the symmetric-authority gate. Tests that need
  // a different principal shape override via `usePrincipalMock.mockReturnValue(principal({...}))`.
  usePrincipalMock.mockReturnValue(principal({ stake: true, wards: ['CO', 'GE', 'BA'] }));
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

  it('renders the contextual utilization bar against stake_seat_cap when scope is "All"', () => {
    mockAll({
      seats: [makeSeat({ scope: 'stake' })],
      wards: [makeWard({ ward_code: 'CO', seat_cap: 20 })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    const host = screen.getByTestId('allseats-utilization');
    expect(host).toHaveTextContent(/Entire-stake utilization/);
    expect(host).toHaveTextContent(/1 \/ 200 seats used/);
  });

  it('renders the contextual utilization bar against ward.seat_cap when scope is a ward', () => {
    mockAll({
      seats: [
        makeSeat({ scope: 'stake', member_canonical: 's@x.com', member_email: 's@x.com' }),
        makeSeat({ scope: 'CO', member_canonical: 'a@x.com', member_email: 'a@x.com' }),
        makeSeat({ scope: 'CO', member_canonical: 'b@x.com', member_email: 'b@x.com' }),
      ],
      wards: [makeWard({ ward_code: 'CO', seat_cap: 20 })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage initialWard="CO" />);
    const host = screen.getByTestId('allseats-utilization');
    expect(host).toHaveTextContent(/Ward CO utilization/);
    expect(host).toHaveTextContent(/2 \/ 20 seats used/);
  });

  it('renders the contextual utilization bar against the stake-presidency pool size when scope is "stake"', () => {
    mockAll({
      seats: [
        makeSeat({ scope: 'stake', member_canonical: 's1@x.com', member_email: 's1@x.com' }),
        makeSeat({ scope: 'stake', member_canonical: 's2@x.com', member_email: 's2@x.com' }),
        makeSeat({ scope: 'CO', member_canonical: 'a@x.com', member_email: 'a@x.com' }),
      ],
      wards: [makeWard({ ward_code: 'CO', seat_cap: 20 })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage initialWard="stake" />);
    const host = screen.getByTestId('allseats-utilization');
    expect(host).toHaveTextContent(/Stake-scope utilization/);
    // 200 - 20 (CO) = 180.
    expect(host).toHaveTextContent(/2 \/ 180 seats used/);
  });

  it('subtracts every ward seat_cap from stake_seat_cap for the Stake-scope pool denominator', () => {
    mockAll({
      seats: [makeSeat({ scope: 'stake' })],
      wards: [
        makeWard({ ward_code: 'CO', seat_cap: 50 }),
        makeWard({ ward_code: 'GE', seat_cap: 50 }),
        makeWard({ ward_code: 'PR', seat_cap: 50 }),
      ],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage initialWard="stake" />);
    const host = screen.getByTestId('allseats-utilization');
    // 200 - (50 + 50 + 50) = 50.
    expect(host).toHaveTextContent(/1 \/ 50 seats used/);
  });

  it('renders the contextual utilization bar in cap-unset form when no cap is configured', () => {
    mockAll({
      seats: [makeSeat({ scope: 'CO' })],
      wards: [makeWard({ ward_code: 'CO', seat_cap: 0 })],
      buildings: [],
      stake: { stake_seat_cap: 0 },
    });
    render(<AllSeatsPage initialWard="CO" />);
    const host = screen.getByTestId('allseats-utilization');
    expect(host).toHaveTextContent(/cap unset/i);
  });

  it('sorts cross-scope seats: stake first, then wards alpha; type-banded inside each scope', () => {
    mockAll({
      seats: [
        makeSeat({
          scope: 'GE',
          type: 'auto',
          member_canonical: 'ge@x.com',
          member_email: 'ge@x.com',
          member_name: 'GE Auto',
          sort_order: 1,
        }),
        makeSeat({
          scope: 'CO',
          type: 'manual',
          callings: [],
          member_canonical: 'co-m@x.com',
          member_email: 'co-m@x.com',
          member_name: 'CO Manual',
        }),
        makeSeat({
          scope: 'stake',
          type: 'auto',
          member_canonical: 'st@x.com',
          member_email: 'st@x.com',
          member_name: 'Stake Auto',
          sort_order: 1,
        }),
        makeSeat({
          scope: 'CO',
          type: 'auto',
          member_canonical: 'co-a@x.com',
          member_email: 'co-a@x.com',
          member_name: 'CO Auto',
          sort_order: 1,
        }),
      ],
      wards: [makeWard({ ward_code: 'CO' }), makeWard({ ward_code: 'GE' })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    const cards = Array.from(document.querySelectorAll('.roster-card'));
    const order = cards.map((c) => c.getAttribute('data-seat-id'));
    expect(order).toEqual(['st@x.com', 'co-a@x.com', 'co-m@x.com', 'ge@x.com']);
  });

  it('does not render per-scope summary cards (utilization is on Dashboard)', () => {
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
    expect(document.querySelectorAll('.kd-scope-summary-card')).toHaveLength(0);
    expect(screen.queryByTestId('scope-summaries')).toBeNull();
  });

  it('updates the URL when a filter changes', async () => {
    const u = userEvent.setup();
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

  it('hides the Edit affordance on auto seats', () => {
    mockAll({
      seats: [makeSeat({ type: 'auto', member_canonical: 'a@x.com' })],
      wards: [],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    expect(screen.queryByTestId('seat-edit-a@x.com')).toBeNull();
  });

  it('shows the Edit affordance on manual seats', () => {
    mockAll({
      seats: [
        makeSeat({
          type: 'manual',
          member_canonical: 'm@x.com',
          callings: [],
          reason: 'covering bishop',
        }),
      ],
      wards: [],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    expect(screen.getByTestId('seat-edit-m@x.com')).toBeInTheDocument();
  });

  it('shows the duplicate badge + reconcile button when a seat has duplicates', () => {
    mockAll({
      seats: [
        makeSeat({
          member_canonical: 'd@x.com',
          duplicate_grants: [
            {
              scope: 'CO',
              type: 'manual',
              reason: 'extra',
              detected_at: {
                seconds: 0,
                nanoseconds: 0,
                toMillis: () => 0,
                toDate: () => new Date(),
              },
            },
          ],
        }),
      ],
      wards: [],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    expect(screen.getByTestId('seat-duplicate-badge-d@x.com')).toBeInTheDocument();
    expect(screen.getByTestId('seat-reconcile-d@x.com')).toBeInTheDocument();
  });

  it('opens the reconcile dialog with one choice per [primary, ...duplicates]', async () => {
    const user = userEvent.setup();
    mockAll({
      seats: [
        makeSeat({
          scope: 'CO',
          type: 'manual',
          callings: [],
          reason: 'primary reason',
          member_canonical: 'r@x.com',
          duplicate_grants: [
            {
              scope: 'CO',
              type: 'manual',
              reason: 'duplicate-1',
              detected_at: {
                seconds: 0,
                nanoseconds: 0,
                toMillis: () => 0,
                toDate: () => new Date(),
              },
            },
          ],
        }),
      ],
      wards: [],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    await user.click(screen.getByTestId('seat-reconcile-r@x.com'));
    // Two radio choices visible (primary + 1 duplicate).
    expect(screen.getByTestId('reconcile-choice-0')).toBeInTheDocument();
    expect(screen.getByTestId('reconcile-choice-1')).toBeInTheDocument();
    expect(screen.getByTestId('reconcile-confirm')).toBeInTheDocument();
  });

  describe('per-row Remove affordance — symmetric authority gate', () => {
    it('renders the Remove button on manual / temp rows whose scope the principal has authority for', () => {
      // Manager who also holds stake + bishopric of CO.
      usePrincipalMock.mockReturnValue(principal({ stake: true, wards: ['CO'] }));
      mockAll({
        seats: [
          makeSeat({
            scope: 'CO',
            member_canonical: 'co-manual@x.com',
            member_email: 'co-manual@x.com',
            type: 'manual',
            callings: [],
          }),
          makeSeat({
            scope: 'stake',
            member_canonical: 'stake-temp@x.com',
            member_email: 'stake-temp@x.com',
            type: 'temp',
            callings: [],
            end_date: '2026-12-31',
          }),
        ],
        wards: [makeWard({ ward_code: 'CO' })],
        buildings: [],
        stake: { stake_seat_cap: 200 },
      });
      render(<AllSeatsPage />);
      expect(screen.getByTestId('remove-btn-co-manual@x.com')).toBeInTheDocument();
      expect(screen.getByTestId('remove-btn-stake-temp@x.com')).toBeInTheDocument();
    });

    it('hides the Remove button on rows whose scope the principal lacks authority for', () => {
      // Manager who holds bishopric of CO but no stake claim. They
      // see all seats (manager read), but the symmetric-authority
      // rule blocks the Remove button on stake-scope and other-ward
      // rows.
      usePrincipalMock.mockReturnValue(principal({ wards: ['CO'] }));
      mockAll({
        seats: [
          makeSeat({
            scope: 'CO',
            member_canonical: 'co-manual@x.com',
            member_email: 'co-manual@x.com',
            type: 'manual',
            callings: [],
          }),
          makeSeat({
            scope: 'GE',
            member_canonical: 'ge-manual@x.com',
            member_email: 'ge-manual@x.com',
            type: 'manual',
            callings: [],
          }),
          makeSeat({
            scope: 'stake',
            member_canonical: 'stake-manual@x.com',
            member_email: 'stake-manual@x.com',
            type: 'manual',
            callings: [],
          }),
        ],
        wards: [makeWard({ ward_code: 'CO' }), makeWard({ ward_code: 'GE' })],
        buildings: [],
        stake: { stake_seat_cap: 200 },
      });
      render(<AllSeatsPage />);
      expect(screen.getByTestId('remove-btn-co-manual@x.com')).toBeInTheDocument();
      expect(screen.queryByTestId('remove-btn-ge-manual@x.com')).toBeNull();
      expect(screen.queryByTestId('remove-btn-stake-manual@x.com')).toBeNull();
    });

    it('hides the Remove button for a manager-only principal (no stake / no ward claim)', () => {
      // Pure-manager: read-everywhere, write-nowhere. Per B-3 / T-36
      // the request-create rule denies a pure-manager submitting any
      // request, so the SPA must hide the button to keep the affordance
      // consistent with the rule.
      usePrincipalMock.mockReturnValue(principal({}));
      mockAll({
        seats: [
          makeSeat({
            scope: 'CO',
            member_canonical: 'co-manual@x.com',
            member_email: 'co-manual@x.com',
            type: 'manual',
            callings: [],
          }),
        ],
        wards: [makeWard({ ward_code: 'CO' })],
        buildings: [],
        stake: { stake_seat_cap: 200 },
      });
      render(<AllSeatsPage />);
      expect(screen.queryByTestId('remove-btn-co-manual@x.com')).toBeNull();
    });
  });
});
