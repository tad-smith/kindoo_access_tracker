// Component tests for the Superadmin Stake List page. Same mock-the-
// hook pattern as the other page-level tests (Stake Roster, Manager
// Dashboard). The route-level superadmin gate is covered separately in
// `useRequireRole.test.tsx`; here we exercise the rendering shape
// directly with the page mounted.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { TimestampLike } from '@kindoo/shared';
import type { StakeWithId } from '../hooks';

const useStakesMock = vi.fn();

vi.mock('../hooks', () => ({
  useStakes: () => useStakesMock(),
  useCreateStake: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useApplyStakeFix: () => ({ mutateAsync: vi.fn(), reset: vi.fn(), isPending: false }),
}));

// ApplyFixesMenu has its own dedicated test file; stub it to a per-row
// sentinel so the page-level tests stay focused on the list rendering
// shape and confirm the menu is wired into every row.
vi.mock('../ApplyFixesMenu', () => ({
  ApplyFixesMenu: ({ stake }: { stake: { id: string } }) => (
    <div data-testid={`apply-fixes-menu-stub-${stake.id}`} />
  ),
}));

// CreateStakeForm has its own dedicated test file; here we stub it to a
// sentinel marker so the page-level tests stay focused on the list
// rendering shape and don't have to thread react-hook-form's deps.
// The stub records `open` so we can verify the trigger button toggles
// it; clicking the stub's close button verifies the page wires
// `onClose` back into local state.
vi.mock('../CreateStakeForm', () => ({
  CreateStakeForm: ({ open, onClose }: { open: boolean; onClose: () => void }) => (
    <div data-testid="create-stake-form-stub" data-open={open ? 'true' : 'false'}>
      <button type="button" data-testid="create-stake-form-stub-close" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

import { SuperadminStakeListPage } from '../StakeListPage';

function ts(iso: string): TimestampLike {
  const d = new Date(iso);
  return {
    seconds: Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
    toDate: () => d,
    toMillis: () => d.getTime(),
  };
}

function makeStake(overrides: Partial<StakeWithId> = {}): StakeWithId {
  const actor = { email: 'superadmin@example.com', canonical: 'superadmin@example.com' };
  const created = ts('2026-04-01T12:00:00Z');
  return {
    id: 'csnorth',
    stake_name: 'CS North Stake',
    created_at: created,
    created_by: 'superadmin@example.com',
    bootstrap_admin_email: 'admin@csnorth.org',
    setup_complete: true,
    stake_seat_cap: 200,
    timezone: 'America/Denver',
    notifications_enabled: true,
    last_over_caps_json: [],
    last_modified_at: created,
    last_modified_by: actor,
    lastActor: actor,
    ...overrides,
  };
}

function mockStakes(rows: StakeWithId[] | undefined, isLoading = false) {
  useStakesMock.mockReturnValue({
    data: rows,
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

// Minimal router fixture so `<Link>` inside the page can resolve.
async function renderPage() {
  const rootRoute = createRootRoute({ component: () => <SuperadminStakeListPage /> });
  const dash = createRoute({
    getParentRoute: () => rootRoute,
    path: 'manager/dashboard',
    component: () => <div>dashboard</div>,
  });
  const catchAll = createRoute({
    getParentRoute: () => rootRoute,
    path: '$',
    component: () => <Outlet />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([dash, catchAll]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('<SuperadminStakeListPage />', () => {
  it('renders the Create Stake trigger button with the form initially closed', async () => {
    mockStakes([]);
    await renderPage();
    expect(screen.getByTestId('create-stake-open')).toBeInTheDocument();
    expect(screen.getByTestId('create-stake-form-stub')).toHaveAttribute('data-open', 'false');
  });

  it('opens the Create Stake dialog when the trigger button is clicked', async () => {
    mockStakes([]);
    await renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('create-stake-open'));
    expect(screen.getByTestId('create-stake-form-stub')).toHaveAttribute('data-open', 'true');
  });

  it('closes the Create Stake dialog when the form invokes onClose', async () => {
    mockStakes([]);
    await renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('create-stake-open'));
    expect(screen.getByTestId('create-stake-form-stub')).toHaveAttribute('data-open', 'true');
    await user.click(screen.getByTestId('create-stake-form-stub-close'));
    expect(screen.getByTestId('create-stake-form-stub')).toHaveAttribute('data-open', 'false');
  });

  it('renders a loading affordance while the subscription is pending', async () => {
    mockStakes(undefined, true);
    await renderPage();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders the empty state when there are zero stakes', async () => {
    mockStakes([]);
    await renderPage();
    expect(screen.getByText(/no stakes provisioned yet/i)).toBeInTheDocument();
  });

  it('renders one row per stake with name, slug, created_at, and deep-link', async () => {
    mockStakes([
      makeStake({ id: 'csnorth', stake_name: 'CS North Stake' }),
      makeStake({
        id: 'eaststake',
        stake_name: 'East Stake',
        created_at: ts('2026-04-10T12:00:00Z'),
      }),
    ]);
    await renderPage();
    expect(screen.getByTestId('superadmin-stake-row-csnorth')).toBeInTheDocument();
    expect(screen.getByTestId('superadmin-stake-row-eaststake')).toBeInTheDocument();
    expect(screen.getByText('CS North Stake')).toBeInTheDocument();
    expect(screen.getByText('East Stake')).toBeInTheDocument();
    expect(screen.getByTestId('superadmin-stake-slug-csnorth')).toHaveTextContent('csnorth');
    // 12.4: the row link deep-links via `?stake=<slug>` so a click
    // resolves the target stake on arrival.
    expect(screen.getByTestId('superadmin-stake-link-csnorth')).toHaveAttribute(
      'href',
      '/manager/dashboard?stake=csnorth',
    );
    expect(screen.getByTestId('superadmin-stake-link-eaststake')).toHaveAttribute(
      'href',
      '/manager/dashboard?stake=eaststake',
    );
  });

  it('mounts the Apply Fixes menu on every stake row', async () => {
    mockStakes([
      makeStake({ id: 'csnorth' }),
      makeStake({ id: 'eaststake', created_at: ts('2026-04-10T12:00:00Z') }),
    ]);
    await renderPage();
    expect(screen.getByTestId('apply-fixes-menu-stub-csnorth')).toBeInTheDocument();
    expect(screen.getByTestId('apply-fixes-menu-stub-eaststake')).toBeInTheDocument();
  });

  it('renders the slug, deep-link, and Apply Fixes menu from the doc-id-derived id', async () => {
    // `useStakes()` injects the Firestore doc id as `stake.id`, so the
    // hand-seeded bootstrap stake (whose stored doc carries no id field)
    // still arrives with `id` set. The page renders the slug, the
    // `?stake=<slug>` deep-link, and wires the Apply Fixes menu off that
    // id — none of which may ever be `undefined`.
    mockStakes([makeStake({ id: 'csnorth', stake_name: 'CS North Stake' })]);
    await renderPage();
    expect(screen.getByTestId('superadmin-stake-slug-csnorth')).toHaveTextContent('csnorth');
    expect(screen.getByTestId('superadmin-stake-link-csnorth')).toHaveAttribute(
      'href',
      '/manager/dashboard?stake=csnorth',
    );
    expect(screen.getByTestId('apply-fixes-menu-stub-csnorth')).toBeInTheDocument();
  });

  it('sorts rows by created_at ascending (oldest first)', async () => {
    // Pass rows out of order; the page sorts them.
    mockStakes([
      makeStake({
        id: 'newer',
        stake_name: 'Newer Stake',
        created_at: ts('2026-04-20T00:00:00Z'),
      }),
      makeStake({
        id: 'older',
        stake_name: 'Older Stake',
        created_at: ts('2026-01-05T00:00:00Z'),
      }),
      makeStake({
        id: 'middle',
        stake_name: 'Middle Stake',
        created_at: ts('2026-02-15T00:00:00Z'),
      }),
    ]);
    await renderPage();
    const items = screen.getByTestId('superadmin-stake-list-items').querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[0]?.getAttribute('data-testid')).toBe('superadmin-stake-row-older');
    expect(items[1]?.getAttribute('data-testid')).toBe('superadmin-stake-row-middle');
    expect(items[2]?.getAttribute('data-testid')).toBe('superadmin-stake-row-newer');
  });

  it('renders the Setup complete pill for `setup_complete === true`', async () => {
    mockStakes([makeStake({ id: 'csnorth', setup_complete: true })]);
    await renderPage();
    expect(screen.getByTestId('superadmin-stake-setup-complete')).toBeInTheDocument();
    expect(screen.queryByTestId('superadmin-stake-setup-pending')).toBeNull();
  });

  it('renders the Setup pending pill for `setup_complete === false`', async () => {
    mockStakes([makeStake({ id: 'newish', setup_complete: false })]);
    await renderPage();
    expect(screen.getByTestId('superadmin-stake-setup-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('superadmin-stake-setup-complete')).toBeNull();
  });

  it('renders created_at formatted in the stake’s own timezone', async () => {
    // 2026-04-01T00:30:00Z in America/Denver (UTC-6 in April under DST)
    // is 2026-03-31 in local calendar terms. Asserting that the local
    // date appears (not the UTC date) verifies the page honours the
    // stake's tz field.
    mockStakes([
      makeStake({
        id: 'tz-test',
        created_at: ts('2026-04-01T00:30:00Z'),
        timezone: 'America/Denver',
      }),
    ]);
    await renderPage();
    expect(screen.getByText(/Created 2026-03-31/)).toBeInTheDocument();
  });
});
