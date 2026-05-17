// Component tests for the manager All Seats page. Phase B (T-43):
// multi-row rendering — one row per grant (primary + each
// `duplicate_grants[]` entry). Edit on a duplicate row is disabled
// with a tooltip; Remove on a duplicate row submits a `remove`
// request scoped to the grant's `(scope, kindoo_site_id)`.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Building, DuplicateGrant, Seat, Stake, Ward } from '@kindoo/shared';
import { makeSeat, makeWard } from '../../../../test/fixtures';

const useAllSeatsMock = vi.fn();
const useWardsMock = vi.fn();
const useBuildingsMock = vi.fn();
const useKindooSitesMock = vi.fn();
const useStakeDocMock = vi.fn();
const usePrincipalMock = vi.fn();
const inlineEditMutate = vi.fn().mockResolvedValue(undefined);
const submitMutate = vi.fn().mockResolvedValue({ id: 'req-new' });
const navigateMock = vi.fn().mockResolvedValue(undefined);

vi.mock('./hooks', () => ({
  useAllSeats: () => useAllSeatsMock(),
  useWards: () => useWardsMock(),
  useBuildings: () => useBuildingsMock(),
  useKindooSites: () => useKindooSitesMock(),
  useInlineSeatEditMutation: () => ({ mutateAsync: inlineEditMutate, isPending: false }),
}));

vi.mock('../dashboard/hooks', () => ({
  useStakeDoc: () => useStakeDocMock(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

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
  useSubmitRequest: () => ({ mutateAsync: submitMutate, isPending: false }),
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
  kindooSites?: Array<{ id: string; display_name: string }>;
  stake?: Partial<Stake>;
}) {
  useAllSeatsMock.mockReturnValue(liveResult(opts.seats ?? []));
  useWardsMock.mockReturnValue(liveResult(opts.wards ?? []));
  useBuildingsMock.mockReturnValue(liveResult(opts.buildings ?? []));
  useKindooSitesMock.mockReturnValue(
    liveResult(
      (opts.kindooSites ?? []).map((s) => ({
        id: s.id,
        display_name: s.display_name,
        kindoo_expected_site_name: '',
        created_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
        last_modified_at: {
          seconds: 0,
          nanoseconds: 0,
          toDate: () => new Date(),
          toMillis: () => 0,
        },
        lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
      })),
    ),
  );
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

const NOW: DuplicateGrant['detected_at'] = {
  seconds: 0,
  nanoseconds: 0,
  toDate: () => new Date(),
  toMillis: () => 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  navigateMock.mockResolvedValue(undefined);
  usePrincipalMock.mockReturnValue(principal({ stake: true, wards: ['CO', 'GE', 'BA', 'FN'] }));
});

describe('<AllSeatsPage />', () => {
  it('renders the empty-state copy when filters return no rows', () => {
    mockAll({ seats: [], wards: [], buildings: [], stake: { stake_seat_cap: 200 } });
    render(<AllSeatsPage />);
    expect(screen.getByText(/no seats match the current filters/i)).toBeInTheDocument();
  });

  it('renders one row per seat with the scope chip (no duplicates)', () => {
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
    expect(host).toHaveTextContent(/2 \/ 180 seats used/);
  });

  it('excludes foreign-site ward seats from the entire-stake bar (Scope = "All")', () => {
    mockAll({
      seats: [
        makeSeat({ scope: 'stake', member_canonical: 's1@x.com', member_email: 's1@x.com' }),
        makeSeat({ scope: 'stake', member_canonical: 's2@x.com', member_email: 's2@x.com' }),
        makeSeat({ scope: 'CO', member_canonical: 'co1@x.com', member_email: 'co1@x.com' }),
        makeSeat({ scope: 'FN', member_canonical: 'fn1@x.com', member_email: 'fn1@x.com' }),
        makeSeat({ scope: 'FN', member_canonical: 'fn2@x.com', member_email: 'fn2@x.com' }),
      ],
      wards: [
        makeWard({ ward_code: 'CO', seat_cap: 20 }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeWard({ ward_code: 'FN', seat_cap: 20, kindoo_site_id: 'east-stake' } as any),
      ],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    const host = screen.getByTestId('allseats-utilization');
    expect(host).toHaveTextContent(/Entire-stake utilization/);
    expect(host).toHaveTextContent(/3 \/ 200 seats used/);
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

  it('shows the Edit affordance on manual seats (primary row enabled)', () => {
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
    const edit = screen.getByTestId('seat-edit-m@x.com');
    expect(edit).toBeInTheDocument();
    expect(edit).not.toBeDisabled();
  });
});

describe('<AllSeatsPage /> — Phase B multi-row rendering (T-43)', () => {
  // AC #1: seat with 1 primary + 2 duplicates renders 3 rows.
  it('AC #1: renders one row per grant (primary + every duplicate)', () => {
    mockAll({
      seats: [
        makeSeat({
          scope: 'stake',
          kindoo_site_id: null,
          member_canonical: 'multi@x.com',
          member_email: 'multi@x.com',
          duplicate_grants: [
            { scope: 'CO', type: 'auto', kindoo_site_id: null, detected_at: NOW },
            {
              scope: 'FN',
              type: 'auto',
              kindoo_site_id: 'foreign-1',
              building_names: ['Foreign Building'],
              detected_at: NOW,
            },
          ],
        }),
      ],
      wards: [
        makeWard({ ward_code: 'CO' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeWard({ ward_code: 'FN', kindoo_site_id: 'foreign-1' } as any),
      ],
      buildings: [],
      kindooSites: [{ id: 'foreign-1', display_name: 'East Stake' }],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    const cards = document.querySelectorAll('.roster-card[data-seat-id="multi@x.com"]');
    expect(cards).toHaveLength(3);
  });

  // AC #2: same-scope within-site priority loser renders its own row.
  it('AC #2: within-site priority loser (same scope as primary) renders a duplicate row', () => {
    mockAll({
      seats: [
        makeSeat({
          scope: 'CO',
          kindoo_site_id: null,
          duplicate_grants: [
            {
              scope: 'CO',
              type: 'manual',
              kindoo_site_id: null,
              reason: 'extra',
              detected_at: NOW,
            },
          ],
        }),
      ],
      wards: [makeWard({ ward_code: 'CO' })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    const cards = document.querySelectorAll(`.roster-card[data-seat-id="${'alice@example.com'}"]`);
    expect(cards).toHaveLength(2);
  });

  // AC #6 (AllSeats slice): per-row foreign-site badge keyed to the
  // rendered grant's site, not the seat's primary.
  it("AC #6: foreign-site badge renders per-row by the grant's kindoo_site_id", () => {
    mockAll({
      seats: [
        makeSeat({
          scope: 'stake', // primary on home
          kindoo_site_id: null,
          member_canonical: 'foreign-dup@x.com',
          member_email: 'foreign-dup@x.com',
          duplicate_grants: [
            {
              scope: 'FN',
              type: 'manual',
              kindoo_site_id: 'foreign-1',
              building_names: ['Foreign Building'],
              detected_at: NOW,
            },
          ],
        }),
      ],
      wards: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeWard({ ward_code: 'FN', kindoo_site_id: 'foreign-1' } as any),
      ],
      buildings: [],
      kindooSites: [{ id: 'foreign-1', display_name: 'East Stake' }],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    // Primary row carries no foreign-site badge (stake-scope is home).
    expect(screen.queryByTestId('kindoo-site-badge-foreign-dup@x.com')).toBeNull();
    // Duplicate row (dup-0) carries the badge.
    expect(screen.getByTestId('kindoo-site-badge-foreign-dup@x.com-dup-0')).toHaveTextContent(
      'East Stake',
    );
  });

  // AC #7 (AllSeats slice): Edit on a duplicate row is disabled with
  // the spec'd tooltip.
  it('AC #7: Edit button on a parallel-site duplicate row is disabled with the spec tooltip', () => {
    mockAll({
      seats: [
        makeSeat({
          type: 'manual',
          callings: [],
          reason: 'primary',
          member_canonical: 'r@x.com',
          member_email: 'r@x.com',
          kindoo_site_id: null,
          duplicate_grants: [
            {
              scope: 'FN',
              type: 'manual',
              reason: 'parallel',
              kindoo_site_id: 'foreign-1',
              detected_at: NOW,
            },
          ],
        }),
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wards: [makeWard({ ward_code: 'FN', kindoo_site_id: 'foreign-1' } as any)],
      buildings: [],
      kindooSites: [{ id: 'foreign-1', display_name: 'East Stake' }],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    const dupEdit = screen.getByTestId('seat-edit-r@x.com-dup-0');
    expect(dupEdit).toBeDisabled();
    expect(dupEdit.getAttribute('title')).toMatch(/parallel-site changes require a new request/i);
  });

  it('AC #7: Edit button on a within-site duplicate row carries the within-site tooltip', () => {
    mockAll({
      seats: [
        makeSeat({
          type: 'manual',
          callings: [],
          reason: 'primary',
          member_canonical: 'w@x.com',
          member_email: 'w@x.com',
          kindoo_site_id: null,
          duplicate_grants: [
            {
              scope: 'CO',
              type: 'manual',
              kindoo_site_id: null,
              reason: 'within',
              detected_at: NOW,
            },
          ],
        }),
      ],
      wards: [makeWard({ ward_code: 'CO' })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    const dupEdit = screen.getByTestId('seat-edit-w@x.com-dup-0');
    expect(dupEdit).toBeDisabled();
    expect(dupEdit.getAttribute('title')).toMatch(/covered by the primary's write/i);
  });

  // AC #8 (RTL slice): Remove on a duplicate row submits a request
  // with the duplicate's (scope, kindoo_site_id).
  it("AC #8: Remove on a parallel-site duplicate row submits a request with the grant's (scope, kindoo_site_id)", async () => {
    const user = userEvent.setup();
    mockAll({
      seats: [
        makeSeat({
          type: 'manual',
          callings: [],
          reason: 'primary',
          member_canonical: 'rm@x.com',
          member_email: 'rm@x.com',
          kindoo_site_id: null,
          duplicate_grants: [
            {
              scope: 'FN',
              type: 'manual',
              kindoo_site_id: 'foreign-1',
              building_names: ['Foreign Building'],
              detected_at: NOW,
            },
          ],
        }),
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wards: [makeWard({ ward_code: 'FN', kindoo_site_id: 'foreign-1' } as any)],
      buildings: [],
      kindooSites: [{ id: 'foreign-1', display_name: 'East Stake' }],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    await user.click(screen.getByTestId('remove-btn-rm@x.com-dup-0'));
    await user.type(screen.getByTestId('removal-reason'), 'no longer needed on FN');
    await user.click(screen.getByTestId('removal-confirm'));
    expect(submitMutate).toHaveBeenCalled();
    const payload = submitMutate.mock.calls[0]![0];
    expect(payload.type).toBe('remove');
    expect(payload.scope).toBe('FN');
    expect(payload.kindoo_site_id).toBe('foreign-1');
  });

  // AC #12: Reconcile button + ReconcileDialog removed.
  it("AC #12: Reconcile button doesn't render on duplicate rows", () => {
    mockAll({
      seats: [
        makeSeat({
          member_canonical: 'd@x.com',
          duplicate_grants: [{ scope: 'CO', type: 'manual', reason: 'extra', detected_at: NOW }],
        }),
      ],
      wards: [makeWard({ ward_code: 'CO' })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    expect(screen.queryByTestId('seat-reconcile-d@x.com')).toBeNull();
    expect(screen.queryByTestId('reconcile-dialog')).toBeNull();
  });

  // AC #13 — per-row pending-removal badge keyed to the grant.
  // Tested via the rosterPending unit tests (the partitioner is the
  // source of truth); here we just confirm AllSeats doesn't render a
  // stale shared badge.
});

describe('<AllSeatsPage /> — Kindoo Sites label (spec §15)', () => {
  it('renders the foreign-site badge on home-stake ward seats whose ward sits on a foreign Kindoo site (primary row)', () => {
    usePrincipalMock.mockReturnValue(principal({ stake: true, wards: ['FN'] }));
    mockAll({
      seats: [
        makeSeat({
          scope: 'FN',
          member_canonical: 'foreign@x.com',
          member_email: 'foreign@x.com',
          member_name: 'Foreign Person',
          type: 'manual',
          callings: [],
          kindoo_site_id: 'foreign-1',
        }),
      ],
      wards: [
        makeWard({
          ward_code: 'FN',
          ward_name: 'Foothills',
          kindoo_site_id: 'foreign-1',
        } as Partial<Ward>),
      ],
      buildings: [],
      kindooSites: [{ id: 'foreign-1', display_name: 'East Stake (Foothills)' }],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    expect(screen.getByTestId('kindoo-site-badge-foreign@x.com')).toHaveTextContent(
      'East Stake (Foothills)',
    );
  });

  it('omits the foreign-site badge on home-site ward seats', () => {
    usePrincipalMock.mockReturnValue(principal({ stake: true, wards: ['CO'] }));
    mockAll({
      seats: [
        makeSeat({
          scope: 'CO',
          member_canonical: 'home@x.com',
          member_email: 'home@x.com',
          member_name: 'Home Person',
          type: 'manual',
          callings: [],
        }),
      ],
      wards: [makeWard({ ward_code: 'CO' })],
      buildings: [],
      kindooSites: [{ id: 'foreign-1', display_name: 'East Stake (Foothills)' }],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    expect(screen.queryByTestId('kindoo-site-badge-home@x.com')).toBeNull();
  });
});
