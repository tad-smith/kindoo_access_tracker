// Component tests for the Manager Dashboard. Mocks every hook so the
// test exercises the rendering shape across all five cards in both
// empty and populated states.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { AccessRequest, AuditLog, Seat, Stake, Ward } from '@kindoo/shared';
import { makeAuditLog, makeRequest, makeSeat, makeWard } from '../../../../test/fixtures';

const usePendingMock = vi.fn();
const useRecentAuditMock = vi.fn();
const useStakeSeatsMock = vi.fn();
const useStakeWardsMock = vi.fn();
const useStakeDocMock = vi.fn();

vi.mock('./hooks', () => ({
  usePendingRequests: () => usePendingMock(),
  useRecentAuditLog: () => useRecentAuditMock(),
  useStakeSeats: () => useStakeSeatsMock(),
  useStakeWards: () => useStakeWardsMock(),
  useStakeDoc: () => useStakeDocMock(),
}));

import { ManagerDashboardPage } from './DashboardPage';

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

function liveDocResult<T>(data: T | undefined, isLoading = false) {
  return liveResult(data ? [data] : [], isLoading) as unknown as ReturnType<typeof liveResult> & {
    data: T | undefined;
  };
}

function mockAll(opts: {
  pending?: AccessRequest[];
  audit?: AuditLog[];
  seats?: Seat[];
  wards?: Ward[];
  stake?: Partial<Stake>;
  loading?: boolean;
}) {
  const loading = opts.loading ?? false;
  usePendingMock.mockReturnValue(liveResult(opts.pending ?? [], loading));
  useRecentAuditMock.mockReturnValue(liveResult(opts.audit ?? [], loading));
  useStakeSeatsMock.mockReturnValue(liveResult(opts.seats ?? [], loading));
  useStakeWardsMock.mockReturnValue(liveResult(opts.wards ?? [], loading));
  useStakeDocMock.mockReturnValue({
    data: opts.stake,
    error: null,
    status: loading ? 'pending' : 'success',
    isPending: loading,
    isLoading: loading,
    isSuccess: !loading,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  });
}

async function renderWithRouter() {
  const rootRoute = createRootRoute({ component: () => <ManagerDashboardPage /> });
  const seats = createRoute({
    getParentRoute: () => rootRoute,
    path: 'manager/seats',
    component: () => <div>seats</div>,
  });
  const audit = createRoute({
    getParentRoute: () => rootRoute,
    path: 'manager/audit',
    component: () => <div>audit</div>,
  });
  const queue = createRoute({
    getParentRoute: () => rootRoute,
    path: 'manager/queue',
    component: () => <div>queue</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([seats, audit, queue]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('<ManagerDashboardPage />', () => {
  it('renders all five cards in their empty-state form', async () => {
    mockAll({ stake: { stake_seat_cap: 200, last_over_caps_json: [] } });
    await renderWithRouter();
    expect(
      within(screen.getByTestId('dashboard-card-pending')).getByText(/no pending requests/i),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('dashboard-card-warnings')).getByText(/no warnings/i),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('dashboard-card-recent')).getByText(/no recent activity/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-card-utilization')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-card-ops')).toBeInTheDocument();
  });

  it('renders pending counts grouped by type', async () => {
    mockAll({
      pending: [
        makeRequest({ request_id: 'r1', type: 'add_manual' }),
        makeRequest({ request_id: 'r2', type: 'add_manual' }),
        makeRequest({ request_id: 'r3', type: 'add_temp' }),
      ],
      stake: { stake_seat_cap: 200, last_over_caps_json: [] },
    });
    await renderWithRouter();
    const pending = screen.getByTestId('dashboard-card-pending');
    expect(within(pending).getByText('3')).toBeInTheDocument();
    expect(within(pending).getByText('add_manual')).toBeInTheDocument();
    expect(within(pending).getByText('add_temp')).toBeInTheDocument();
  });

  it('renders one utilization bar per ward + a stake bar', async () => {
    mockAll({
      seats: [
        makeSeat({ scope: 'stake', member_canonical: 's1@x.com', member_email: 's1@x.com' }),
        makeSeat({ scope: 'CO' }),
        makeSeat({ scope: 'CO', member_canonical: 'x2@x.com', member_email: 'x2@x.com' }),
        makeSeat({ scope: 'GE', member_canonical: 'g@x.com', member_email: 'g@x.com' }),
      ],
      wards: [
        makeWard({ ward_code: 'CO', ward_name: 'Cordera', seat_cap: 20 }),
        makeWard({ ward_code: 'GE', ward_name: 'Genoa', seat_cap: 20 }),
      ],
      stake: { stake_seat_cap: 200, last_over_caps_json: [] },
    });
    await renderWithRouter();
    const util = screen.getByTestId('dashboard-card-utilization');
    expect(within(util).getByText('Stake')).toBeInTheDocument();
    expect(within(util).getByText(/2 \/ 20 seats used/)).toBeInTheDocument(); // Cordera
    expect(within(util).getByText(/1 \/ 20 seats used/)).toBeInTheDocument(); // Genoa
  });

  it('uses the stake-presidency pool size (stake_seat_cap minus ward caps) for the Stake bar', async () => {
    mockAll({
      seats: [makeSeat({ scope: 'stake', member_canonical: 's1@x.com', member_email: 's1@x.com' })],
      wards: [
        makeWard({ ward_code: 'CO', seat_cap: 50 }),
        makeWard({ ward_code: 'GE', seat_cap: 50 }),
        makeWard({ ward_code: 'PR', seat_cap: 50 }),
      ],
      stake: { stake_seat_cap: 200, last_over_caps_json: [] },
    });
    await renderWithRouter();
    const util = screen.getByTestId('dashboard-card-utilization');
    // 200 - (50 + 50 + 50) = 50.
    expect(within(util).getByText(/1 \/ 50 seats used/)).toBeInTheDocument();
  });

  it('excludes foreign-site ward caps from the Stake-bar denominator', async () => {
    // CO is home (50 cap); FN is on a foreign Kindoo site (50 cap,
    // excluded). Home portion = 200 - 50 = 150.
    mockAll({
      seats: [makeSeat({ scope: 'stake', member_canonical: 's1@x.com', member_email: 's1@x.com' })],
      wards: [
        makeWard({ ward_code: 'CO', seat_cap: 50 }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeWard({ ward_code: 'FN', seat_cap: 50, kindoo_site_id: 'east-stake' } as any),
      ],
      stake: { stake_seat_cap: 200, last_over_caps_json: [] },
    });
    await renderWithRouter();
    const util = screen.getByTestId('dashboard-card-utilization');
    expect(within(util).getByText(/1 \/ 150 seats used/)).toBeInTheDocument();
  });

  it('renders the warnings card with one row per over-cap pool', async () => {
    mockAll({
      stake: {
        stake_seat_cap: 200,
        last_over_caps_json: [
          { pool: 'stake', count: 210, cap: 200, over_by: 10 },
          { pool: 'CO', count: 22, cap: 20, over_by: 2 },
        ],
      },
    });
    await renderWithRouter();
    const warn = screen.getByTestId('dashboard-card-warnings');
    expect(within(warn).getByText(/Stake/)).toBeInTheDocument();
    expect(within(warn).getByText(/Ward CO/)).toBeInTheDocument();
    expect(within(warn).getByText(/over by 10/)).toBeInTheDocument();
    expect(within(warn).getByText(/over by 2/)).toBeInTheDocument();
  });

  it('renders the recent-activity card with one row per audit entry', async () => {
    mockAll({
      audit: [
        makeAuditLog({
          audit_id: 'a1',
          actor_email: 'alice@example.com',
          action: 'create_seat',
          entity_id: 'bob@example.com',
          before: null,
          after: { member_email: 'bob@example.com', scope: 'CO' },
        }),
      ],
      stake: { stake_seat_cap: 200, last_over_caps_json: [] },
    });
    await renderWithRouter();
    const recent = screen.getByTestId('dashboard-card-recent');
    expect(within(recent).getByText(/alice@example\.com/)).toBeInTheDocument();
  });

  it('renders skeletons while any subscription is still loading', async () => {
    mockAll({ loading: true });
    await renderWithRouter();
    // At least one skeleton element is rendered while loading.
    expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  // T-43 Phase B AC #5 — per-scope rollups widen inclusion to count
  // seats whose primary OR any duplicate scope matches the bar.
  // Same-scope dupes don't double-count.
  describe('Phase B broadened-inclusion rollups (T-43 AC #5)', () => {
    const NOW = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };

    it('AC #5: counts a stake-primary seat whose duplicate is CO on the CO bar', async () => {
      mockAll({
        seats: [
          makeSeat({
            scope: 'stake',
            member_canonical: 'cross@x.com',
            member_email: 'cross@x.com',
            duplicate_grants: [{ scope: 'CO', type: 'auto', detected_at: NOW }],
            // Phase A maintains `duplicate_scopes`; the widened
            // rollup reads it directly.
            duplicate_scopes: ['CO'],
          }),
        ],
        wards: [makeWard({ ward_code: 'CO', ward_name: 'Cordera', seat_cap: 20 })],
        stake: { stake_seat_cap: 200, last_over_caps_json: [] },
      });
      await renderWithRouter();
      const util = screen.getByTestId('dashboard-card-utilization');
      // Stake bar shows 1 (the primary). CO bar shows 1 (the duplicate).
      expect(within(util).getByText(/1 \/ 20 seats used/)).toBeInTheDocument();
    });

    it("AC #5: same-scope within-site duplicate doesn't double-count on the same bar", async () => {
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
        stake: { stake_seat_cap: 200, last_over_caps_json: [] },
      });
      await renderWithRouter();
      const util = screen.getByTestId('dashboard-card-utilization');
      // CO bar shows 1, not 2 — the same-scope dup collapses.
      expect(within(util).getByText(/1 \/ 20 seats used/)).toBeInTheDocument();
    });
  });
});
