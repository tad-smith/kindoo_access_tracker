// Component tests for the Bishopric Roster page. Mocks the data hooks
// + `usePrincipal` so the test exercises just the rendering shape:
//   - empty state copy when no seats are returned
//   - seat cards rendered for the active ward
//   - utilization bar reflects the count and the ward's seat_cap
//   - ward dropdown appears iff the principal has 2+ wards
//
// We don't go through TanStack Router here — the page accepts an
// `initialWard` prop that the route file forwards from the URL. That
// keeps the unit test boundary aligned with the component's contract.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccessRequest, Seat, Ward } from '@kindoo/shared';
import { makeRequest, makeSeat, makeWard } from '../../../test/fixtures';

const usePrincipalMock = vi.fn();
const useBishopricRosterMock = vi.fn();
const useFirestoreOnceMock = vi.fn();
const usePendingRequestsForScopeMock = vi.fn();
const usePendingRemoveRequestsMock = vi.fn();
const useStakeWardsMock = vi.fn();
const useKindooSitesMock = vi.fn();
const submitMutateAsyncMock = vi.fn();
// Real navigate returns a Promise; the page calls `.catch(...)` on it.
const navigateMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../lib/principal', () => ({
  usePrincipal: () => usePrincipalMock(),
}));

// RemovalAffordance subscribes via the requests hooks; mock so we
// don't need a real QueryClient / Firestore listener.
// EditSeatDialog (mounted on Edit click) subscribes to stake-wide ward
// + building catalogues; stub them so the dialog can render without a
// real Firestore listener. We don't assert on those reads in this
// file — the dialog has its own focused test.
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

vi.mock('./hooks', () => ({
  useBishopricRoster: (ward: string | null) => useBishopricRosterMock(ward),
  useStakeWards: () => useStakeWardsMock(),
  useKindooSites: () => useKindooSitesMock(),
}));

vi.mock('../../lib/data', () => ({
  useFirestoreOnce: (ref: unknown) => useFirestoreOnceMock(ref),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

vi.mock('../requests/hooks', () => ({
  usePendingRemoveRequests: (canonical: string | null, scope: string | null) =>
    usePendingRemoveRequestsMock(canonical, scope),
  usePendingRequestsForScope: (scope: string | null) => usePendingRequestsForScopeMock(scope),
  useSubmitRequest: () => ({ mutateAsync: submitMutateAsyncMock, isPending: false }),
  useStakeWards: () => stakeListResult,
  useStakeBuildings: () => stakeListResult,
}));

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

import { BishopricRosterPage } from './RosterPage';

function principal(wards: string[]) {
  return {
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    email: 'bishop@example.com',
    canonical: 'bishop@example.com',
    isPlatformSuperadmin: false,
    managerStakes: [],
    stakeMemberStakes: [],
    bishopricWards: { csnorth: wards },
    hasAnyRole: () => true,
    wardsInStake: () => wards,
  };
}

function mockSeats(seats: Seat[] | undefined, isLoading = false) {
  useBishopricRosterMock.mockReturnValue({
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

function mockWardDoc(ward: Ward | undefined) {
  useFirestoreOnceMock.mockReturnValue({
    data: ward,
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
  navigateMock.mockResolvedValue(undefined);
  // Default: no pending requests. Tests that exercise the new
  // pending-roster surfaces override via mockPendingRequests.
  mockPendingRequests([]);
  // Default: no pending remove requests for any seat (the per-row
  // RemovalAffordance subscription).
  mockNoPendingRemoves();
  // Default: empty wards / Kindoo Sites catalogues. The Kindoo-site
  // badge tests override via mockStakeWards / mockKindooSites.
  useStakeWardsMock.mockReturnValue(stakeListResult);
  useKindooSitesMock.mockReturnValue(stakeListResult);
  submitMutateAsyncMock.mockResolvedValue({ id: 'req-new' });
});

describe('<BishopricRosterPage />', () => {
  it('renders the empty-state copy when the ward has no seats', () => {
    usePrincipalMock.mockReturnValue(principal(['CO']));
    mockSeats([]);
    mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
    render(<BishopricRosterPage />);
    expect(screen.getByText(/no seats assigned to this ward/i)).toBeInTheDocument();
  });

  it('renders a seat card per row in the order returned', () => {
    usePrincipalMock.mockReturnValue(principal(['CO']));
    mockSeats([
      makeSeat({ member_canonical: 'a@x.com', member_email: 'a@x.com', member_name: 'Alpha' }),
      makeSeat({ member_canonical: 'b@x.com', member_email: 'b@x.com', member_name: 'Bravo' }),
    ]);
    mockWardDoc(makeWard({ seat_cap: 20 }));
    render(<BishopricRosterPage />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Bravo')).toBeInTheDocument();
  });

  it('shows the ward picker only when the principal holds 2+ bishopric wards', () => {
    usePrincipalMock.mockReturnValue(principal(['CO']));
    mockSeats([]);
    mockWardDoc(makeWard({ seat_cap: 20 }));
    const { rerender } = render(<BishopricRosterPage />);
    expect(screen.queryByLabelText(/^Ward:/)).toBeNull();

    usePrincipalMock.mockReturnValue(principal(['CO', 'GE']));
    mockSeats([]);
    mockWardDoc(makeWard({ seat_cap: 20 }));
    rerender(<BishopricRosterPage />);
    expect(screen.getByLabelText(/^Ward:/)).toBeInTheDocument();
  });

  it('switches the active ward when the picker changes (multi-ward bishopric)', async () => {
    const user = userEvent.setup();
    usePrincipalMock.mockReturnValue(principal(['CO', 'GE']));
    mockSeats([]);
    mockWardDoc(makeWard({ seat_cap: 20 }));
    render(<BishopricRosterPage initialWard="CO" />);
    const select = screen.getByLabelText(/^Ward:/);
    await user.selectOptions(select, 'GE');
    // The hook is called with the new ward at least once.
    expect(useBishopricRosterMock).toHaveBeenCalledWith('GE');
    expect(navigateMock).toHaveBeenCalled();
  });

  it('renders a utilization bar with seat_cap from the ward doc', () => {
    usePrincipalMock.mockReturnValue(principal(['CO']));
    mockSeats([makeSeat(), makeSeat({ member_canonical: 'b@x.com', member_email: 'b@x.com' })]);
    mockWardDoc(makeWard({ seat_cap: 10 }));
    render(<BishopricRosterPage />);
    expect(screen.getByText(/2 \/ 10 seats used/)).toBeInTheDocument();
  });

  it('sorts seats auto → manual → temp within the ward', () => {
    usePrincipalMock.mockReturnValue(principal(['CO']));
    mockSeats([
      makeSeat({
        member_canonical: 't@x.com',
        member_email: 't@x.com',
        member_name: 'Temp Person',
        type: 'temp',
        callings: [],
        end_date: '2026-12-31',
      }),
      makeSeat({
        member_canonical: 'm@x.com',
        member_email: 'm@x.com',
        member_name: 'Manual Person',
        type: 'manual',
        callings: [],
      }),
      makeSeat({
        member_canonical: 'a@x.com',
        member_email: 'a@x.com',
        member_name: 'Auto Person',
        type: 'auto',
        sort_order: 5,
      }),
    ]);
    mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
    render(<BishopricRosterPage />);
    const cards = Array.from(document.querySelectorAll('.roster-card'));
    expect(cards.map((c) => c.className)).toEqual([
      'roster-card type-auto',
      'roster-card type-manual',
      'roster-card type-temp',
    ]);
  });

  it('renders a "no bishopric wards" message when the principal holds none', () => {
    usePrincipalMock.mockReturnValue(principal([]));
    mockSeats([]);
    mockWardDoc(undefined);
    render(<BishopricRosterPage />);
    expect(screen.getByText(/no bishopric wards/i)).toBeInTheDocument();
  });

  describe('pending requests surfaced inline', () => {
    it('hides the Outstanding Requests section when there are no pending adds', () => {
      usePrincipalMock.mockReturnValue(principal(['CO']));
      mockSeats([
        makeSeat({ member_canonical: 'a@x.com', member_email: 'a@x.com', member_name: 'Alice' }),
      ]);
      mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
      mockPendingRequests([]);
      render(<BishopricRosterPage />);
      expect(screen.queryByTestId('roster-pending-adds-section')).toBeNull();
      // No card carries the pending-removal class.
      expect(document.querySelector('.has-removal-pending')).toBeNull();
    });

    it('shows an Outstanding Requests card with a Pending badge when an add is pending for the scope', () => {
      usePrincipalMock.mockReturnValue(principal(['CO']));
      mockSeats([]);
      mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
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
      render(<BishopricRosterPage />);
      expect(screen.getByTestId('roster-pending-adds-section')).toBeInTheDocument();
      expect(screen.getByText('New Hire')).toBeInTheDocument();
      expect(screen.getAllByTestId('pending-add-badge')).toHaveLength(1);
    });

    it('marks the matching roster card with a Pending Removal badge + has-removal-pending class', () => {
      usePrincipalMock.mockReturnValue(principal(['CO']));
      mockSeats([
        makeSeat({
          member_canonical: 'leaving@x.com',
          member_email: 'leaving@x.com',
          member_name: 'Leaving Soon',
          type: 'manual',
          callings: [],
        }),
      ]);
      mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
      mockPendingRequests([
        makeRequest({
          request_id: 'r1',
          type: 'remove',
          scope: 'CO',
          member_canonical: 'leaving@x.com',
          member_email: 'leaving@x.com',
        }),
      ]);
      render(<BishopricRosterPage />);
      expect(screen.getByTestId('pending-removal-badge-leaving@x.com')).toBeInTheDocument();
      const card = document.querySelector('[data-seat-id="leaving@x.com"]');
      expect(card?.className).toContain('has-removal-pending');
      // No new section because there are no pending adds, only a remove.
      expect(screen.queryByTestId('roster-pending-adds-section')).toBeNull();
    });

    it('applies both effects when a roster has a pending add AND a pending remove', () => {
      usePrincipalMock.mockReturnValue(principal(['CO']));
      mockSeats([
        makeSeat({
          member_canonical: 'leaving@x.com',
          member_email: 'leaving@x.com',
          member_name: 'Leaving Soon',
          type: 'manual',
          callings: [],
        }),
      ]);
      mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
      mockPendingRequests([
        makeRequest({
          request_id: 'r-add',
          type: 'add_manual',
          scope: 'CO',
          member_canonical: 'arriving@x.com',
          member_email: 'arriving@x.com',
          member_name: 'Arriving Soon',
        }),
        makeRequest({
          request_id: 'r-remove',
          type: 'remove',
          scope: 'CO',
          member_canonical: 'leaving@x.com',
          member_email: 'leaving@x.com',
        }),
      ]);
      render(<BishopricRosterPage />);
      expect(screen.getByTestId('roster-pending-adds-section')).toBeInTheDocument();
      expect(screen.getByText('Arriving Soon')).toBeInTheDocument();
      expect(screen.getByTestId('pending-removal-badge-leaving@x.com')).toBeInTheDocument();
    });
  });

  describe('per-row Remove affordance', () => {
    it('renders a Remove button next to every manual / temp seat', () => {
      usePrincipalMock.mockReturnValue(principal(['CO']));
      mockSeats([
        makeSeat({
          member_canonical: 'manual@x.com',
          member_email: 'manual@x.com',
          member_name: 'Manual Person',
          type: 'manual',
          callings: [],
        }),
        makeSeat({
          member_canonical: 'temp@x.com',
          member_email: 'temp@x.com',
          member_name: 'Temp Person',
          type: 'temp',
          callings: [],
          end_date: '2026-12-31',
        }),
      ]);
      mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
      render(<BishopricRosterPage />);
      expect(screen.getByTestId('remove-btn-manual@x.com')).toBeInTheDocument();
      expect(screen.getByTestId('remove-btn-temp@x.com')).toBeInTheDocument();
    });

    it('does not render a Remove button on auto seats', () => {
      usePrincipalMock.mockReturnValue(principal(['CO']));
      mockSeats([
        makeSeat({
          member_canonical: 'auto@x.com',
          member_email: 'auto@x.com',
          member_name: 'Auto Person',
          type: 'auto',
        }),
      ]);
      mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
      render(<BishopricRosterPage />);
      expect(screen.queryByTestId('remove-btn-auto@x.com')).toBeNull();
    });

    it('opens the removal confirmation dialog when Remove is clicked', async () => {
      const user = userEvent.setup();
      usePrincipalMock.mockReturnValue(principal(['CO']));
      mockSeats([
        makeSeat({
          member_canonical: 'leaving@x.com',
          member_email: 'leaving@x.com',
          member_name: 'Leaving Soon',
          type: 'manual',
          callings: [],
        }),
      ]);
      mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
      render(<BishopricRosterPage />);
      await user.click(screen.getByTestId('remove-btn-leaving@x.com'));
      expect(screen.getByTestId('removal-dialog-form')).toBeInTheDocument();
      expect(screen.getByTestId('removal-confirm')).toBeInTheDocument();
    });

    it('submits a remove request with the seat scope + member identity when confirmed', async () => {
      const user = userEvent.setup();
      usePrincipalMock.mockReturnValue(principal(['CO']));
      mockSeats([
        makeSeat({
          member_canonical: 'leaving@x.com',
          member_email: 'leaving@x.com',
          member_name: 'Leaving Soon',
          scope: 'CO',
          type: 'manual',
          callings: [],
          reason: 'sub teacher',
        }),
      ]);
      mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
      render(<BishopricRosterPage />);
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

    it('mixes auto + manual + temp seats and renders the button only on the non-auto rows (regression for staging report 2026-05-03)', () => {
      // Operator-reported "Remove button missing on manual + temp"
      // bug. Single render mixing all three seat types so a regression
      // that flips the gate (e.g. accidentally negating the
      // `seat.type === 'auto'` predicate, or gating on the wrong
      // field) trips this test the moment it lands.
      usePrincipalMock.mockReturnValue(principal(['CO']));
      mockSeats([
        makeSeat({
          member_canonical: 'auto@x.com',
          member_email: 'auto@x.com',
          member_name: 'Auto Person',
          type: 'auto',
          callings: ['Bishop'],
        }),
        makeSeat({
          member_canonical: 'manual@x.com',
          member_email: 'manual@x.com',
          member_name: 'Manual Person',
          type: 'manual',
          callings: [],
          reason: 'sub teacher',
        }),
        makeSeat({
          member_canonical: 'temp@x.com',
          member_email: 'temp@x.com',
          member_name: 'Temp Person',
          type: 'temp',
          callings: [],
          start_date: '2026-05-01',
          end_date: '2026-12-31',
        }),
      ]);
      mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
      render(<BishopricRosterPage />);
      // Auto row: no button.
      expect(screen.queryByTestId('remove-btn-auto@x.com')).toBeNull();
      // Manual + temp rows: button present.
      expect(screen.getByTestId('remove-btn-manual@x.com')).toBeInTheDocument();
      expect(screen.getByTestId('remove-btn-temp@x.com')).toBeInTheDocument();
      // And every rendered Remove button is visible (not display:none /
      // hidden via aria-hidden) — catches a regression where the
      // button renders but is suppressed.
      for (const btn of [
        screen.getByTestId('remove-btn-manual@x.com'),
        screen.getByTestId('remove-btn-temp@x.com'),
      ]) {
        expect(btn).toBeVisible();
      }
    });

    it('replaces the Remove button with a Removal pending badge once a remove is in flight', () => {
      usePrincipalMock.mockReturnValue(principal(['CO']));
      mockSeats([
        makeSeat({
          member_canonical: 'leaving@x.com',
          member_email: 'leaving@x.com',
          member_name: 'Leaving Soon',
          type: 'manual',
          callings: [],
        }),
      ]);
      mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
      mockPendingRemoveFor('leaving@x.com');
      render(<BishopricRosterPage />);
      expect(screen.queryByTestId('remove-btn-leaving@x.com')).toBeNull();
      expect(screen.getByTestId('removal-pending-leaving@x.com')).toBeInTheDocument();
    });

    it('hides the Remove button on rows whose scope the principal lacks authority for (multi-ward bishopric viewing the wrong ward)', () => {
      // Bishopric of CO is on the CO roster. We seed a seat with
      // `scope='GE'` (an unrelated ward — should never show up via
      // the live query, but the partition test guards the gate even
      // if a stale doc slips through). The button should be absent.
      usePrincipalMock.mockReturnValue(principal(['CO']));
      mockSeats([
        makeSeat({
          scope: 'GE',
          member_canonical: 'wrongward@x.com',
          member_email: 'wrongward@x.com',
          member_name: 'Wrong Ward Person',
          type: 'manual',
          callings: [],
        }),
      ]);
      mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
      render(<BishopricRosterPage />);
      expect(screen.queryByTestId('remove-btn-wrongward@x.com')).toBeNull();
    });
  });

  describe('per-row Edit affordance', () => {
    it('renders an Edit button on every ward-scope seat (auto / manual / temp) for the ward bishopric', () => {
      usePrincipalMock.mockReturnValue(principal(['CO']));
      mockSeats([
        makeSeat({
          member_canonical: 'auto@x.com',
          member_email: 'auto@x.com',
          member_name: 'Auto Person',
          type: 'auto',
          callings: ['Bishop'],
          scope: 'CO',
        }),
        makeSeat({
          member_canonical: 'manual@x.com',
          member_email: 'manual@x.com',
          member_name: 'Manual Person',
          type: 'manual',
          callings: [],
          scope: 'CO',
        }),
        makeSeat({
          member_canonical: 'temp@x.com',
          member_email: 'temp@x.com',
          member_name: 'Temp Person',
          type: 'temp',
          callings: [],
          scope: 'CO',
          start_date: '2026-05-01',
          end_date: '2026-12-31',
        }),
      ]);
      mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
      render(<BishopricRosterPage />);
      expect(screen.getByTestId('edit-btn-auto@x.com')).toBeInTheDocument();
      expect(screen.getByTestId('edit-btn-manual@x.com')).toBeInTheDocument();
      expect(screen.getByTestId('edit-btn-temp@x.com')).toBeInTheDocument();
    });

    it('hides the Edit button on rows whose scope the principal lacks authority for', () => {
      usePrincipalMock.mockReturnValue(principal(['CO']));
      mockSeats([
        makeSeat({
          scope: 'GE',
          member_canonical: 'wrongward@x.com',
          member_email: 'wrongward@x.com',
          member_name: 'Wrong Ward Person',
          type: 'manual',
          callings: [],
        }),
      ]);
      mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
      render(<BishopricRosterPage />);
      expect(screen.queryByTestId('edit-btn-wrongward@x.com')).toBeNull();
    });

    it('opens the edit dialog when Edit is clicked', async () => {
      const user = userEvent.setup();
      usePrincipalMock.mockReturnValue(principal(['CO']));
      mockSeats([
        makeSeat({
          member_canonical: 'manual@x.com',
          member_email: 'manual@x.com',
          member_name: 'Manual Person',
          type: 'manual',
          callings: [],
          scope: 'CO',
          reason: 'sub teacher',
        }),
      ]);
      mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
      render(<BishopricRosterPage />);
      await user.click(screen.getByTestId('edit-btn-manual@x.com'));
      expect(screen.getByTestId('edit-seat-dialog-form')).toBeInTheDocument();
    });
  });

  // T-43 Phase B AC #3 — broadened inclusion on Bishopric Roster.
  describe('Phase B broadened inclusion (T-43 AC #3)', () => {
    it("AC #3: a seat with primary scope='stake' and a CO duplicate appears on CO's bishopric roster (single row, columns reflect the duplicate)", () => {
      usePrincipalMock.mockReturnValue(principal(['CO']));
      const NOW = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
      mockSeats([
        makeSeat({
          scope: 'stake',
          type: 'auto',
          member_canonical: 'cross@x.com',
          member_email: 'cross@x.com',
          member_name: 'Cross Person',
          callings: ['Stake Clerk'],
          duplicate_grants: [
            {
              scope: 'CO',
              type: 'auto',
              callings: ['Bishop'],
              building_names: ['CO Building'],
              detected_at: NOW,
            },
          ],
        }),
      ]);
      mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
      render(<BishopricRosterPage />);
      // Single row.
      const cards = document.querySelectorAll('[data-seat-id="cross@x.com"]');
      expect(cards).toHaveLength(1);
      // Calling text reflects the CO duplicate (Bishop), not the
      // stake primary (Stake Clerk).
      expect(screen.getByText(/Bishop/)).toBeInTheDocument();
      expect(screen.queryByText(/Stake Clerk/)).toBeNull();
    });
  });
});

describe('<BishopricRosterPage /> — Kindoo Sites label (spec §15)', () => {
  // Ward seats render a small foreign-site badge near the seat-type
  // badge when the ward's `kindoo_site_id` points at a non-home site.
  // Home / stake / unknown-ward → no badge.

  function mockStakeWards(wardDocs: Ward[]) {
    useStakeWardsMock.mockReturnValue({
      data: wardDocs,
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

  it('renders the foreign-site badge on a ward seat whose ward.kindoo_site_id points at a foreign site', () => {
    usePrincipalMock.mockReturnValue(principal(['FN']));
    mockSeats([
      makeSeat({
        member_canonical: 'a@x.com',
        member_email: 'a@x.com',
        member_name: 'Alpha',
        scope: 'FN',
      }),
    ]);
    mockWardDoc(makeWard({ ward_code: 'FN', ward_name: 'Foothills', seat_cap: 20 }));
    mockStakeWards([
      makeWard({
        ward_code: 'FN',
        ward_name: 'Foothills',
        kindoo_site_id: 'foreign-1',
      } as Partial<Ward>),
    ]);
    mockKindooSites([{ id: 'foreign-1', display_name: 'East Stake (Foothills)' }]);
    render(<BishopricRosterPage initialWard="FN" />);
    expect(screen.getByTestId('kindoo-site-badge-a@x.com')).toHaveTextContent(
      'East Stake (Foothills)',
    );
  });

  it('omits the foreign-site badge when the ward is on the home site (kindoo_site_id null)', () => {
    usePrincipalMock.mockReturnValue(principal(['CO']));
    mockSeats([
      makeSeat({
        member_canonical: 'a@x.com',
        member_email: 'a@x.com',
        member_name: 'Alpha',
        scope: 'CO',
      }),
    ]);
    mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
    mockStakeWards([makeWard({ ward_code: 'CO' } as Partial<Ward>)]);
    mockKindooSites([{ id: 'foreign-1', display_name: 'East Stake (Foothills)' }]);
    render(<BishopricRosterPage initialWard="CO" />);
    expect(screen.queryByTestId('kindoo-site-badge-a@x.com')).toBeNull();
  });
});
