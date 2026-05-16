// Component tests for the Stake Ward Rosters page.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccessRequest, Seat, Ward } from '@kindoo/shared';
import { makeRequest, makeSeat, makeWard } from '../../../test/fixtures';

const useStakeWardsMock = vi.fn();
const useWardSeatsMock = vi.fn();
const useKindooSitesMock = vi.fn();
const usePendingRequestsForScopeMock = vi.fn();
const usePendingRemoveRequestsMock = vi.fn();
const submitMutateAsyncMock = vi.fn();
const usePrincipalMock = vi.fn();
const navigateMock = vi.fn().mockResolvedValue(undefined);

vi.mock('./hooks', () => ({
  useStakeWards: () => useStakeWardsMock(),
  useWardSeats: (ward: string | null) => useWardSeatsMock(ward),
  useKindooSites: () => useKindooSitesMock(),
}));

// EditSeatDialog (mounted on Edit click) subscribes to stake-wide ward
// + building catalogues via the requests/hooks module. Stub them so
// the dialog can render without a real Firestore listener. The dialog
// has its own focused test file.
const stakeListResult = {
  data: [],
  error: null,
  status: 'success' as const,
  isPending: false,
  isLoading: false,
  isSuccess: true,
  isError: false,
  isFetching: false,
  fetchStatus: 'idle' as const,
};

vi.mock('../requests/hooks', () => ({
  usePendingRequestsForScope: (scope: string | null) => usePendingRequestsForScopeMock(scope),
  usePendingRemoveRequests: (canonical: string | null, scope: string | null) =>
    usePendingRemoveRequestsMock(canonical, scope),
  useSubmitRequest: () => ({ mutateAsync: submitMutateAsyncMock, isPending: false }),
  useStakeWards: () => stakeListResult,
  useStakeBuildings: () => stakeListResult,
}));

vi.mock('../../lib/principal', () => ({
  usePrincipal: () => usePrincipalMock(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

function principal(opts: { stake?: boolean; wards?: string[] } = {}): unknown {
  return {
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    email: 'user@example.com',
    canonical: 'user@example.com',
    isPlatformSuperadmin: false,
    managerStakes: [],
    stakeMemberStakes: opts.stake ? ['csnorth'] : [],
    bishopricWards: opts.wards ? { csnorth: opts.wards } : {},
    hasAnyRole: () => true,
    wardsInStake: () => opts.wards ?? [],
  };
}

function mockNoPendingRemoves() {
  usePendingRemoveRequestsMock.mockReturnValue({
    data: [],
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

function mockPendingRemoveFor(canonical: string) {
  usePendingRemoveRequestsMock.mockImplementation((c: string | null) => ({
    data: c === canonical ? [makeRequest({ type: 'remove', member_canonical: canonical })] : [],
    error: null,
    status: 'success',
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  }));
}

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
  // Default: no pending remove requests for any seat.
  mockNoPendingRemoves();
  // Default: empty Kindoo Sites catalogue. The badge tests below
  // override via mockKindooSites.
  useKindooSitesMock.mockReturnValue(stakeListResult);
  submitMutateAsyncMock.mockResolvedValue({ id: 'req-new' });
  // Default principal: bishopric of CO (the ward most tests target).
  // Tests that need a different authority shape override via
  // `usePrincipalMock.mockReturnValue(principal({...}))`.
  usePrincipalMock.mockReturnValue(principal({ wards: ['CO'] }));
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

  describe('per-row Remove affordance', () => {
    it('renders a Remove button next to every manual / temp seat', () => {
      mockWards([makeWard({ ward_code: 'CO', ward_name: 'Cordera', seat_cap: 20 })]);
      mockSeats([
        makeSeat({
          scope: 'CO',
          member_canonical: 'manual@x.com',
          member_email: 'manual@x.com',
          member_name: 'Manual Person',
          type: 'manual',
          callings: [],
        }),
        makeSeat({
          scope: 'CO',
          member_canonical: 'temp@x.com',
          member_email: 'temp@x.com',
          member_name: 'Temp Person',
          type: 'temp',
          callings: [],
          end_date: '2026-12-31',
        }),
      ]);
      render(<WardRostersPage initialWard="CO" />);
      expect(screen.getByTestId('remove-btn-manual@x.com')).toBeInTheDocument();
      expect(screen.getByTestId('remove-btn-temp@x.com')).toBeInTheDocument();
    });

    it('does not render a Remove button on auto seats', () => {
      mockWards([makeWard({ ward_code: 'CO', ward_name: 'Cordera', seat_cap: 20 })]);
      mockSeats([
        makeSeat({
          scope: 'CO',
          member_canonical: 'auto@x.com',
          member_email: 'auto@x.com',
          member_name: 'Auto Person',
          type: 'auto',
        }),
      ]);
      render(<WardRostersPage initialWard="CO" />);
      expect(screen.queryByTestId('remove-btn-auto@x.com')).toBeNull();
    });

    it('opens the removal confirmation dialog when Remove is clicked', async () => {
      const user = userEvent.setup();
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
      render(<WardRostersPage initialWard="CO" />);
      await user.click(screen.getByTestId('remove-btn-leaving@x.com'));
      expect(screen.getByTestId('removal-dialog-form')).toBeInTheDocument();
      expect(screen.getByTestId('removal-confirm')).toBeInTheDocument();
    });

    it('submits a remove request with the seat ward scope + member identity when confirmed', async () => {
      const user = userEvent.setup();
      mockWards([makeWard({ ward_code: 'CO', ward_name: 'Cordera', seat_cap: 20 })]);
      mockSeats([
        makeSeat({
          scope: 'CO',
          member_canonical: 'leaving@x.com',
          member_email: 'leaving@x.com',
          member_name: 'Leaving Soon',
          type: 'manual',
          callings: [],
          reason: 'sub teacher',
        }),
      ]);
      render(<WardRostersPage initialWard="CO" />);
      await user.click(screen.getByTestId('remove-btn-leaving@x.com'));
      await user.type(screen.getByTestId('removal-reason'), 'No longer needed');
      await user.click(screen.getByTestId('removal-confirm'));
      expect(submitMutateAsyncMock).toHaveBeenCalledTimes(1);
      expect(submitMutateAsyncMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'remove',
          scope: 'CO',
          member_email: 'leaving@x.com',
          member_name: 'Leaving Soon',
          reason: 'No longer needed',
        }),
      );
    });

    it('replaces the Remove button with a Removal pending badge once a remove is in flight', () => {
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
      mockPendingRemoveFor('leaving@x.com');
      render(<WardRostersPage initialWard="CO" />);
      expect(screen.queryByTestId('remove-btn-leaving@x.com')).toBeNull();
      expect(screen.getByTestId('removal-pending-leaving@x.com')).toBeInTheDocument();
    });

    it('mixes auto + manual + temp seats and renders the button only on the non-auto rows (regression for staging report 2026-05-03)', () => {
      mockWards([makeWard({ ward_code: 'CO', ward_name: 'Cordera', seat_cap: 20 })]);
      mockSeats([
        makeSeat({
          scope: 'CO',
          member_canonical: 'auto@x.com',
          member_email: 'auto@x.com',
          member_name: 'Auto Person',
          type: 'auto',
          callings: ['Bishop'],
        }),
        makeSeat({
          scope: 'CO',
          member_canonical: 'manual@x.com',
          member_email: 'manual@x.com',
          member_name: 'Manual Person',
          type: 'manual',
          callings: [],
          reason: 'sub teacher',
        }),
        makeSeat({
          scope: 'CO',
          member_canonical: 'temp@x.com',
          member_email: 'temp@x.com',
          member_name: 'Temp Person',
          type: 'temp',
          callings: [],
          start_date: '2026-05-01',
          end_date: '2026-12-31',
        }),
      ]);
      render(<WardRostersPage initialWard="CO" />);
      expect(screen.queryByTestId('remove-btn-auto@x.com')).toBeNull();
      expect(screen.getByTestId('remove-btn-manual@x.com')).toBeInTheDocument();
      expect(screen.getByTestId('remove-btn-temp@x.com')).toBeInTheDocument();
      for (const btn of [
        screen.getByTestId('remove-btn-manual@x.com'),
        screen.getByTestId('remove-btn-temp@x.com'),
      ]) {
        expect(btn).toBeVisible();
      }
    });

    it('hides the Remove button on rows whose scope the principal lacks authority for', () => {
      // Bishopric of CO viewing GE — out-of-authority. The pending-
      // removal badge / row class still need to render (read-only
      // signal), but no Remove button.
      usePrincipalMock.mockReturnValue(principal({ wards: ['CO'] }));
      mockWards([makeWard({ ward_code: 'GE', ward_name: 'Genoa', seat_cap: 20 })]);
      mockSeats([
        makeSeat({
          scope: 'GE',
          member_canonical: 'manual@x.com',
          member_email: 'manual@x.com',
          member_name: 'Manual Person',
          type: 'manual',
          callings: [],
        }),
      ]);
      render(<WardRostersPage initialWard="GE" />);
      expect(screen.queryByTestId('remove-btn-manual@x.com')).toBeNull();
    });

    it('renders the Remove button when the principal HAS authority for the scope (stake + multi-ward bishopric viewing one of those wards)', () => {
      usePrincipalMock.mockReturnValue(principal({ stake: true, wards: ['CO', 'GE'] }));
      mockWards([makeWard({ ward_code: 'GE', ward_name: 'Genoa', seat_cap: 20 })]);
      mockSeats([
        makeSeat({
          scope: 'GE',
          member_canonical: 'manual@x.com',
          member_email: 'manual@x.com',
          member_name: 'Manual Person',
          type: 'manual',
          callings: [],
        }),
      ]);
      render(<WardRostersPage initialWard="GE" />);
      expect(screen.getByTestId('remove-btn-manual@x.com')).toBeInTheDocument();
    });

    it('hides the Remove button for a stake-only principal viewing a ward roster (stake authority does not extend to wards)', () => {
      usePrincipalMock.mockReturnValue(principal({ stake: true }));
      mockWards([makeWard({ ward_code: 'CO', ward_name: 'Cordera', seat_cap: 20 })]);
      mockSeats([
        makeSeat({
          scope: 'CO',
          member_canonical: 'manual@x.com',
          member_email: 'manual@x.com',
          member_name: 'Manual Person',
          type: 'manual',
          callings: [],
        }),
      ]);
      render(<WardRostersPage initialWard="CO" />);
      expect(screen.queryByTestId('remove-btn-manual@x.com')).toBeNull();
    });
  });

  describe('per-row Edit affordance', () => {
    it('renders an Edit button on every ward-scope seat (including auto) for a stake-only user', () => {
      // A stake user can edit ward-scope auto seats per the policy
      // table — only stake-scope auto is the locked-out case.
      usePrincipalMock.mockReturnValue(principal({ stake: true, wards: ['CO'] }));
      mockWards([makeWard({ ward_code: 'CO', ward_name: 'Cordera', seat_cap: 20 })]);
      mockSeats([
        makeSeat({
          scope: 'CO',
          member_canonical: 'auto@x.com',
          member_email: 'auto@x.com',
          member_name: 'Auto Person',
          type: 'auto',
          callings: ['Bishop'],
        }),
        makeSeat({
          scope: 'CO',
          member_canonical: 'manual@x.com',
          member_email: 'manual@x.com',
          member_name: 'Manual Person',
          type: 'manual',
          callings: [],
        }),
        makeSeat({
          scope: 'CO',
          member_canonical: 'temp@x.com',
          member_email: 'temp@x.com',
          member_name: 'Temp Person',
          type: 'temp',
          callings: [],
          start_date: '2026-05-01',
          end_date: '2026-12-31',
        }),
      ]);
      render(<WardRostersPage initialWard="CO" />);
      expect(screen.getByTestId('edit-btn-auto@x.com')).toBeInTheDocument();
      expect(screen.getByTestId('edit-btn-manual@x.com')).toBeInTheDocument();
      expect(screen.getByTestId('edit-btn-temp@x.com')).toBeInTheDocument();
    });

    it('hides the Edit button on rows whose scope the principal lacks authority for', () => {
      usePrincipalMock.mockReturnValue(principal({ wards: ['CO'] }));
      mockWards([makeWard({ ward_code: 'GE', ward_name: 'Genoa', seat_cap: 20 })]);
      mockSeats([
        makeSeat({
          scope: 'GE',
          member_canonical: 'manual@x.com',
          member_email: 'manual@x.com',
          member_name: 'Manual Person',
          type: 'manual',
          callings: [],
        }),
      ]);
      render(<WardRostersPage initialWard="GE" />);
      expect(screen.queryByTestId('edit-btn-manual@x.com')).toBeNull();
    });
  });
});

describe('<WardRostersPage /> — Kindoo Sites label (spec §15)', () => {
  function mockKindooSites(sites: Array<{ id: string; display_name: string }>) {
    useKindooSitesMock.mockReturnValue({
      data: sites.map((s) => ({
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

  it('renders the foreign-site badge on a seat whose ward.kindoo_site_id points at a foreign site', () => {
    mockWards([
      makeWard({
        ward_code: 'FN',
        ward_name: 'Foothills',
        seat_cap: 20,
        kindoo_site_id: 'foreign-1',
      } as Partial<Ward>),
    ]);
    mockSeats([
      makeSeat({
        scope: 'FN',
        member_canonical: 'a@x.com',
        member_email: 'a@x.com',
        member_name: 'Alpha',
      }),
    ]);
    mockKindooSites([{ id: 'foreign-1', display_name: 'East Stake (Foothills)' }]);
    render(<WardRostersPage initialWard="FN" />);
    expect(screen.getByTestId('kindoo-site-badge-a@x.com')).toHaveTextContent(
      'East Stake (Foothills)',
    );
  });

  it('omits the badge when the ward is on the home site', () => {
    mockWards([makeWard({ ward_code: 'CO', ward_name: 'Cordera', seat_cap: 20 })]);
    mockSeats([
      makeSeat({
        scope: 'CO',
        member_canonical: 'a@x.com',
        member_email: 'a@x.com',
        member_name: 'Alpha',
      }),
    ]);
    mockKindooSites([{ id: 'foreign-1', display_name: 'East Stake (Foothills)' }]);
    render(<WardRostersPage initialWard="CO" />);
    expect(screen.queryByTestId('kindoo-site-badge-a@x.com')).toBeNull();
  });
});
