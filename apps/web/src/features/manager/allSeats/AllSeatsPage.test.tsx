// Component tests for the manager All Seats page. Phase B (T-43):
// multi-row rendering — one row per grant (primary + each
// `duplicate_grants[]` entry). All Seats is view-only for edits (no
// edit affordance); Remove on a row submits a `remove` request scoped
// to the grant's `(scope, kindoo_site_id)`.

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
const submitMutate = vi.fn().mockResolvedValue({ id: 'req-new' });
const navigateMock = vi.fn().mockResolvedValue(undefined);

vi.mock('./hooks', () => ({
  useAllSeats: () => useAllSeatsMock(),
  useWards: () => useWardsMock(),
  useBuildings: () => useBuildingsMock(),
  useKindooSites: () => useKindooSitesMock(),
}));

vi.mock('../dashboard/hooks', () => ({
  useStakeDoc: () => useStakeDocMock(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

const useStakeBuildingsMock = vi.fn();

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
  useStakeBuildings: () => useStakeBuildingsMock(),
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

function makeBuilding(building_name: string, kindoo_site_id: string | null): Building {
  const stamp = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
  return {
    building_id: building_name.toLowerCase().replace(/\s+/g, '-'),
    building_name,
    address: '',
    kindoo_site_id,
    created_at: stamp,
    last_modified_at: stamp,
    lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
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
  useStakeBuildingsMock.mockReturnValue(liveResult([]));
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

  it('lays the card header out over two lines: badges + actions on line 1, member on its own line', () => {
    mockAll({
      seats: [
        makeSeat({
          type: 'manual',
          callings: [],
          reason: 'r',
          scope: 'CO',
        }),
      ],
      wards: [makeWard({ ward_code: 'CO' })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    const card = document.querySelector('.roster-card');
    expect(card).toHaveClass('roster-card--two-line');
    // The member name/email lives in its own line below line1, not inside it.
    const memberLine = card?.querySelector('.roster-card-member-line');
    expect(memberLine).not.toBeNull();
    expect(memberLine?.querySelector('.roster-card-member')).not.toBeNull();
    expect(card?.querySelector('.roster-card-line1 .roster-card-member')).toBeNull();
    // The Remove action button stays on line 1, right of the badges.
    // (All Seats has no Edit affordance — Remove is the only action.)
    expect(
      card?.querySelector('.roster-card-line1 .roster-card-actions [data-testid^="remove-btn-"]'),
    ).not.toBeNull();
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
    expect(host).toHaveTextContent(/Maple utilization/);
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
        makeWard({ ward_code: 'CO', seat_cap: 20, building_name: 'Home Building' }),
        makeWard({ ward_code: 'FN', seat_cap: 20, building_name: 'Foreign Building' }),
      ],
      buildings: [
        makeBuilding('Home Building', null),
        makeBuilding('Foreign Building', 'east-stake'),
      ],
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

  it('renders no edit affordance on All Seats — even on a manual seat — while keeping Remove', () => {
    usePrincipalMock.mockReturnValue(principal({ wards: ['CO'] }));
    mockAll({
      seats: [
        makeSeat({
          scope: 'CO',
          type: 'manual',
          member_canonical: 'm@x.com',
          member_email: 'm@x.com',
          callings: [],
          reason: 'covering bishop',
        }),
      ],
      wards: [makeWard({ ward_code: 'CO' })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    // No edit affordance anywhere — editing is roster-only now.
    expect(screen.queryByTestId(/^seat-edit-/)).toBeNull();
    const card = document.querySelector('.roster-card');
    expect(card?.querySelector('.roster-card-actions button')).not.toBeNull();
    expect(card?.textContent).not.toMatch(/\bEdit\b/);
    // Remove affordance still renders.
    expect(screen.getByTestId('remove-btn-m@x.com')).toBeInTheDocument();
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

  it('excludes foreign-site ward caps (resolved via the ward building) from the Stake-scope pool denominator', () => {
    // 200 - 50 (CO, home) - 0 (FN, foreign) = 150.
    mockAll({
      seats: [makeSeat({ scope: 'stake' })],
      wards: [
        makeWard({ ward_code: 'CO', seat_cap: 50, building_name: 'Home Building' }),
        makeWard({ ward_code: 'FN', seat_cap: 50, building_name: 'Foreign Building' }),
      ],
      buildings: [
        makeBuilding('Home Building', null),
        makeBuilding('Foreign Building', 'east-stake'),
      ],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage initialWard="stake" />);
    const host = screen.getByTestId('allseats-utilization');
    expect(host).toHaveTextContent(/1 \/ 150 seats used/);
  });

  // Cross-scope sort regression for the new Phase B
  // `sortGrantRowsAcrossScopes` shape: stake band first, then ward
  // bands alpha; within each band auto → manual → temp.
  it('sorts cross-scope grant-rows: stake first, then wards alpha; type-banded inside each scope', () => {
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

  it('orders the manual band by reason→calling (consistent with the roster comparator)', () => {
    // Within a single ward scope so scope-banding does not dominate.
    // Manual seats carry callings: [] and store the calling in reason.
    // Names are reverse-alpha to the calling order to prove the sort is
    // by reason-calling, not by name.
    mockAll({
      seats: [
        makeSeat({
          scope: 'CO',
          type: 'manual',
          callings: [],
          reason: 'Elders Quorum President', // order 41
          member_canonical: 'aaron@x.com',
          member_email: 'aaron@x.com',
          member_name: 'Aaron Manual',
        }),
        makeSeat({
          scope: 'CO',
          type: 'manual',
          callings: [],
          reason: 'Bishop', // order 31 — leads
          member_canonical: 'zach@x.com',
          member_email: 'zach@x.com',
          member_name: 'Zach Manual',
        }),
      ],
      wards: [makeWard({ ward_code: 'CO' })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage initialWard="CO" />);
    const cards = Array.from(document.querySelectorAll('.roster-card'));
    const order = cards.map((c) => c.getAttribute('data-seat-id'));
    expect(order).toEqual(['zach@x.com', 'aaron@x.com']);
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

  // Per-grant Remove authority gate — symmetric with `isScopeAllowed`.
  // The button only renders on rows whose grant's scope the principal
  // has authority for. Same predicate as today; what's new is the
  // gate keys off the grant (per-row), not the seat's primary.
  describe('per-row Remove affordance — symmetric authority gate', () => {
    it('renders the Remove button on manual / temp rows whose scope the principal has authority for', () => {
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

    it('hides the Remove button on rows whose grant scope the principal lacks authority for', () => {
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

    // Phase B-specific: per-grant gate means the button can appear on
    // a duplicate row when the principal has authority for the
    // duplicate's scope even if they lack authority for the seat's
    // primary scope.
    it('renders Remove on a duplicate row when the principal has authority for the duplicate scope (not the primary)', () => {
      usePrincipalMock.mockReturnValue(principal({ wards: ['CO'] }));
      const NOW = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
      mockAll({
        seats: [
          makeSeat({
            scope: 'GE',
            type: 'manual',
            callings: [],
            member_canonical: 'cross@x.com',
            member_email: 'cross@x.com',
            duplicate_grants: [
              { scope: 'CO', type: 'manual', kindoo_site_id: null, detected_at: NOW },
            ],
          }),
        ],
        wards: [makeWard({ ward_code: 'CO' }), makeWard({ ward_code: 'GE' })],
        buildings: [],
        stake: { stake_seat_cap: 200 },
      });
      render(<AllSeatsPage />);
      // No Remove on the GE primary row (no authority for GE).
      expect(screen.queryByTestId('remove-btn-cross@x.com')).toBeNull();
      // Remove DOES render on the CO duplicate row (authority for CO).
      expect(screen.getByTestId('remove-btn-cross@x.com-dup-0')).toBeInTheDocument();
    });
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

  // Same-scope DuplicateGrants on a single seat collapse into ONE row
  // (primary's row), with the union of their buildings and the
  // same-scope-duplicate badge whose tooltip is operator-facing. The
  // label follows the primary's type: auto → "edited" (this seat),
  // manual/temp → "duplicate". Replaces the previous AC #2 "renders its
  // own row" behaviour — that surface confused operators.
  it('collapses a same-scope within-site DuplicateGrant into the primary row with the Edited badge (auto primary)', () => {
    mockAll({
      seats: [
        makeSeat({
          scope: 'CO',
          kindoo_site_id: null,
          building_names: ['Primary Building'],
          duplicate_grants: [
            {
              scope: 'CO',
              type: 'manual',
              kindoo_site_id: null,
              reason: 'extra',
              building_names: ['Extra Building'],
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
    const cards = document.querySelectorAll('.roster-card[data-seat-id="alice@example.com"]');
    expect(cards).toHaveLength(1);
    // Buildings on the collapsed row are the union of the primary's
    // and the same-scope duplicate's.
    const row = cards[0] as HTMLElement;
    expect(row.textContent).toContain('Primary Building');
    expect(row.textContent).toContain('Extra Building');
    // Edited badge (auto primary) present on the collapsed row with the
    // unified operator-facing tooltip copy.
    const badge = screen.getByTestId('grant-duplicate-badge-alice@example.com');
    expect(badge.textContent).toBe('edited');
    expect(badge.getAttribute('title')).toBe(
      'This user was manually granted access to additional buildings.',
    );
  });

  // Operator-reported repro: primary auto MH + manual MH DuplicateGrant
  // with overlapping buildings. Pre-fix: two rows. Post-fix: one row
  // with the union of buildings + the Edited badge (auto primary).
  it('collapses an auto-primary + manual-same-scope dup into one row with union buildings', () => {
    mockAll({
      seats: [
        makeSeat({
          scope: 'MH',
          type: 'auto',
          callings: ['Bishop'],
          member_canonical: 'user2@example.com',
          member_email: 'user2@example.com',
          member_name: 'Test User Two',
          kindoo_site_id: null,
          building_names: ['Jamboree'],
          duplicate_grants: [
            {
              scope: 'MH',
              type: 'manual',
              kindoo_site_id: null,
              reason: 'Activities Committee Chair',
              building_names: ['Lexington', 'Jamboree', 'Monument'],
              detected_at: NOW,
            },
          ],
        }),
      ],
      wards: [makeWard({ ward_code: 'MH', ward_name: 'Manitou' })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    const cards = document.querySelectorAll('.roster-card[data-seat-id="user2@example.com"]');
    expect(cards).toHaveLength(1);
    const row = cards[0] as HTMLElement;
    // Union, primary-first order: Jamboree, then Lexington, then Monument.
    expect(row.textContent).toContain('Jamboree');
    expect(row.textContent).toContain('Lexington');
    expect(row.textContent).toContain('Monument');
    // Edited badge (auto primary) + unified operator-facing tooltip.
    const badge = screen.getByTestId('grant-duplicate-badge-user2@example.com');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toBe('edited');
    expect(badge.getAttribute('title')).toBe(
      'This user was manually granted access to additional buildings.',
    );
  });

  // Regression guard: cross-scope DuplicateGrants are out of scope for
  // the collapse and continue to render as their own rows.
  it('cross-scope DuplicateGrant still renders as its own row (collapse only fires within a scope)', () => {
    mockAll({
      seats: [
        makeSeat({
          scope: 'stake',
          member_canonical: 'cross-scope@x.com',
          member_email: 'cross-scope@x.com',
          duplicate_grants: [{ scope: 'CO', type: 'manual', reason: 'extra', detected_at: NOW }],
        }),
      ],
      wards: [makeWard({ ward_code: 'CO' })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    const cards = document.querySelectorAll('.roster-card[data-seat-id="cross-scope@x.com"]');
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

  // T-43 follow-up: a parallel-site duplicate without its own
  // `building_names` (legacy / pre-migration shape) MUST NOT inherit
  // the seat's home-site building_names — those are on a different
  // Kindoo site. Empty list is the correct graceful-degradation shape.
  it('parallel-site duplicate without building_names does not leak home buildings onto the foreign-site row', () => {
    mockAll({
      seats: [
        makeSeat({
          scope: 'stake',
          kindoo_site_id: null,
          member_canonical: 'leak-canary@x.com',
          member_email: 'leak-canary@x.com',
          building_names: ['Home Building'],
          duplicate_grants: [
            // Parallel-site duplicate WITHOUT building_names — the
            // legacy edge case the fix targets.
            {
              scope: 'FN',
              type: 'manual',
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
    // Primary (home-site) row carries its home buildings.
    const primaryRow = document.querySelector(
      '[data-row-key="leak-canary@x.com/pri"]',
    ) as HTMLElement;
    expect(primaryRow).not.toBeNull();
    expect(primaryRow.textContent).toContain('Home Building');
    // Foreign-site duplicate row MUST NOT carry the primary's home
    // buildings — that would be wrong data on the foreign-site row.
    const dupRow = document.querySelector(
      '[data-row-key="leak-canary@x.com/dup-0"]',
    ) as HTMLElement;
    expect(dupRow).not.toBeNull();
    expect(dupRow.textContent).not.toContain('Home Building');
    // The Buildings chip itself should be omitted entirely (empty
    // list → no chip rendered) so the row degrades gracefully — no
    // label with "Buildings:" anywhere on the duplicate row.
    const labels = Array.from(dupRow.querySelectorAll('.roster-card-chip .label')).map(
      (n) => n.textContent,
    );
    expect(labels).not.toContain('Buildings:');
  });

  // The collapsed row IS the primary; a within-site DuplicateGrant
  // collapses onto it. All Seats has no Edit affordance, so we assert
  // only the collapse + Duplicate badge here (Edit behaviour is covered
  // on the roster pages).
  it('within-site DuplicateGrant collapses onto the primary row → no edit affordance, badge present', () => {
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
    // No standalone duplicate row, and no edit affordance anywhere.
    expect(document.querySelectorAll('.roster-card[data-seat-id="w@x.com"]')).toHaveLength(1);
    expect(screen.queryByTestId(/^seat-edit-/)).toBeNull();
    // Duplicate badge (manual primary → "duplicate") with the unified tooltip.
    const badge = screen.getByTestId('grant-duplicate-badge-w@x.com');
    expect(badge.textContent).toBe('duplicate');
    expect(badge.getAttribute('title')).toBe(
      'This user was manually granted access to additional buildings.',
    );
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

  // Same-(scope, kindoo_site_id) non-auto duplicate under a non-auto
  // primary now collapses into the primary row, so there is no
  // duplicate row to carry a Remove affordance. The primary row's
  // Remove still works (non-auto primary). Pre-collapse this guarded
  // against the trigger demoting/removing the wrong grant (spec §412 /
  // §425); post-collapse the surface simply doesn't exist.
  it('within-site non-auto duplicate under non-auto primary: collapses into one row, primary Remove preserved', () => {
    mockAll({
      seats: [
        makeSeat({
          type: 'manual',
          callings: [],
          reason: 'pri-reason',
          scope: 'CO',
          kindoo_site_id: null,
          member_canonical: 'inform@x.com',
          member_email: 'inform@x.com',
          duplicate_grants: [
            {
              scope: 'CO',
              type: 'temp',
              kindoo_site_id: null,
              reason: 'within-site temp dup',
              building_names: ['CO Building'],
              start_date: '2026-06-01',
              end_date: '2026-06-15',
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
    // Primary row: Remove shown (non-auto primary).
    expect(screen.getByTestId('remove-btn-inform@x.com')).toBeInTheDocument();
    // Duplicate row: Remove hidden (same scope + site, can't
    // disambiguate from the primary in the trigger).
    expect(screen.queryByTestId('remove-btn-inform@x.com-dup-0')).toBeNull();
  });

  // KS-9 surface: within-site manual DuplicateGrant under an auto
  // primary. Post-collapse there is no standalone duplicate row, so
  // the previous duplicate-row Remove affordance is gone. The
  // collapsed row IS the auto primary (Remove always hidden on auto),
  // so this surface no longer offers a Remove path for the manual
  // dup. Operator-accepted as part of the render-only collapse fix —
  // the dup row was the only existing reachable surface. If a future
  // need arises, the affordance can be promoted onto the collapsed
  // row gated on `hasSameScopeDuplicates`.
  it('Fix 3 / KS-9: auto primary + same-scope manual dup collapses to one row with the Edited badge, no Remove', () => {
    mockAll({
      seats: [
        makeSeat({
          type: 'auto',
          callings: ['Bishop'],
          scope: 'CO',
          kindoo_site_id: null,
          member_canonical: 'ks9@x.com',
          member_email: 'ks9@x.com',
          building_names: ['Primary Building'],
          duplicate_grants: [
            {
              scope: 'CO',
              type: 'manual',
              kindoo_site_id: null,
              reason: 'within-site dup',
              building_names: ['CO Building'],
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
    const cards = document.querySelectorAll('.roster-card[data-seat-id="ks9@x.com"]');
    expect(cards).toHaveLength(1);
    // Edited badge present with the unified tooltip copy. The per-type
    // rule (auto → "edited") applies on every surface, AllSeats included.
    const badge = screen.getByTestId('grant-duplicate-badge-ks9@x.com');
    expect(badge.textContent).toBe('edited');
    expect(badge.getAttribute('title')).toBe(
      'This user was manually granted access to additional buildings.',
    );
    // Union of buildings rendered on the row.
    const row = cards[0] as HTMLElement;
    expect(row.textContent).toContain('Primary Building');
    expect(row.textContent).toContain('CO Building');
    // No Remove on the auto primary; no duplicate row.
    expect(screen.queryByTestId('remove-btn-ks9@x.com')).toBeNull();
    expect(screen.queryByTestId('remove-btn-ks9@x.com-dup-0')).toBeNull();
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

  // AC #5 (AllSeats slice): the per-ward / stake-scope utilization
  // bar widens to count seats whose primary OR any duplicate_scopes
  // entry matches the filter — same predicate as Dashboard
  // `countSeatsForScope`.
  it('AC #5: utilization counts a stake-primary seat whose duplicate is CO on the CO bar', () => {
    mockAll({
      seats: [
        makeSeat({
          scope: 'stake',
          member_canonical: 'cross@x.com',
          member_email: 'cross@x.com',
          duplicate_grants: [{ scope: 'CO', type: 'auto', detected_at: NOW }],
          // Phase A maintains duplicate_scopes; the widened count
          // reads it directly.
          duplicate_scopes: ['CO'],
        }),
      ],
      wards: [makeWard({ ward_code: 'CO', seat_cap: 20 })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage initialWard="CO" />);
    const host = screen.getByTestId('allseats-utilization');
    // CO bar: 1 (from the duplicate match), not 0.
    expect(host).toHaveTextContent(/1 \/ 20 seats used/);
  });

  it("AC #5: same-scope within-site duplicate doesn't double-count on the same ward bar", () => {
    mockAll({
      seats: [
        makeSeat({
          scope: 'CO',
          member_canonical: 'within@x.com',
          member_email: 'within@x.com',
          duplicate_grants: [{ scope: 'CO', type: 'manual', detected_at: NOW }],
          duplicate_scopes: ['CO'],
        }),
      ],
      wards: [makeWard({ ward_code: 'CO', seat_cap: 20 })],
      buildings: [],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage initialWard="CO" />);
    const host = screen.getByTestId('allseats-utilization');
    expect(host).toHaveTextContent(/1 \/ 20 seats used/);
  });
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
          ward_name: 'Pine',
          kindoo_site_id: 'foreign-1',
        } as Partial<Ward>),
      ],
      buildings: [],
      kindooSites: [{ id: 'foreign-1', display_name: 'East Stake (Pine)' }],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    expect(screen.getByTestId('kindoo-site-badge-foreign@x.com')).toHaveTextContent(
      'East Stake (Pine)',
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
      kindooSites: [{ id: 'foreign-1', display_name: 'East Stake (Pine)' }],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    expect(screen.queryByTestId('kindoo-site-badge-home@x.com')).toBeNull();
  });
});

describe('<AllSeatsPage /> — Give Access To Stake Buildings button', () => {
  // A foreign-site-only member: FN ward sits on a foreign Kindoo site.
  function foreignSiteOnlySeat() {
    return makeSeat({
      scope: 'FN',
      type: 'manual',
      callings: [],
      member_canonical: 'foreign@x.com',
      member_email: 'foreign@x.com',
      member_name: 'Foreign Member',
      kindoo_site_id: 'east-stake',
    });
  }

  const FOREIGN_FIXTURE = {
    wards: [
      makeWard({ ward_code: 'CO', building_name: 'Home Building' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeWard({
        ward_code: 'FN',
        building_name: 'Foreign Building',
        kindoo_site_id: 'east-stake',
      } as any),
    ],
    buildings: [
      makeBuilding('Home Building', null),
      makeBuilding('Foreign Building', 'east-stake'),
    ],
    kindooSites: [{ id: 'east-stake', display_name: 'East Stake' }],
    stake: { stake_seat_cap: 200 },
  };

  it('shows the button for a manager on a foreign-site-only member', () => {
    usePrincipalMock.mockReturnValue(principal({}));
    mockAll({ seats: [foreignSiteOnlySeat()], ...FOREIGN_FIXTURE });
    render(<AllSeatsPage />);
    expect(screen.getByTestId('grant-stake-access-btn-foreign@x.com')).toBeInTheDocument();
  });

  it('hides the button for a non-manager (stake/bishopric only)', () => {
    usePrincipalMock.mockReturnValue({
      isAuthenticated: true,
      firebaseAuthSignedIn: true,
      email: 'b@example.com',
      canonical: 'b@example.com',
      isPlatformSuperadmin: false,
      managerStakes: [],
      stakeMemberStakes: ['csnorth'],
      bishopricWards: { csnorth: ['FN'] },
      hasAnyRole: () => true,
      wardsInStake: () => ['FN'],
    });
    mockAll({ seats: [foreignSiteOnlySeat()], ...FOREIGN_FIXTURE });
    render(<AllSeatsPage />);
    expect(screen.queryByTestId('grant-stake-access-btn-foreign@x.com')).toBeNull();
  });

  it('hides the button for a member with a home-site (CO) grant', () => {
    usePrincipalMock.mockReturnValue(principal({}));
    mockAll({
      seats: [
        makeSeat({
          scope: 'CO',
          type: 'manual',
          callings: [],
          member_canonical: 'home@x.com',
          member_email: 'home@x.com',
          kindoo_site_id: null,
        }),
      ],
      ...FOREIGN_FIXTURE,
    });
    render(<AllSeatsPage />);
    expect(screen.queryByTestId('grant-stake-access-btn-home@x.com')).toBeNull();
  });

  it('hides the button for a member who already has a stake-scope grant', () => {
    usePrincipalMock.mockReturnValue(principal({}));
    mockAll({
      seats: [
        makeSeat({
          scope: 'stake',
          type: 'manual',
          callings: [],
          member_canonical: 'stake@x.com',
          member_email: 'stake@x.com',
          kindoo_site_id: null,
        }),
      ],
      ...FOREIGN_FIXTURE,
    });
    render(<AllSeatsPage />);
    expect(screen.queryByTestId('grant-stake-access-btn-stake@x.com')).toBeNull();
  });

  it('hides the button when a foreign member also has a stake-scope duplicate grant', () => {
    usePrincipalMock.mockReturnValue(principal({}));
    const seat = foreignSiteOnlySeat();
    seat.duplicate_grants = [
      { scope: 'stake', type: 'manual', kindoo_site_id: null, detected_at: NOW },
    ];
    mockAll({ seats: [seat], ...FOREIGN_FIXTURE });
    render(<AllSeatsPage />);
    expect(screen.queryByTestId('grant-stake-access-btn-foreign@x.com')).toBeNull();
  });

  it('renders the button only once per member (primary row), not on duplicate rows', () => {
    usePrincipalMock.mockReturnValue(principal({}));
    const seat = foreignSiteOnlySeat();
    // A second foreign-site grant on a different foreign site → two rows,
    // but the button should appear only on the primary row.
    seat.duplicate_grants = [
      {
        scope: 'FN',
        type: 'manual',
        kindoo_site_id: 'west-stake',
        building_names: ['West Building'],
        detected_at: NOW,
      },
    ];
    mockAll({
      seats: [seat],
      wards: FOREIGN_FIXTURE.wards,
      buildings: [
        makeBuilding('Home Building', null),
        makeBuilding('Foreign Building', 'east-stake'),
        makeBuilding('West Building', 'west-stake'),
      ],
      kindooSites: [
        { id: 'east-stake', display_name: 'East Stake' },
        { id: 'west-stake', display_name: 'West Stake' },
      ],
      stake: { stake_seat_cap: 200 },
    });
    render(<AllSeatsPage />);
    expect(screen.getAllByTestId('grant-stake-access-btn-foreign@x.com')).toHaveLength(1);
  });

  it('opens the dialog and submits an add_manual / scope:"stake" request', async () => {
    const user = userEvent.setup();
    usePrincipalMock.mockReturnValue(principal({}));
    useStakeBuildingsMock.mockReturnValue(liveResult([makeBuilding('Home Building', null)]));
    mockAll({ seats: [foreignSiteOnlySeat()], ...FOREIGN_FIXTURE });
    render(<AllSeatsPage />);
    await user.click(screen.getByTestId('grant-stake-access-btn-foreign@x.com'));
    await user.type(screen.getByTestId('grant-stake-access-reason'), 'Stake helper');
    await user.click(screen.getByTestId('grant-stake-access-building-home-building'));
    await user.click(screen.getByTestId('grant-stake-access-confirm'));
    expect(submitMutate).toHaveBeenCalled();
    const payload = submitMutate.mock.calls[0]![0];
    expect(payload.type).toBe('add_manual');
    expect(payload.scope).toBe('stake');
    expect(payload.member_email).toBe('foreign@x.com');
    expect(payload.building_names).toEqual(['Home Building']);
  });
});
