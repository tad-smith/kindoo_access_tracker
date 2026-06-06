// Component tests for the Stake Roster page. Same mock-the-hook
// pattern as the bishopric Roster page test.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccessRequest, Seat, Stake, Ward } from '@kindoo/shared';
import { makeRequest, makeSeat, makeWard } from '../../../test/fixtures';

const useStakeRosterMock = vi.fn();
const useStakeWardsMock = vi.fn();
const useStakeBuildingsMock = vi.fn();
const useKindooSitesMock = vi.fn();
const useOrganizationsMock = vi.fn();
const setSeatOrgMock = vi.fn();
const useFirestoreDocMock = vi.fn();
const usePendingRequestsForScopeMock = vi.fn();
const usePendingRemoveRequestsMock = vi.fn();
const submitMutateAsyncMock = vi.fn();
const usePrincipalMock = vi.fn();

vi.mock('./hooks', () => ({
  useStakeRoster: () => useStakeRosterMock(),
  useStakeWards: () => useStakeWardsMock(),
  useStakeBuildings: () => useStakeBuildingsMock(),
  useKindooSites: () => useKindooSitesMock(),
  useSetSeatOrganization: () => ({ mutate: setSeatOrgMock, isPending: false }),
}));

// The org catalogue hook is mocked; the pure id→name + sort helpers are
// the real implementations so the chip + per-org bars exercise them.
vi.mock('../organizations/hooks', async () => {
  const actual = await vi.importActual<object>('../organizations/hooks');
  return {
    ...actual,
    useOrganizations: () => useOrganizationsMock(),
  };
});

vi.mock('../../lib/data', () => ({
  useFirestoreDoc: (ref: unknown) => useFirestoreDocMock(ref),
}));

vi.mock('../../lib/principal', () => ({
  usePrincipal: () => usePrincipalMock(),
}));

// The New Request header button is now a modal trigger. Stub the
// affordance with a button that surfaces the forwarded scope as
// `data-scope` and, on click, reveals a marker so tests can assert the
// modal opens (instead of the old route navigation). The dialog itself
// is covered by NewRequestDialog.test.tsx.
vi.mock('../requests/components/NewRequestAffordance', async () => {
  const { useState } = await import('react');
  return {
    NewRequestAffordance: ({ scope, testId }: { scope: string; testId: string }) => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button data-testid={testId} data-scope={scope} onClick={() => setOpen(true)}>
            New Request
          </button>
          {open ? <div data-testid="new-request-dialog-open" /> : null}
        </>
      );
    },
  };
});

// EditSeatDialog (mounted on Edit click) subscribes to stake-wide ward
// + building catalogues; stub them so the dialog can render without a
// real Firestore listener. The dialog has its own focused test file.
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

import { StakeRosterPage } from './RosterPage';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockBuildings(buildings: any[]) {
  useStakeBuildingsMock.mockReturnValue({
    data: buildings,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockOrganizations(orgs: any[]) {
  useOrganizationsMock.mockReturnValue({
    data: orgs,
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
  // Default: no wards / buildings. Tests that exercise the new pool
  // denominator override via mockWards / mockBuildings.
  mockWards([]);
  mockBuildings([]);
  // Default: no pending requests.
  mockPendingRequests([]);
  // Default: no pending remove requests for any seat (the per-row
  // RemovalAffordance subscription).
  mockNoPendingRemoves();
  // Default: empty Kindoo Sites catalogue.
  useKindooSitesMock.mockReturnValue(stakeListResult);
  // Default: empty organizations catalogue (no per-org bars; chip reads
  // "No Organization").
  mockOrganizations([]);
  submitMutateAsyncMock.mockResolvedValue({ id: 'req-new' });
  // Default principal: stake-scope authority. The stake Roster page
  // is reachable only by users with `stake: true`, so this is the
  // realistic default. Tests that need a different principal
  // override via `usePrincipalMock.mockReturnValue(principal({...}))`.
  usePrincipalMock.mockReturnValue(principal({ stake: true }));
});

describe('<StakeRosterPage />', () => {
  it('renders the empty state when there are no stake seats', () => {
    mockSeats([]);
    mockStakeDoc({ stake_seat_cap: 200 });
    render(<StakeRosterPage />);
    expect(screen.getByText(/no stake seats yet/i)).toBeInTheDocument();
  });

  describe('New Request header action', () => {
    it('renders the "New Request" button pre-selecting the stake scope for a stake member', () => {
      usePrincipalMock.mockReturnValue(principal({ stake: true }));
      mockSeats([]);
      mockStakeDoc({ stake_seat_cap: 200 });
      render(<StakeRosterPage />);
      const btn = screen.getByTestId('stake-roster-new-request');
      expect(btn).toHaveTextContent('New Request');
      expect(btn).toHaveAttribute('data-scope', 'stake');
    });

    it('opens the New Request modal when the button is clicked (no route change)', async () => {
      const user = userEvent.setup();
      usePrincipalMock.mockReturnValue(principal({ stake: true }));
      mockSeats([]);
      mockStakeDoc({ stake_seat_cap: 200 });
      render(<StakeRosterPage />);
      expect(screen.queryByTestId('new-request-dialog-open')).toBeNull();
      await user.click(screen.getByTestId('stake-roster-new-request'));
      expect(screen.getByTestId('new-request-dialog-open')).toBeInTheDocument();
    });

    it('hides the New Request button for a non-stake (manager-only) principal', () => {
      // Manager status alone does not grant stake-scope request rights
      // (B-3) — same predicate that gates the 'stake' New Request option.
      usePrincipalMock.mockReturnValue({
        ...(principal() as object),
        managerStakes: ['csnorth'],
      });
      mockSeats([]);
      mockStakeDoc({ stake_seat_cap: 200 });
      render(<StakeRosterPage />);
      expect(screen.queryByTestId('stake-roster-new-request')).toBeNull();
    });
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

  it('excludes foreign-site ward caps (resolved via the ward building) from the stake pool denominator', () => {
    mockSeats([makeSeat({ scope: 'stake' })]);
    mockStakeDoc({ stake_seat_cap: 200 });
    mockWards([
      makeWard({ ward_code: 'CO', seat_cap: 50, building_name: 'Home Building' }),
      makeWard({ ward_code: 'FN', seat_cap: 50, building_name: 'Foreign Building' }),
    ]);
    mockBuildings([
      { building_id: 'home', building_name: 'Home Building', kindoo_site_id: null },
      { building_id: 'foreign', building_name: 'Foreign Building', kindoo_site_id: 'east-stake' },
    ]);
    render(<StakeRosterPage />);
    // 200 - 50 (CO, home). FN excluded (its building is on east-stake).
    expect(screen.getByText(/1 \/ 150 seats used/)).toBeInTheDocument();
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

  describe('per-row Remove affordance', () => {
    it('renders a Remove button next to every manual / temp stake seat', () => {
      mockSeats([
        makeSeat({
          scope: 'stake',
          member_canonical: 'manual@x.com',
          member_email: 'manual@x.com',
          member_name: 'Manual Person',
          type: 'manual',
          callings: [],
        }),
        makeSeat({
          scope: 'stake',
          member_canonical: 'temp@x.com',
          member_email: 'temp@x.com',
          member_name: 'Temp Person',
          type: 'temp',
          callings: [],
          end_date: '2026-12-31',
        }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      render(<StakeRosterPage />);
      expect(screen.getByTestId('remove-btn-manual@x.com')).toBeInTheDocument();
      expect(screen.getByTestId('remove-btn-temp@x.com')).toBeInTheDocument();
    });

    it('does not render a Remove button on auto seats', () => {
      mockSeats([
        makeSeat({
          scope: 'stake',
          member_canonical: 'auto@x.com',
          member_email: 'auto@x.com',
          member_name: 'Auto Person',
          type: 'auto',
        }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      render(<StakeRosterPage />);
      expect(screen.queryByTestId('remove-btn-auto@x.com')).toBeNull();
    });

    it('opens the removal confirmation dialog when Remove is clicked', async () => {
      const user = userEvent.setup();
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
      render(<StakeRosterPage />);
      await user.click(screen.getByTestId('remove-btn-leaving@x.com'));
      expect(screen.getByTestId('removal-dialog-form')).toBeInTheDocument();
      expect(screen.getByTestId('removal-confirm')).toBeInTheDocument();
    });

    it('submits a remove request with scope=stake + member identity when confirmed', async () => {
      const user = userEvent.setup();
      mockSeats([
        makeSeat({
          scope: 'stake',
          member_canonical: 'leaving@x.com',
          member_email: 'leaving@x.com',
          member_name: 'Leaving Soon',
          type: 'manual',
          callings: [],
          reason: 'sub teacher',
        }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      render(<StakeRosterPage />);
      await user.click(screen.getByTestId('remove-btn-leaving@x.com'));
      await user.type(screen.getByTestId('removal-reason'), 'No longer needed');
      await user.click(screen.getByTestId('removal-confirm'));
      expect(submitMutateAsyncMock).toHaveBeenCalledTimes(1);
      expect(submitMutateAsyncMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'remove',
          scope: 'stake',
          member_email: 'leaving@x.com',
          member_name: 'Leaving Soon',
          reason: 'No longer needed',
        }),
      );
    });

    it('replaces the Remove button with a Removal pending badge once a remove is in flight', () => {
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
      mockPendingRemoveFor('leaving@x.com');
      render(<StakeRosterPage />);
      expect(screen.queryByTestId('remove-btn-leaving@x.com')).toBeNull();
      expect(screen.getByTestId('removal-pending-leaving@x.com')).toBeInTheDocument();
    });

    it('mixes auto + manual + temp seats and renders the button only on the non-auto rows (regression for staging report 2026-05-03)', () => {
      // Same regression net as the bishopric test — single render
      // covering all three seat types so a future change that flips
      // the auto-gate trips this test immediately.
      mockSeats([
        makeSeat({
          scope: 'stake',
          member_canonical: 'auto@x.com',
          member_email: 'auto@x.com',
          member_name: 'Auto Person',
          type: 'auto',
          callings: ['Stake President'],
        }),
        makeSeat({
          scope: 'stake',
          member_canonical: 'manual@x.com',
          member_email: 'manual@x.com',
          member_name: 'Manual Person',
          type: 'manual',
          callings: [],
          reason: 'youth conference admin',
        }),
        makeSeat({
          scope: 'stake',
          member_canonical: 'temp@x.com',
          member_email: 'temp@x.com',
          member_name: 'Temp Person',
          type: 'temp',
          callings: [],
          start_date: '2026-05-01',
          end_date: '2026-12-31',
        }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      render(<StakeRosterPage />);
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

    it('hides the Remove button when the principal lacks stake-scope authority (symmetric with allowedScopesFor)', () => {
      // Bishopric-only principal (no stake claim). They might be able
      // to land on this page if they navigate via URL, but the symmetric-
      // authority rule says no Remove button on stake-scope rows for
      // someone who could not ADD to the stake scope.
      usePrincipalMock.mockReturnValue(principal({ wards: ['CO'] }));
      mockSeats([
        makeSeat({
          scope: 'stake',
          member_canonical: 'manual@x.com',
          member_email: 'manual@x.com',
          member_name: 'Manual Person',
          type: 'manual',
          callings: [],
        }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      render(<StakeRosterPage />);
      expect(screen.queryByTestId('remove-btn-manual@x.com')).toBeNull();
    });
  });

  describe('per-row Edit affordance', () => {
    it('hides the Edit button on stake-scope auto seats (Church-managed — not editable for anyone)', () => {
      mockSeats([
        makeSeat({
          scope: 'stake',
          member_canonical: 'auto@x.com',
          member_email: 'auto@x.com',
          member_name: 'Auto Person',
          type: 'auto',
          callings: ['Stake President'],
        }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      render(<StakeRosterPage />);
      expect(screen.queryByTestId('edit-btn-auto@x.com')).toBeNull();
    });

    it('renders an Edit button on stake-scope manual / temp seats for a stake user', () => {
      mockSeats([
        makeSeat({
          scope: 'stake',
          member_canonical: 'manual@x.com',
          member_email: 'manual@x.com',
          member_name: 'Manual Person',
          type: 'manual',
          callings: [],
        }),
        makeSeat({
          scope: 'stake',
          member_canonical: 'temp@x.com',
          member_email: 'temp@x.com',
          member_name: 'Temp Person',
          type: 'temp',
          callings: [],
          start_date: '2026-05-01',
          end_date: '2026-12-31',
        }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      render(<StakeRosterPage />);
      expect(screen.getByTestId('edit-btn-manual@x.com')).toBeInTheDocument();
      expect(screen.getByTestId('edit-btn-temp@x.com')).toBeInTheDocument();
    });

    it('hides the Edit button when the principal lacks stake-scope authority', () => {
      usePrincipalMock.mockReturnValue(principal({ wards: ['CO'] }));
      mockSeats([
        makeSeat({
          scope: 'stake',
          member_canonical: 'manual@x.com',
          member_email: 'manual@x.com',
          member_name: 'Manual Person',
          type: 'manual',
          callings: [],
        }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      render(<StakeRosterPage />);
      expect(screen.queryByTestId('edit-btn-manual@x.com')).toBeNull();
    });
  });

  // T-43 Phase B AC #4 — broadened inclusion on Stake Roster.
  describe('Phase B broadened inclusion (T-43 AC #4)', () => {
    it('AC #4: a seat with primary scope="CO" and a stake-scope duplicate appears on the Stake Roster (single row)', () => {
      const NOW = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
      mockSeats([
        makeSeat({
          scope: 'CO',
          type: 'auto',
          member_canonical: 'cross@x.com',
          member_email: 'cross@x.com',
          member_name: 'Cross Person',
          callings: ['Bishop'],
          duplicate_grants: [
            {
              scope: 'stake',
              type: 'auto',
              callings: ['Stake Clerk'],
              building_names: ['Stake Center'],
              detected_at: NOW,
            },
          ],
        }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      render(<StakeRosterPage />);
      // Single row for the cross-scope person on the stake page.
      const cards = document.querySelectorAll('[data-seat-id="cross@x.com"]');
      expect(cards).toHaveLength(1);
      // The row's columns reflect the stake duplicate, not the CO
      // primary — calling list reads "Stake Clerk".
      expect(screen.getByText(/Stake Clerk/)).toBeInTheDocument();
    });
  });

  // Organization chip + per-organization utilization bars (Web Track 2).
  describe('organizations', () => {
    const orgs = [
      { organization_id: 'youth', name: 'Youth Program', seat_cap: 10 },
      { organization_id: 'choir', name: 'Stake Choir', seat_cap: 5 },
    ];

    it('renders an org chip on every card showing the resolved org name', () => {
      mockSeats([
        makeSeat({
          scope: 'stake',
          member_canonical: 'a@x.com',
          member_email: 'a@x.com',
          organization_id: 'choir',
        }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      mockOrganizations(orgs);
      render(<StakeRosterPage />);
      const chip = screen.getByTestId('org-chip-a@x.com');
      expect(chip.textContent).toContain('Stake Choir');
    });

    it('renders the chip as "No Organization" when the seat has no org', () => {
      mockSeats([
        makeSeat({ scope: 'stake', member_canonical: 'a@x.com', member_email: 'a@x.com' }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      mockOrganizations(orgs);
      render(<StakeRosterPage />);
      expect(screen.getByTestId('org-chip-a@x.com').textContent).toContain('No Organization');
    });

    it('makes the chip editable (select present) on a primary stake grant for a stake user', () => {
      mockSeats([
        makeSeat({ scope: 'stake', member_canonical: 'a@x.com', member_email: 'a@x.com' }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      mockOrganizations(orgs);
      render(<StakeRosterPage />);
      expect(screen.getByTestId('org-select-a@x.com')).toBeInTheDocument();
    });

    it('writes the chosen org id immediately on change', async () => {
      const user = userEvent.setup();
      mockSeats([
        makeSeat({ scope: 'stake', member_canonical: 'a@x.com', member_email: 'a@x.com' }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      mockOrganizations(orgs);
      render(<StakeRosterPage />);
      await user.selectOptions(screen.getByTestId('org-select-a@x.com'), 'youth');
      expect(setSeatOrgMock).toHaveBeenCalledWith({
        memberCanonical: 'a@x.com',
        organizationId: 'youth',
      });
    });

    it('renders the chip read-only (no select) for a non-stake principal', () => {
      usePrincipalMock.mockReturnValue(principal({ wards: ['CO'] }));
      mockSeats([
        makeSeat({ scope: 'stake', member_canonical: 'a@x.com', member_email: 'a@x.com' }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      mockOrganizations(orgs);
      render(<StakeRosterPage />);
      expect(screen.queryByTestId('org-select-a@x.com')).toBeNull();
      expect(screen.getByTestId('org-chip-a@x.com').getAttribute('data-editable')).toBe('false');
    });

    it('renders the chip read-only when the matched stake grant is a duplicate (set via the request form)', () => {
      const NOW = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
      mockSeats([
        makeSeat({
          scope: 'CO',
          type: 'auto',
          member_canonical: 'cross@x.com',
          member_email: 'cross@x.com',
          callings: ['Bishop'],
          duplicate_grants: [
            {
              scope: 'stake',
              type: 'manual',
              kindoo_site_id: null,
              organization_id: 'youth',
              building_names: ['Stake Center'],
              detected_at: NOW,
            },
          ],
        }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      mockOrganizations(orgs);
      render(<StakeRosterPage />);
      // The chip resolves the duplicate's own org id, read-only.
      const chip = screen.getByTestId('org-chip-cross@x.com');
      expect(chip.textContent).toContain('Youth Program');
      expect(chip.getAttribute('data-editable')).toBe('false');
      expect(screen.queryByTestId('org-select-cross@x.com')).toBeNull();
    });

    it('relabels the stake bar "Stake Total" and renders one bar per organization', () => {
      mockSeats([
        makeSeat({
          scope: 'stake',
          member_canonical: 'a@x.com',
          member_email: 'a@x.com',
          organization_id: 'choir',
        }),
        makeSeat({
          scope: 'stake',
          member_canonical: 'b@x.com',
          member_email: 'b@x.com',
          organization_id: 'choir',
        }),
        makeSeat({
          scope: 'stake',
          member_canonical: 'c@x.com',
          member_email: 'c@x.com',
          organization_id: 'youth',
        }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      mockOrganizations(orgs);
      render(<StakeRosterPage />);
      expect(screen.getByText(/Stake Total: 3 \/ 200 seats used/)).toBeInTheDocument();
      // Alpha order: Stake Choir then Youth Program.
      expect(screen.getByText(/Stake Choir: 2 \/ 5 seats used/)).toBeInTheDocument();
      expect(screen.getByText(/Youth Program: 1 \/ 10 seats used/)).toBeInTheDocument();
    });

    it('renders a zero-count bar for an organization with no seats', () => {
      mockSeats([
        makeSeat({ scope: 'stake', member_canonical: 'a@x.com', member_email: 'a@x.com' }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      mockOrganizations(orgs);
      render(<StakeRosterPage />);
      expect(screen.getByText(/Stake Choir: 0 \/ 5 seats used/)).toBeInTheDocument();
      expect(screen.getByText(/Youth Program: 0 \/ 10 seats used/)).toBeInTheDocument();
    });

    it('leaves the stake bar unlabelled when the stake has no organizations', () => {
      mockSeats([
        makeSeat({ scope: 'stake', member_canonical: 'a@x.com', member_email: 'a@x.com' }),
      ]);
      mockStakeDoc({ stake_seat_cap: 200 });
      mockOrganizations([]);
      render(<StakeRosterPage />);
      expect(screen.queryByText(/Stake Total/)).toBeNull();
      expect(screen.getByText(/1 \/ 200 seats used/)).toBeInTheDocument();
    });
  });
});
