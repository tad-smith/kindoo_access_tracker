// Component tests for the Configuration page. Each tab is exercised
// once: list rendering + form validation. Mutations are mocked.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type {
  AccessRequest,
  Building,
  KindooManager,
  KindooSite,
  Organization,
  ScheduledTask,
  Seat,
  Stake,
  StakeSchedule,
  TimestampLike,
  Ward,
} from '@kindoo/shared';
import { unitNameCollisionMessage } from '@kindoo/shared';

const useStakeDocMock = vi.fn();
const useWardsMock = vi.fn();
const useBuildingsMock = vi.fn();
const useManagersMock = vi.fn();
const useKindooSitesMock = vi.fn();
const useSeatsMock = vi.fn();
const useRequestsMock = vi.fn();
const navigateMock = vi.fn().mockResolvedValue(undefined);

const upsertKindooSiteMock = vi.fn();
const deleteKindooSiteMock = vi.fn();
const upsertWardMock = vi.fn();
const upsertBuildingMock = vi.fn();
const upsertOrganizationMock = vi.fn();
const deleteOrganizationMock = vi.fn();
const useOrganizationsMock = vi.fn();
const updateStakeConfigMock = vi.fn();
const updateIgnoredWardsMock = vi.fn();
const updateHomeKindooSiteMock = vi.fn();
const usePrincipalMock = vi.fn();
const backfillEqPresidentAccessMock = vi.fn();
const useStakeScheduleMock = vi.fn();
const setSyncReminderEnabledMock = vi.fn();
const setStakeToggleMock = vi.fn();

vi.mock('./hooks', () => ({
  useStakeDoc: () => useStakeDocMock(),
  useWards: () => useWardsMock(),
  useBuildings: () => useBuildingsMock(),
  useManagers: () => useManagersMock(),
  useKindooSites: () => useKindooSitesMock(),
  useSeats: () => useSeatsMock(),
  useRequests: () => useRequestsMock(),
  useUpsertWardMutation: () => ({ mutateAsync: upsertWardMock, isPending: false }),
  useDeleteWardMutation: () => ({ mutateAsync: vi.fn() }),
  useUpsertBuildingMutation: () => ({ mutateAsync: upsertBuildingMock, isPending: false }),
  useDeleteBuildingMutation: () => ({ mutateAsync: vi.fn() }),
  useUpsertManagerMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteManagerMutation: () => ({ mutateAsync: vi.fn() }),
  useUpsertKindooSiteMutation: () => ({
    mutateAsync: upsertKindooSiteMock,
    isPending: false,
  }),
  useDeleteKindooSiteMutation: () => ({ mutateAsync: deleteKindooSiteMock }),
  useUpsertOrganizationMutation: () => ({ mutateAsync: upsertOrganizationMock, isPending: false }),
  useDeleteOrganizationMutation: () => ({ mutateAsync: deleteOrganizationMock }),
  useUpdateStakeConfigMutation: () => ({ mutateAsync: updateStakeConfigMock, isPending: false }),
  useSetStakeToggleMutation: () => ({ mutateAsync: setStakeToggleMock, isPending: false }),
  useUpdateIgnoredWardsMutation: () => ({ mutateAsync: updateIgnoredWardsMock, isPending: false }),
  useUpdateHomeKindooSiteMutation: () => ({
    mutateAsync: updateHomeKindooSiteMock,
    isPending: false,
  }),
  useBackfillEqPresidentAccessMutation: () => ({
    mutateAsync: backfillEqPresidentAccessMock,
    isPending: false,
  }),
  useStakeSchedule: () => useStakeScheduleMock(),
  useSetSyncReminderEnabledMutation: () => ({
    mutateAsync: setSyncReminderEnabledMock,
    isPending: false,
  }),
}));

// The Organizations tab reads its list from the neutral organizations
// module; keep the real pure helpers (sortOrganizations).
vi.mock('../../organizations/hooks', async () => {
  const actual = await vi.importActual<object>('../../organizations/hooks');
  return {
    ...actual,
    useOrganizations: () => useOrganizationsMock(),
  };
});

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

vi.mock('../../../lib/principal', () => ({
  usePrincipal: () => usePrincipalMock(),
}));

vi.mock('../../../lib/useActiveStake', () => ({
  useActiveStake: () => 'csnorth',
  // Member-data reads are gated separately (T-91): a superadmin holding
  // no role on the stake reaches this page but cannot read seats /
  // requests. These suites exercise the manager case, where both
  // resolve to the same stake.
  useMemberDataStake: () => 'csnorth',
}));

import { ConfigurationPage } from './ConfigurationPage';
import { WARD_NAME_BRANCH_WARNING, WARD_NAME_HINT } from '../../../lib/wardCopy';

function liveResult<T>(data: T[]) {
  return {
    data,
    error: null,
    status: 'success',
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  };
}

// Pending state for a live hook: snapshot hasn't yet arrived. Mirrors
// the shape `useFirestoreCollection` exposes during its initial load.
function loadingResult() {
  return {
    data: undefined,
    error: null,
    status: 'pending',
    isPending: true,
    isLoading: true,
    isSuccess: false,
    isError: false,
    isFetching: true,
    fetchStatus: 'fetching',
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// Stake-doc live result. `eq_president_app_access` is deliberately
// absent by default — the persisted field is optional and absent means
// off, which is what the Config tab must render.
function stakeDocResult(overrides: Partial<Stake> = {}) {
  return {
    data: {
      stake_name: 'My Stake',
      stake_seat_cap: 200,
      timezone: 'America/Denver',
      notifications_enabled: true,
      setup_complete: true,
      ...overrides,
    } satisfies Partial<Stake>,
    error: null,
    status: 'success',
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  };
}

// `stakeSchedules/{stakeId}` live result. `undefined` tasks models the
// document not existing yet — the state a stake sits in until the
// hourly dispatcher has seeded it once.
function scheduleDocResult(tasks: ScheduledTask[] | undefined) {
  return {
    data:
      tasks === undefined
        ? undefined
        : ({
            tasks,
            lastActor: { email: 'mgr@example.com', canonical: 'mgr@example.com' },
          } satisfies StakeSchedule),
    error: null,
    status: 'success',
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  };
}

// The frame before the `stakeSchedules/{stakeId}` snapshot lands. The
// stake doc gates this tab's render, so this state is always reached
// with the row already on screen — it is what every manager sees on
// every load of the Config tab.
function schedulePendingResult() {
  return {
    data: undefined,
    error: null,
    status: 'pending',
    isPending: true,
    isLoading: true,
    isSuccess: false,
    isError: false,
    isFetching: true,
    fetchStatus: 'fetching',
  };
}

function syncReminderRow(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    job: 'syncReminder',
    enabled: false,
    schedule: { type: 'daily', hour: 6 },
    ...overrides,
  };
}

function timestamp(iso: string): TimestampLike {
  const d = new Date(iso);
  return {
    seconds: Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
    toDate: () => d,
    toMillis: () => d.getTime(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateStakeConfigMock.mockResolvedValue(undefined);
  setStakeToggleMock.mockResolvedValue(undefined);
  setSyncReminderEnabledMock.mockResolvedValue(undefined);
  updateIgnoredWardsMock.mockResolvedValue(undefined);
  updateHomeKindooSiteMock.mockResolvedValue(undefined);
  // Default: an ordinary manager, not a platform superadmin.
  usePrincipalMock.mockReturnValue({
    email: 'mgr@example.com',
    canonical: 'mgr@example.com',
    isAuthenticated: true,
    isPlatformSuperadmin: false,
    managerStakes: ['csnorth'],
    stakeMemberStakes: [],
    bishopricWards: {},
  });
  // seats_matched is deliberately unequal to the figure the toast reports
  // (docs_written for grant) so the assertion fails if the toast reads the wrong field.
  backfillEqPresidentAccessMock.mockResolvedValue({
    ok: true,
    seats_matched: 7,
    docs_written: 3,
    docs_deleted: 0,
  });
  setSyncReminderEnabledMock.mockResolvedValue(undefined);
  // Default: the hourly dispatcher has seeded the reminder row and it
  // is off, which is the steady state for every stake until a manager
  // turns it on.
  useStakeScheduleMock.mockReturnValue(scheduleDocResult([syncReminderRow()]));
  useStakeDocMock.mockReturnValue(stakeDocResult());
  useWardsMock.mockReturnValue(liveResult<Ward>([]));
  useBuildingsMock.mockReturnValue(liveResult<Building>([]));
  useManagersMock.mockReturnValue(liveResult<KindooManager>([]));
  useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([]));
  useSeatsMock.mockReturnValue(liveResult<Seat>([]));
  useRequestsMock.mockReturnValue(liveResult<AccessRequest>([]));
  useOrganizationsMock.mockReturnValue(liveResult<Organization>([]));
});

describe('<ConfigurationPage />', () => {
  it('renders the Config tab by default (leftmost)', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    expect(screen.getByRole('heading', { name: /^Stake config$/ })).toBeInTheDocument();
  });

  it('does not render the Push Notifications panel inside the Config tab', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    // Panel lives at /notifications now; Configuration's Config tab
    // ends at the Save button.
    expect(screen.queryByTestId('push-notifications-panel')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Push Notifications' })).toBeNull();
  });

  it('switches to the Buildings tab when clicked', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-tab-buildings'));
    expect(navigateMock).toHaveBeenCalledWith(
      expect.objectContaining({ search: { tab: 'buildings' } }),
    );
  });

  it('renders the Buildings tab via initialTab prop', () => {
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    expect(screen.getByRole('heading', { name: /^Buildings$/ })).toBeInTheDocument();
  });

  it('renders the Managers tab list', () => {
    useManagersMock.mockReturnValue(
      liveResult<KindooManager>([
        {
          member_canonical: 'a@x.com',
          member_email: 'a@x.com',
          name: 'A',
          active: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]),
    );
    render(<ConfigurationPage initialTab="managers" />, { wrapper: Wrapper });
    expect(screen.getByText('a@x.com')).toBeInTheDocument();
  });

  it('renders the email-notifications switch with the email-specific label', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    // Scoped to the switch: the InfoTip beside it is also labelled with
    // the option's name ("More about …").
    const sw = screen.getByLabelText(/Email Notifications Enabled/i, {
      selector: '[role="switch"]',
    });
    expect(sw).toBeInTheDocument();
    expect(sw).toHaveAttribute('role', 'switch');
  });

  it('shows the Elders Quorum President switch unchecked when the stake field is absent', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    const sw = screen.getByTestId('config-eq-president-access');
    expect(sw).toHaveAttribute('role', 'switch');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(
      screen.getByLabelText(/Elders Quorum Presidents Get App Access/i, {
        selector: '[role="switch"]',
      }),
    ).toBe(sw);
  });

  it('shows the Elders Quorum President switch checked when the stake has opted in', () => {
    useStakeDocMock.mockReturnValue(stakeDocResult({ eq_president_app_access: true }));
    render(<ConfigurationPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-eq-president-access')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('does not render a Triggers tab', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    expect(screen.queryByTestId('config-tab-triggers')).toBeNull();
    expect(screen.queryByTestId('config-triggers')).toBeNull();
  });

  it('renders tabs in the operator-specified order (Buildings before Wards, Organizations last)', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    const labels = Array.from(document.querySelectorAll('.kd-config-tab')).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual([
      'Config',
      'Managers',
      'Kindoo Config',
      'Buildings',
      'Wards',
      'Organizations',
    ]);
  });

  it('does not render the Auto Ward / Stake Callings tabs', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    expect(screen.queryByTestId('config-tab-ward-callings')).toBeNull();
    expect(screen.queryByTestId('config-tab-stake-callings')).toBeNull();
    expect(screen.queryByText('Auto Ward Callings')).toBeNull();
    expect(screen.queryByText('Auto Stake Callings')).toBeNull();
  });

  it('disables Add Ward and shows a hint when no buildings exist', () => {
    useBuildingsMock.mockReturnValue(liveResult<Building>([]));
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-wards-add-button')).toBeDisabled();
    expect(screen.getByTestId('config-wards-no-buildings-hint')).toHaveTextContent(
      /Add a building first/i,
    );
  });

  it('enables Add Ward once at least one building exists', () => {
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        {
          building_id: 'maple-building',
          building_name: 'Maple Building',
          address: '',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]),
    );
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-wards-add-button')).not.toBeDisabled();
    expect(screen.queryByTestId('config-wards-no-buildings-hint')).toBeNull();
  });

  it('does not flash the no-buildings hint while buildings load (but Add stays gated)', () => {
    // Deep-linking ?tab=wards lands before the buildings snapshot
    // arrives. The empty-state hint must not fire on undefined data, or
    // stakes that DO have buildings briefly show "Add a building first".
    // Add itself stays disabled until the snapshot lands — opening the
    // dialog against an unhydrated catalogue would leave an empty
    // <Select> with no way to map the chosen building_id to a name.
    useBuildingsMock.mockReturnValue(loadingResult());
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    const btn = screen.getByTestId('config-wards-add-button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Loading…');
    // The known-empty hint must NOT show while loading.
    expect(screen.queryByTestId('config-wards-no-buildings-hint')).toBeNull();
  });

  it('gates Add Ward until the wards snapshot arrives, then feeds the guard the real list', async () => {
    // The unique-display-name guard runs against `wards.data`. While the
    // snapshot is unresolved an empty list reads as "nothing to collide
    // with", so a submit landing first would save unconditionally — and
    // the mutation's slug backstop can't catch it, since "Maple" and
    // "Maple Ward" slug to different doc ids. Same gate
    // IgnoredWardsSection uses on its own Add.
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { building_id: 'maple-building', building_name: 'Maple Building', address: '' } as any,
      ]),
    );
    useWardsMock.mockReturnValue(loadingResult());
    const user = userEvent.setup();
    const { rerender } = render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });

    const gated = screen.getByTestId('config-wards-add-button');
    expect(gated).toBeDisabled();
    expect(gated).toHaveAttribute('title', 'Loading…');
    // Buildings are known and non-empty, so the reason shown is the
    // load — not the wrong empty-catalogue hint.
    expect(screen.queryByTestId('config-wards-no-buildings-hint')).toBeNull();
    await user.click(gated);
    expect(screen.queryByTestId('config-ward-submit')).toBeNull();

    // Snapshot lands, carrying the ward that "Maple" collides with.
    const existingWards = [
      {
        ward_code: 'maple-ward',
        ward_name: 'Maple Ward',
        building_id: 'maple-building',
        building_name: 'Maple Building',
        seat_cap: 20,
      } as Ward,
    ];
    useWardsMock.mockReturnValue(liveResult<Ward>(existingWards));
    rerender(<ConfigurationPage initialTab="wards" />);

    expect(screen.getByTestId('config-wards-add-button')).not.toBeDisabled();
    await user.click(screen.getByTestId('config-wards-add-button'));
    await user.type(screen.getByLabelText(/^Ward or branch name$/), 'Maple');
    await user.selectOptions(screen.getByLabelText('Building'), 'maple-building');
    await user.click(screen.getByTestId('config-ward-submit'));

    // The guard (inside the mutation — see `duplicateWardNameBlocker`)
    // now receives the hydrated catalogue rather than an empty stand-in.
    await vi.waitFor(() => expect(upsertWardMock).toHaveBeenCalled());
    expect(upsertWardMock.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ ward_name: 'Maple', existingWards }),
    );
    // And that list is what makes the rule bite: the real shared rule
    // rejects "Maple" against the hydrated names, and stays silent
    // against the empty stand-in the un-gated code would have passed.
    const names = existingWards.map((w) => w.ward_name);
    expect(unitNameCollisionMessage('Maple', names)).toMatch(/are the same ward/i);
    expect(unitNameCollisionMessage('Maple', [])).toBeNull();
  });

  it('shows ward-form validation error on empty submit (modal-driven)', async () => {
    const user = userEvent.setup();
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { building_id: 'maple-building', building_name: 'Maple Building', address: '' } as any,
      ]),
    );
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-wards-add-button'));
    await user.click(screen.getByTestId('config-ward-submit'));
    expect(await screen.findByText(/Ward name is required/i)).toBeInTheDocument();
  });

  it('opens the Add Ward modal from the section header', async () => {
    const user = userEvent.setup();
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { building_id: 'maple-building', building_name: 'Maple Building', address: '' } as any,
      ]),
    );
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    expect(screen.queryByTestId('config-ward-form')).toBeNull();
    await user.click(screen.getByTestId('config-wards-add-button'));
    expect(screen.getByTestId('config-ward-form')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add ward' })).toBeInTheDocument();
  });

  it('opens the Edit Ward modal pre-populated; no ward code field is shown', async () => {
    const user = userEvent.setup();
    useWardsMock.mockReturnValue(
      liveResult<Ward>([
        {
          ward_code: 'CO',
          ward_name: 'Maple',
          building_name: 'Maple Building',
          seat_cap: 22,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]),
    );
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-ward-edit-CO'));
    // The ward name is the only visible identifier; the code is hidden.
    expect((screen.getByLabelText(/^Ward or branch name$/) as HTMLInputElement).value).toBe(
      'Maple',
    );
    expect(screen.queryByLabelText(/Ward code/i)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Edit ward' })).toBeInTheDocument();
  });

  it('preselects the building by building_id when editing a migrated ward', async () => {
    const user = userEvent.setup();
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { building_id: 'pine-building', building_name: 'Pine Building', address: '' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { building_id: 'maple-building', building_name: 'Maple Building', address: '' } as any,
      ]),
    );
    useWardsMock.mockReturnValue(
      liveResult<Ward>([
        {
          ward_code: 'CO',
          ward_name: 'Maple',
          building_id: 'maple-building',
          building_name: 'Maple Building',
          seat_cap: 22,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]),
    );
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-ward-edit-CO'));
    const select = screen.getByLabelText('Building') as HTMLSelectElement;
    // The option value is the immutable slug, not the display name.
    expect(select.value).toBe('maple-building');
  });

  it('preselects the building for a legacy ward (no building_id) via the name fallback', async () => {
    const user = userEvent.setup();
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { building_id: 'maple-building', building_name: 'Maple Building', address: '' } as any,
      ]),
    );
    useWardsMock.mockReturnValue(
      liveResult<Ward>([
        {
          ward_code: 'CO',
          ward_name: 'Maple',
          // No building_id — legacy ward; resolve the slug from the name.
          building_name: 'Maple Building',
          seat_cap: 22,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]),
    );
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-ward-edit-CO'));
    const select = screen.getByLabelText('Building') as HTMLSelectElement;
    expect(select.value).toBe('maple-building');
  });

  it('gives the same ward-or-branch naming hint as the bootstrap wizard', async () => {
    const user = userEvent.setup();
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { building_id: 'maple-building', building_name: 'Maple Building', address: '' } as any,
      ]),
    );
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-wards-add-button'));
    const dialog = within(screen.getByTestId('config-ward-form'));
    expect(dialog.getByLabelText(/^Ward or branch name$/)).toBeInTheDocument();
    expect(dialog.getByText(WARD_NAME_HINT)).toBeInTheDocument();
  });

  /** Render the Wards tab with one building and open the Add ward dialog. */
  async function openWardDialog(user: ReturnType<typeof userEvent.setup>) {
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { building_id: 'maple-building', building_name: 'Maple Building', address: '' } as any,
      ]),
    );
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-wards-add-button'));
    return screen.getByLabelText(/^Ward or branch name$/);
  }

  it('warns under the ward-name field as soon as the typed name reads as a branch', async () => {
    const user = userEvent.setup();
    const input = await openWardDialog(user);
    expect(screen.queryByTestId('config-ward-branch-warning')).toBeNull();

    await user.type(input, 'Olive Branch');
    const warning = await screen.findByTestId('config-ward-branch-warning');
    expect(warning).toHaveTextContent(WARD_NAME_BRANCH_WARNING);
    // Advisory only — it must never gate the submit button.
    expect(screen.getByTestId('config-ward-submit')).toBeEnabled();
  });

  it('hides the branch warning again once the name no longer ends in " Branch"', async () => {
    const user = userEvent.setup();
    const input = await openWardDialog(user);

    await user.type(input, 'Olive Branch');
    expect(await screen.findByTestId('config-ward-branch-warning')).toBeInTheDocument();

    await user.type(input, ' Ward');
    await waitFor(() => expect(screen.queryByTestId('config-ward-branch-warning')).toBeNull());

    await user.clear(input);
    expect(screen.queryByTestId('config-ward-branch-warning')).toBeNull();
  });

  it('leaves the branch warning hidden for a plain ward name', async () => {
    const user = userEvent.setup();
    const input = await openWardDialog(user);
    await user.type(input, 'Maple');
    expect(screen.queryByTestId('config-ward-branch-warning')).toBeNull();
  });

  it('leaves the branch warning hidden for a name ending in "Branch" with no preceding space', async () => {
    const user = userEvent.setup();
    const input = await openWardDialog(user);
    // Mirrors the classifier's /\sbranch$/i — "Branchville" is a ward,
    // and so is the degenerate single word "Branch".
    await user.type(input, 'Branchville');
    expect(screen.queryByTestId('config-ward-branch-warning')).toBeNull();

    await user.clear(input);
    await user.type(input, 'Branch');
    expect(screen.queryByTestId('config-ward-branch-warning')).toBeNull();
  });

  it('writes both building_id and building_name when a ward is saved', async () => {
    const user = userEvent.setup();
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { building_id: 'maple-building', building_name: 'Maple Building', address: '' } as any,
      ]),
    );
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-wards-add-button'));
    await user.type(screen.getByLabelText(/^Ward or branch name$/), 'Maple');
    await user.selectOptions(screen.getByLabelText('Building'), 'maple-building');
    await user.click(screen.getByTestId('config-ward-submit'));
    await vi.waitFor(() => expect(upsertWardMock).toHaveBeenCalled());
    const arg = upsertWardMock.mock.calls[0]![0];
    expect(arg).toEqual(
      expect.objectContaining({
        ward_name: 'Maple',
        building_id: 'maple-building',
        building_name: 'Maple Building',
      }),
    );
    // On create the code is derived by the mutation, not passed from the form.
    expect(arg).not.toHaveProperty('ward_code');
  });

  it('renders an Edit button on each Building row; building_id is never shown in form', async () => {
    const user = userEvent.setup();
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        {
          building_id: 'maple-building',
          building_name: 'Maple Building',
          address: '123 Main',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]),
    );
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-building-edit-maple-building'));
    expect(screen.getByLabelText(/Name/i)).toHaveValue('Maple Building');
    expect(screen.queryByLabelText(/building.?id/i)).toBeNull();
  });

  it('manager add modal has no Active checkbox', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPage initialTab="managers" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-managers-add-button'));
    expect(screen.queryByLabelText(/^Active$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Active/i })).not.toBeInTheDocument();
  });

  it('disables the Delete button when only one Kindoo Manager remains', () => {
    useManagersMock.mockReturnValue(
      liveResult<KindooManager>([
        {
          member_canonical: 'lonely@x.com',
          member_email: 'lonely@x.com',
          name: 'Lonely',
          active: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]),
    );
    render(<ConfigurationPage initialTab="managers" />, { wrapper: Wrapper });
    const btn = screen.getByTestId('config-manager-delete-lonely@x.com');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Cannot remove the last Kindoo Manager.');
  });

  it('enables Delete on every Kindoo Manager when two or more exist', () => {
    useManagersMock.mockReturnValue(
      liveResult<KindooManager>([
        {
          member_canonical: 'a@x.com',
          member_email: 'a@x.com',
          name: 'A',
          active: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        {
          member_canonical: 'b@x.com',
          member_email: 'b@x.com',
          name: 'B',
          active: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]),
    );
    render(<ConfigurationPage initialTab="managers" />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-manager-delete-a@x.com')).not.toBeDisabled();
    expect(screen.getByTestId('config-manager-delete-b@x.com')).not.toBeDisabled();
  });

  it('wraps the page in the wide-width container (1023px max)', () => {
    const { container } = render(<ConfigurationPage />, { wrapper: Wrapper });
    expect(container.querySelector('section.kd-page-wide')).not.toBeNull();
  });
});

describe('Kindoo Sites tab', () => {
  // `kindoo_eid` is extension-populated (Phase 3); the manager UI
  // neither displays nor edits it. Fixtures still set it to pin that
  // the row UI does NOT surface it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mkSite = (overrides: Partial<KindooSite> = {}): KindooSite => ({
    id: 'east-stake',
    display_name: 'East Stake',
    kindoo_expected_site_name: 'East Stake CS',
    kindoo_eid: 42,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides as any),
  });

  it('shows the empty state when no foreign sites exist', () => {
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([]));
    render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-kindoo-sites-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('config-kindoo-sites-list')).toBeNull();
  });

  it('renders foreign-site rows with display_name and site name only (no EID)', () => {
    useKindooSitesMock.mockReturnValue(
      liveResult<KindooSite>([
        mkSite({
          id: 'east',
          display_name: 'East',
          kindoo_expected_site_name: 'East CS',
          kindoo_eid: 7,
        }),
      ]),
    );
    render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
    const row = screen.getByTestId('config-kindoo-sites-row-east');
    expect(row).toBeInTheDocument();
    expect(row.textContent).toContain('East');
    expect(row.textContent).toContain('East CS');
    // EID is intentionally not displayed.
    expect(row.textContent).not.toContain('EID');
    expect(row.textContent).not.toContain('7');
  });

  it('submits the Add form with display_name and site name (no EID field)', async () => {
    const user = userEvent.setup();
    upsertKindooSiteMock.mockResolvedValue(undefined);
    render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-kindoo-sites-add-button'));
    // The form must not expose Kindoo EID — extension-populated.
    expect(screen.queryByLabelText(/Kindoo EID/i)).toBeNull();
    await user.type(screen.getByLabelText(/Display name/i), 'East Stake');
    await user.type(screen.getByLabelText(/Kindoo site name/i), 'East Stake CS');
    await user.click(screen.getByTestId('config-kindoo-site-submit'));
    expect(upsertKindooSiteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        display_name: 'East Stake',
        kindoo_expected_site_name: 'East Stake CS',
      }),
    );
    // Mutation payload must not carry `kindoo_eid` from the form.
    expect(upsertKindooSiteMock.mock.calls[0]?.[0]).not.toHaveProperty('kindoo_eid');
  });

  it('rejects empty display_name on Add submit', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-kindoo-sites-add-button'));
    await user.click(screen.getByTestId('config-kindoo-site-submit'));
    expect(await screen.findByText(/Display name is required/i)).toBeInTheDocument();
  });

  it('rejects empty Kindoo site name on Add submit', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-kindoo-sites-add-button'));
    await user.type(screen.getByLabelText(/Display name/i), 'OK');
    await user.click(screen.getByTestId('config-kindoo-site-submit'));
    expect(await screen.findByText(/Kindoo site name is required/i)).toBeInTheDocument();
  });

  it('opens the Edit modal pre-populated (no EID input)', async () => {
    const user = userEvent.setup();
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([mkSite()]));
    render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-kindoo-site-edit-east-stake'));
    expect(
      screen.getByRole('heading', { name: /Edit Kindoo site — East Stake/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Display name/i)).toHaveValue('East Stake');
    expect(screen.getByLabelText(/Kindoo site name/i)).toHaveValue('East Stake CS');
    expect(screen.queryByLabelText(/Kindoo EID/i)).toBeNull();
  });

  it('Edit submit passes the existing id through to the mutation (no EID)', async () => {
    const user = userEvent.setup();
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([mkSite()]));
    upsertKindooSiteMock.mockResolvedValue(undefined);
    render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-kindoo-site-edit-east-stake'));
    const nameInput = screen.getByLabelText(/Kindoo site name/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed CS');
    await user.click(screen.getByTestId('config-kindoo-site-submit'));
    expect(upsertKindooSiteMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'east-stake', kindoo_expected_site_name: 'Renamed CS' }),
    );
    expect(upsertKindooSiteMock.mock.calls[0]?.[0]).not.toHaveProperty('kindoo_eid');
  });

  it('Delete calls the delete mutation with the doc id and live buildings snapshot', async () => {
    const user = userEvent.setup();
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([mkSite()]));
    const buildingRef = {
      building_id: 'other-building',
      building_name: 'Other Building',
      kindoo_site_id: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    useBuildingsMock.mockReturnValue(liveResult<Building>([buildingRef]));
    deleteKindooSiteMock.mockResolvedValue(undefined);
    render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-kindoo-site-delete-east-stake'));
    expect(deleteKindooSiteMock).toHaveBeenCalledWith({
      kindooSiteId: 'east-stake',
      buildings: [buildingRef],
    });
  });

  it('Delete surfaces the FK ref-guard error via toast when a building still references the site', async () => {
    const { useToastStore } = await import('../../../lib/store/toast');
    useToastStore.getState().clear();
    const user = userEvent.setup();
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([mkSite()]));
    const blockingBuilding = {
      building_id: 'pine',
      building_name: 'Pine Stake Center',
      kindoo_site_id: 'east-stake',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    useBuildingsMock.mockReturnValue(liveResult<Building>([blockingBuilding]));
    // Mimic the real hook: throw the blocker string when a building refs.
    deleteKindooSiteMock.mockImplementation(async (input: { kindooSiteId: string }) => {
      throw new Error(
        `Cannot delete Kindoo site "${input.kindooSiteId}". The following buildings still reference this site: Pine Stake Center Unassign these buildings from this site before deleting.`,
      );
    });
    render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-kindoo-site-delete-east-stake'));
    // Toast host isn't mounted in this test wrapper; assert against
    // the store the page handler pushes into.
    await vi.waitFor(() => {
      const errorToasts = useToastStore.getState().toasts.filter((t) => t.kind === 'error');
      expect(errorToasts).toHaveLength(1);
      expect(errorToasts[0]!.message).toContain('Cannot delete Kindoo site "east-stake"');
      expect(errorToasts[0]!.message).toContain('Pine Stake Center');
    });
  });
});

describe('Home Kindoo Site (Kindoo Config tab)', () => {
  function renderTab(stakeOverrides: Partial<Stake> = {}, superadmin = false) {
    useStakeDocMock.mockReturnValue(stakeDocResult(stakeOverrides));
    usePrincipalMock.mockReturnValue({
      email: 'x@example.com',
      canonical: 'x@example.com',
      isAuthenticated: true,
      isPlatformSuperadmin: superadmin,
      managerStakes: ['csnorth'],
      stakeMemberStakes: [],
      bishopricWards: {},
    });
    render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
  }

  it('renders first on the tab, above Foreign Kindoo Sites', () => {
    renderTab();
    const home = screen.getByTestId('config-home-kindoo-site');
    const foreign = screen.getByTestId('config-kindoo-sites-add-button');
    expect(home.compareDocumentPosition(foreign) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the configured site name and EID', () => {
    renderTab({
      kindoo_expected_site_name: 'Black Forest',
      kindoo_config: { site_id: 27994 },
    } as Partial<Stake>);
    expect(screen.getByTestId('config-home-site-name')).toHaveTextContent('Black Forest');
    expect(screen.getByTestId('config-home-site-eid')).toHaveTextContent('27994');
  });

  it('falls back to the stake name when kindoo_expected_site_name is unset', () => {
    // Same fallback the description parser and the wizard's home-by-name
    // resolution apply, so the row shows what they actually compare against.
    renderTab();
    expect(screen.getByTestId('config-home-site-name')).toHaveTextContent('My Stake');
    expect(screen.getByText(/defaults to the stake name/)).toBeInTheDocument();
  });

  it('says the EID is not set when the wizard has never run', () => {
    renderTab();
    expect(screen.getByTestId('config-home-site-eid')).toHaveTextContent('Not set');
  });

  it('offers no Edit button to a manager who is not a platform superadmin', () => {
    renderTab({}, false);
    expect(screen.queryByTestId('config-home-kindoo-site-edit')).toBeNull();
  });

  it('offers Edit to a superadmin who holds no role on this stake', () => {
    // T-91: the rule admits them now (with `setup_complete` and
    // `bootstrap_admin_email` pinned), so the manager half of the old
    // gate is no longer what the write requires — and this persona is
    // the one the surface exists for.
    useStakeDocMock.mockReturnValue(stakeDocResult());
    usePrincipalMock.mockReturnValue({
      email: 'sa@example.com',
      canonical: 'sa@example.com',
      isAuthenticated: true,
      isPlatformSuperadmin: true,
      managerStakes: [],
      stakeMemberStakes: [],
      bishopricWards: {},
    });
    render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-home-kindoo-site')).toBeInTheDocument();
    expect(screen.getByTestId('config-home-kindoo-site-edit')).toBeInTheDocument();
  });

  it('lets a platform superadmin edit and save both values', async () => {
    const user = userEvent.setup();
    renderTab({ kindoo_expected_site_name: 'Old Name' } as Partial<Stake>, true);
    await user.click(screen.getByTestId('config-home-kindoo-site-edit'));
    const nameInput = screen.getByTestId('config-home-site-name-input');
    await user.clear(nameInput);
    await user.type(nameInput, 'Black Forest');
    const eidInput = screen.getByTestId('config-home-site-eid-input');
    await user.clear(eidInput);
    await user.type(eidInput, '27994');
    await user.click(screen.getByTestId('config-home-kindoo-site-save'));
    expect(updateHomeKindooSiteMock).toHaveBeenCalledWith({
      siteName: 'Black Forest',
      eid: 27994,
    });
  });

  it('rejects a non-positive EID', async () => {
    const user = userEvent.setup();
    renderTab({}, true);
    await user.click(screen.getByTestId('config-home-kindoo-site-edit'));
    const eidInput = screen.getByTestId('config-home-site-eid-input');
    await user.clear(eidInput);
    await user.type(eidInput, '0');
    await user.click(screen.getByTestId('config-home-kindoo-site-save'));
    expect(await screen.findByText(/EID must be greater than 0/)).toBeInTheDocument();
    expect(updateHomeKindooSiteMock).not.toHaveBeenCalled();
  });

  it('locks the EID field once it is set, and says why', async () => {
    // Write-once (T-92). The mutation enforces it; this keeps the
    // operator from meeting the rule as an error.
    const user = userEvent.setup();
    renderTab({ kindoo_config: { site_id: 27994 } } as Partial<Stake>, true);
    await user.click(screen.getByTestId('config-home-kindoo-site-edit'));
    expect(screen.getByTestId('config-home-site-eid-input')).toHaveAttribute('readonly');
    expect(screen.getByTestId('config-home-site-eid-locked')).toHaveTextContent(
      /Configure Kindoo wizard/,
    );
    // The name stays editable — only the EID is write-once.
    expect(screen.getByTestId('config-home-site-name-input')).not.toHaveAttribute('readonly');
  });

  it('leaves the EID editable while it is unset', async () => {
    const user = userEvent.setup();
    renderTab({}, true);
    await user.click(screen.getByTestId('config-home-kindoo-site-edit'));
    expect(screen.getByTestId('config-home-site-eid-input')).not.toHaveAttribute('readonly');
    expect(screen.queryByTestId('config-home-site-eid-locked')).toBeNull();
  });

  it('withholds Edit until the stake snapshot arrives', () => {
    // `useForm` captures defaults once; opening before the doc lands
    // prefills empty and a save then overwrites a real
    // `kindoo_expected_site_name`.
    useStakeDocMock.mockReturnValue(loadingResult());
    usePrincipalMock.mockReturnValue({
      email: 'sa@example.com',
      canonical: 'sa@example.com',
      isAuthenticated: true,
      isPlatformSuperadmin: true,
      managerStakes: ['csnorth'],
      stakeMemberStakes: [],
      bishopricWards: {},
    });
    render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
    expect(screen.queryByTestId('config-home-kindoo-site-edit')).toBeNull();
  });

  it('cancels back to the read-only rows without writing', async () => {
    const user = userEvent.setup();
    renderTab({}, true);
    await user.click(screen.getByTestId('config-home-kindoo-site-edit'));
    await user.click(screen.getByTestId('config-home-kindoo-site-cancel'));
    expect(screen.getByTestId('config-home-kindoo-site-rows')).toBeInTheDocument();
    expect(updateHomeKindooSiteMock).not.toHaveBeenCalled();
  });
});

describe('Wards to Ignore in Kindoo (Kindoo Config tab)', () => {
  // Wards of a NEIGHBOURING stake that show up in one of our Kindoo
  // sites. Sync skips them; without the list they read as members
  // missing a seat.

  const mkWard = (name: string): Ward =>
    ({ ward_code: name.toLowerCase().replace(/\s+/g, '-'), ward_name: name }) as Ward;

  function renderTab(ignored?: string[], wards: Ward[] = []) {
    useStakeDocMock.mockReturnValue(
      stakeDocResult(ignored ? { kindoo_ignored_wards: ignored } : {}),
    );
    useWardsMock.mockReturnValue(liveResult<Ward>(wards));
    render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
  }

  /** Open the Add dialog and type an entry. */
  async function openAndType(user: ReturnType<typeof userEvent.setup>, text: string) {
    await user.click(screen.getByTestId('config-ignored-wards-add-button'));
    await user.type(screen.getByTestId('config-ignored-ward-input'), text);
  }

  it('labels its field for a branch too, but asks for the name verbatim rather than the create-ward suffix rule', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByTestId('config-ignored-wards-add-button'));
    const dialog = within(screen.getByTestId('config-ignored-ward-form'));
    expect(dialog.getByLabelText(/^Ward or branch name$/)).toBeInTheDocument();
    // Matching is against Kindoo's description text, so no suffix is
    // optional here — the create-ward hint would be wrong guidance.
    expect(screen.getByPlaceholderText('Ward name as Kindoo shows it')).toBeInTheDocument();
    expect(screen.queryByText(WARD_NAME_HINT)).toBeNull();
  });

  it('stays silent when an ignored-ward entry names a branch', async () => {
    const user = userEvent.setup();
    renderTab(undefined, [mkWard('Maple')]);
    // A neighbouring stake's branch is an ordinary entry here — the
    // create-ward branch warning would be noise, and it names the wrong
    // remedy (the " Ward" suffix is not optional on this field).
    await openAndType(user, 'Peterson Branch');
    expect(screen.queryByText(WARD_NAME_BRANCH_WARNING)).toBeNull();
    expect(screen.queryByTestId('config-ward-branch-warning')).toBeNull();
  });

  it('renders under the Foreign Kindoo Sites list with the empty state', () => {
    renderTab();
    expect(screen.getByTestId('config-ignored-wards')).toBeInTheDocument();
    expect(screen.getByTestId('config-ignored-wards-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('config-ignored-wards-list')).toBeNull();
  });

  it('puts Add Ward to Ignore on the section header, not an inline row', () => {
    renderTab();
    expect(screen.getByTestId('config-ignored-wards-add-button')).toHaveTextContent(
      'Add Ward to Ignore',
    );
    // No form until the dialog opens.
    expect(screen.queryByTestId('config-ignored-ward-input')).toBeNull();
  });

  it('closes the dialog on Cancel without writing', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByTestId('config-ignored-wards-add-button'));
    expect(screen.getByTestId('config-ignored-ward-form')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('config-ignored-ward-form')).toBeNull());
    expect(updateIgnoredWardsMock).not.toHaveBeenCalled();
  });

  it('gates the Add button until the wards snapshot arrives', () => {
    // The dialog's own-ward guard runs against it; an empty array would
    // wave through an entry that silently does nothing.
    useStakeDocMock.mockReturnValue(stakeDocResult());
    useWardsMock.mockReturnValue(loadingResult());
    render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-ignored-wards-add-button')).toBeDisabled();
  });

  it('lists the configured wards', () => {
    renderTab(['Aspen Grove Ward', 'Black Forest 2nd Ward']);
    expect(screen.getByTestId('config-ignored-ward-row-Aspen Grove Ward')).toBeInTheDocument();
    expect(screen.getByTestId('config-ignored-ward-row-Black Forest 2nd Ward')).toBeInTheDocument();
    expect(screen.queryByTestId('config-ignored-wards-empty')).toBeNull();
  });

  it('appends a trimmed entry to the existing list', async () => {
    const user = userEvent.setup();
    renderTab(['Aspen Grove Ward']);
    await openAndType(user, '  Black Forest 2nd Ward  ');
    await user.click(screen.getByTestId('config-ignored-ward-submit'));
    await waitFor(() =>
      expect(updateIgnoredWardsMock).toHaveBeenCalledWith([
        'Aspen Grove Ward',
        'Black Forest 2nd Ward',
      ]),
    );
  });

  it('removes an entry, leaving the rest', async () => {
    const user = userEvent.setup();
    renderTab(['Aspen Grove Ward', 'Black Forest 2nd Ward']);
    await user.click(screen.getByTestId('config-ignored-ward-delete-Aspen Grove Ward'));
    expect(updateIgnoredWardsMock).toHaveBeenCalledWith(['Black Forest 2nd Ward']);
  });

  it('blocks a pasted description and says to drop the calling', async () => {
    // The likeliest mistake: matching is on the ward name alone, so
    // `Aspen Grove Ward (Bishop)` would sit in the list matching nothing.
    const user = userEvent.setup();
    renderTab();
    await openAndType(user, 'Aspen Grove Ward (Bishop)');
    expect(await screen.findByTestId('config-ignored-ward-error')).toHaveTextContent(
      /drop the calling in parentheses/,
    );
    await user.click(screen.getByTestId('config-ignored-ward-submit'));
    expect(updateIgnoredWardsMock).not.toHaveBeenCalled();
  });

  it('blocks a case-insensitive duplicate', async () => {
    const user = userEvent.setup();
    renderTab(['Aspen Grove Ward']);
    await openAndType(user, 'aspen grove ward');
    expect(await screen.findByTestId('config-ignored-ward-error')).toHaveTextContent(
      /already on the list/,
    );
    await user.click(screen.getByTestId('config-ignored-ward-submit'));
    expect(updateIgnoredWardsMock).not.toHaveBeenCalled();
  });

  it('blocks an entry naming one of our own wards, in either form', async () => {
    // SBA stores the name without the trailing " Ward"; Kindoo
    // descriptions carry it. Both forms must be caught.
    const user = userEvent.setup();
    renderTab([], [mkWard('Maple')]);
    await openAndType(user, 'Maple Ward');
    expect(await screen.findByTestId('config-ignored-ward-error')).toHaveTextContent(
      /one of your own/,
    );
    const input = screen.getByTestId('config-ignored-ward-input');
    await user.clear(input);
    await user.type(input, 'maple');
    expect(await screen.findByTestId('config-ignored-ward-error')).toHaveTextContent(
      /one of your own/,
    );
    await user.click(screen.getByTestId('config-ignored-ward-submit'));
    expect(updateIgnoredWardsMock).not.toHaveBeenCalled();
  });

  it('allows a ward name this stake does not own', async () => {
    const user = userEvent.setup();
    renderTab([], [mkWard('Maple')]);
    await openAndType(user, 'Aspen Grove Ward');
    expect(screen.queryByTestId('config-ignored-ward-error')).toBeNull();
    await user.click(screen.getByTestId('config-ignored-ward-submit'));
    await waitFor(() => expect(updateIgnoredWardsMock).toHaveBeenCalledWith(['Aspen Grove Ward']));
  });

  it('refuses an empty or whitespace-only entry', async () => {
    const user = userEvent.setup();
    renderTab();
    await openAndType(user, '   ');
    await user.click(screen.getByTestId('config-ignored-ward-submit'));
    expect(await screen.findByTestId('config-ignored-ward-error')).toHaveTextContent(
      /Ward name is required/,
    );
    expect(updateIgnoredWardsMock).not.toHaveBeenCalled();
  });
});

describe('Building dialog Kindoo Site field', () => {
  // The `kindoo_site_id` dropdown moved off the inline list rows and
  // into the Building create/edit dialog.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const building = (overrides: Partial<Building> = {}): Building => ({
    building_id: 'maple-building',
    building_name: 'Maple Building',
    address: '123 Main',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides as any),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const site = (overrides: Partial<KindooSite> = {}): KindooSite => ({
    id: 'east',
    display_name: 'East',
    kindoo_expected_site_name: 'East CS',
    kindoo_eid: 5,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides as any),
  });

  it('does not render a Kindoo Site dropdown on the list row', () => {
    useBuildingsMock.mockReturnValue(liveResult<Building>([building()]));
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([site()]));
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    expect(screen.queryByTestId('config-building-kindoo-site-maple-building')).toBeNull();
  });

  it('Edit dialog defaults Kindoo Site to Home for a home-site building', async () => {
    const user = userEvent.setup();
    useBuildingsMock.mockReturnValue(liveResult<Building>([building()]));
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([site()]));
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-building-edit-maple-building'));
    const dd = screen.getByTestId('config-building-kindoo-site') as HTMLSelectElement;
    expect(Array.from(dd.options).map((o) => o.text)).toEqual(['Home', 'East']);
    expect(dd.value).toBe('__home__');
  });

  it('Edit dialog pre-selects the existing kindoo_site_id', async () => {
    const user = userEvent.setup();
    useBuildingsMock.mockReturnValue(liveResult<Building>([building({ kindoo_site_id: 'east' })]));
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([site()]));
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-building-edit-maple-building'));
    const dd = screen.getByTestId('config-building-kindoo-site') as HTMLSelectElement;
    expect(dd.value).toBe('east');
  });

  it('Edit submit writes the selected kindoo_site_id through the building upsert', async () => {
    const user = userEvent.setup();
    useBuildingsMock.mockReturnValue(liveResult<Building>([building()]));
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([site()]));
    upsertBuildingMock.mockResolvedValue(undefined);
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-building-edit-maple-building'));
    await user.selectOptions(screen.getByTestId('config-building-kindoo-site'), 'east');
    await user.click(screen.getByTestId('config-building-submit'));
    expect(upsertBuildingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        building_name: 'Maple Building',
        address: '123 Main',
        kindoo_site_id: 'east',
      }),
    );
  });

  it('Edit submit writes null when the operator picks Home', async () => {
    const user = userEvent.setup();
    useBuildingsMock.mockReturnValue(liveResult<Building>([building({ kindoo_site_id: 'east' })]));
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([site()]));
    upsertBuildingMock.mockResolvedValue(undefined);
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-building-edit-maple-building'));
    await user.selectOptions(screen.getByTestId('config-building-kindoo-site'), '__home__');
    await user.click(screen.getByTestId('config-building-submit'));
    expect(upsertBuildingMock).toHaveBeenCalledWith(
      expect.objectContaining({ building_name: 'Maple Building', kindoo_site_id: null }),
    );
  });
});

// ---- Delete buttons gated on FK snapshots arriving ------------------
//
// Deep-linking into a Configuration tab can land the Delete buttons
// on rows before the foreign-key snapshots (wards / buildings) have
// arrived. Without a gate, the FK ref-guard runs against `[]` and
// silently deletes a doc with dangling references. Every tab whose
// delete depends on a sibling collection must disable its Delete
// button until the dependencies are loaded.

describe('Configuration Delete buttons gated on FK snapshots', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mkSite = (overrides: Partial<KindooSite> = {}): KindooSite => ({
    id: 'east-stake',
    display_name: 'East Stake',
    kindoo_expected_site_name: 'East Stake CS',
    kindoo_eid: 42,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides as any),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mkBuilding = (overrides: Partial<Building> = {}): Building =>
    ({
      building_id: 'maple-building',
      building_name: 'Maple Building',
      address: '123 Main',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(overrides as any),
    }) as Building;

  describe('KindooSitesTab', () => {
    it('disables Delete while the buildings snapshot is loading', () => {
      useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([mkSite()]));
      useBuildingsMock.mockReturnValue(loadingResult());
      render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
      const btn = screen.getByTestId('config-kindoo-site-delete-east-stake');
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', 'Loading…');
    });

    it('does NOT call the delete mutation when clicked while loading', async () => {
      const user = userEvent.setup();
      useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([mkSite()]));
      useBuildingsMock.mockReturnValue(loadingResult());
      render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
      await user.click(screen.getByTestId('config-kindoo-site-delete-east-stake'));
      expect(deleteKindooSiteMock).not.toHaveBeenCalled();
    });

    it('enables Delete once the buildings snapshot is loaded (even when empty)', () => {
      useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([mkSite()]));
      useBuildingsMock.mockReturnValue(liveResult<Building>([]));
      render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
      const btn = screen.getByTestId('config-kindoo-site-delete-east-stake');
      expect(btn).not.toBeDisabled();
    });
  });

  describe('BuildingsTab', () => {
    it('disables Delete while wards snapshot is loading', () => {
      useBuildingsMock.mockReturnValue(liveResult<Building>([mkBuilding()]));
      useWardsMock.mockReturnValue(loadingResult());
      render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
      const btn = screen.getByTestId('config-building-delete-maple-building');
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', 'Loading…');
    });

    it('clicking the disabled Delete button is a no-op while loading', async () => {
      const user = userEvent.setup();
      useBuildingsMock.mockReturnValue(liveResult<Building>([mkBuilding()]));
      useWardsMock.mockReturnValue(loadingResult());
      render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
      const btn = screen.getByTestId('config-building-delete-maple-building');
      await user.click(btn);
      // Button stays disabled; userEvent honours the disabled state by
      // not firing onClick, so the row is intact and no error surfaces.
      expect(btn).toBeDisabled();
    });

    it('enables Delete once wards snapshot is loaded (even when empty)', () => {
      useBuildingsMock.mockReturnValue(liveResult<Building>([mkBuilding()]));
      useWardsMock.mockReturnValue(liveResult<Ward>([]));
      render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
      const btn = screen.getByTestId('config-building-delete-maple-building');
      expect(btn).not.toBeDisabled();
    });
  });
});

// ---- Add Building gated on the buildings snapshot hydrating ---------
//
// The unique-display-name guard runs against the buildings snapshot the
// caller passes. Deep-linking ?tab=buildings can land the Add click
// before the snapshot hydrates; without a gate the guard runs against
// [] and a duplicate name slips through on the first click. Add must
// stay disabled until `buildings.data` is defined.

describe('Add Building gated on buildings snapshot', () => {
  it('disables Add Building while the buildings snapshot is loading', () => {
    useBuildingsMock.mockReturnValue(loadingResult());
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    const btn = screen.getByTestId('config-buildings-add-button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Loading…');
  });

  it('does not open the Add Building dialog when clicked while loading', async () => {
    const user = userEvent.setup();
    useBuildingsMock.mockReturnValue(loadingResult());
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-buildings-add-button'));
    expect(screen.queryByTestId('config-building-form')).toBeNull();
  });

  it('enables Add Building once the buildings snapshot is loaded (even when empty)', () => {
    useBuildingsMock.mockReturnValue(liveResult<Building>([]));
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-buildings-add-button')).not.toBeDisabled();
  });
});

// ---- Ward edit survives a buildings-collection snapshot -------------
//
// The WardFormDialog's reset() must fire only on dialog-open /
// editingWard identity change — NOT on every buildings snapshot. An
// unrelated buildings add/edit in another tab (or the next hydration
// snapshot) would otherwise re-run reset() and clobber a manager's
// in-progress ward edit. The <Select> options stay live; only reset is
// decoupled from buildingOptions identity.

describe('WardFormDialog reset stability across buildings snapshots', () => {
  const mkWardBuilding = (overrides: Partial<Building> = {}): Building =>
    ({
      building_id: 'maple-building',
      building_name: 'Maple Building',
      address: '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(overrides as any),
    }) as Building;

  it('does not clobber an in-progress ward edit when the buildings snapshot changes', async () => {
    const user = userEvent.setup();
    const initialBuildings = [mkWardBuilding()];
    useBuildingsMock.mockReturnValue(liveResult<Building>(initialBuildings));
    useWardsMock.mockReturnValue(
      liveResult<Ward>([
        {
          ward_code: 'CO',
          ward_name: 'Maple',
          building_id: 'maple-building',
          building_name: 'Maple Building',
          seat_cap: 22,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]),
    );
    const { rerender } = render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });

    // Open the edit dialog and change the ward name (in-progress edit).
    await user.click(screen.getByTestId('config-ward-edit-CO'));
    const nameInput = screen.getByLabelText(/^Ward or branch name$/) as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, 'Maple Renamed');
    expect(nameInput.value).toBe('Maple Renamed');

    // A new buildings snapshot arrives (a NEW array identity — what
    // reactfire delivers on any buildings-collection write, even an
    // unrelated one in another tab). The form must NOT reset.
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        mkWardBuilding(),
        mkWardBuilding({ building_id: 'pine-building', building_name: 'Pine Building' }),
      ]),
    );
    rerender(<ConfigurationPage initialTab="wards" />);

    // The in-progress edit survives — reset() did not fire.
    expect((screen.getByLabelText(/^Ward or branch name$/) as HTMLInputElement).value).toBe(
      'Maple Renamed',
    );
    // The Building <Select> still reflects the live catalogue (the new
    // building is now an option), proving the dropdown stayed live.
    const select = screen.getByLabelText('Building') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toContain('pine-building');
  });
});

// ---- Buildings tab: prevent-rename ref-guard (T-68) -----------------
//
// Renaming a building while active seats / pending requests snapshot its
// display name is blocked (the snapshots are display-name arrays — §3.2
// — and a rename would orphan them). The page passes the live seats +
// requests catalogues + the building's current name into the upsert
// mutation, which throws the block message; the page surfaces it as a
// toast and does not write. Address-only edits and renames of
// unreferenced buildings still go through.

describe('Buildings tab rename ref-guard', () => {
  const mkBuilding = (overrides: Partial<Building> = {}): Building =>
    ({
      building_id: 'black-forest',
      building_name: 'Black Forest',
      address: '123 Main',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(overrides as any),
    }) as Building;

  const mkSeat = (overrides: Partial<Seat> = {}): Seat =>
    ({
      member_canonical: 'a@x.com',
      member_email: 'a@x.com',
      member_name: 'A',
      scope: 'CO',
      type: 'manual',
      callings: [],
      building_names: ['Black Forest'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(overrides as any),
    }) as Seat;

  // Mimic the real mutation: throw the block message when the name
  // changes AND a passed seat / pending request references the old name.
  function installRealisticUpsert() {
    upsertBuildingMock.mockImplementation(
      async (input: {
        building_name: string;
        previousBuildingName?: string;
        seats?: Seat[];
        pendingRequests?: AccessRequest[];
      }) => {
        const prev = input.previousBuildingName;
        if (prev !== undefined && input.building_name.trim() !== prev) {
          const refs =
            (input.seats ?? []).some((s) => (s.building_names ?? []).includes(prev)) ||
            (input.pendingRequests ?? []).some(
              (r) => r.status === 'pending' && (r.building_names ?? []).includes(prev),
            );
          if (refs) {
            throw new Error(
              `Can't rename "${prev}" — 1 seat references it. Remove or reassign them first.`,
            );
          }
        }
      },
    );
  }

  it('disables Edit while the seats snapshot is loading', () => {
    useBuildingsMock.mockReturnValue(liveResult<Building>([mkBuilding()]));
    useSeatsMock.mockReturnValue(loadingResult());
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    const btn = screen.getByTestId('config-building-edit-black-forest');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Loading…');
  });

  it('disables Edit while the requests snapshot is loading', () => {
    useBuildingsMock.mockReturnValue(liveResult<Building>([mkBuilding()]));
    useRequestsMock.mockReturnValue(loadingResult());
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-building-edit-black-forest')).toBeDisabled();
  });

  it('disables Edit while the wards snapshot is loading', () => {
    // Wards are written through by a rename (T-74), so an un-hydrated
    // wards snapshot would silently leave every ward's `building_name`
    // stale — the mirror image of the seats / requests block.
    useBuildingsMock.mockReturnValue(liveResult<Building>([mkBuilding()]));
    useWardsMock.mockReturnValue(loadingResult());
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-building-edit-black-forest')).toBeDisabled();
  });

  it('enables Edit once seats + requests + wards snapshots are loaded (even when empty)', () => {
    useBuildingsMock.mockReturnValue(liveResult<Building>([mkBuilding()]));
    useSeatsMock.mockReturnValue(liveResult<Seat>([]));
    useRequestsMock.mockReturnValue(liveResult<AccessRequest>([]));
    useWardsMock.mockReturnValue(liveResult<Ward>([]));
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-building-edit-black-forest')).not.toBeDisabled();
  });

  it('hands the rename the live wards snapshot to write through', async () => {
    const user = userEvent.setup();
    installRealisticUpsert();
    useBuildingsMock.mockReturnValue(liveResult<Building>([mkBuilding()]));
    const wards = [
      {
        ward_code: 'CO',
        ward_name: 'Maple',
        building_id: 'black-forest',
        building_name: 'Black Forest',
        seat_cap: 20,
      } as Ward,
    ];
    useWardsMock.mockReturnValue(liveResult<Ward>(wards));
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-building-edit-black-forest'));
    const nameInput = screen.getByLabelText(/^Name$/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Schwarzwald');
    await user.click(screen.getByTestId('config-building-submit'));
    await vi.waitFor(() => expect(upsertBuildingMock).toHaveBeenCalled());
    expect(upsertBuildingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        building_name: 'Schwarzwald',
        previousBuildingName: 'Black Forest',
        wards,
      }),
    );
  });

  it('blocks the rename and toasts when an active seat references the building', async () => {
    const { useToastStore } = await import('../../../lib/store/toast');
    useToastStore.getState().clear();
    const user = userEvent.setup();
    installRealisticUpsert();
    useBuildingsMock.mockReturnValue(liveResult<Building>([mkBuilding()]));
    useSeatsMock.mockReturnValue(liveResult<Seat>([mkSeat()]));
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-building-edit-black-forest'));
    const nameInput = screen.getByLabelText(/^Name$/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Schwarzwald');
    await user.click(screen.getByTestId('config-building-submit'));
    await vi.waitFor(() => {
      const errors = useToastStore.getState().toasts.filter((t) => t.kind === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain('Can\'t rename "Black Forest"');
    });
    // The mutation was called with the rename-guard inputs.
    expect(upsertBuildingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        building_name: 'Schwarzwald',
        previousBuildingName: 'Black Forest',
        seats: [expect.objectContaining({ building_names: ['Black Forest'] })],
      }),
    );
  });

  it('saves an address-only edit even while a seat references the building (name unchanged)', async () => {
    const user = userEvent.setup();
    installRealisticUpsert();
    useBuildingsMock.mockReturnValue(liveResult<Building>([mkBuilding()]));
    useSeatsMock.mockReturnValue(liveResult<Seat>([mkSeat()]));
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-building-edit-black-forest'));
    const addressInput = screen.getByLabelText(/Address/i);
    await user.clear(addressInput);
    await user.type(addressInput, '999 New Address');
    await user.click(screen.getByTestId('config-building-submit'));
    await vi.waitFor(() => expect(upsertBuildingMock).toHaveBeenCalled());
    // Name is unchanged → the guard does not fire → it saved.
    expect(upsertBuildingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        building_name: 'Black Forest',
        address: '999 New Address',
        previousBuildingName: 'Black Forest',
      }),
    );
  });

  it('saves a rename of an unreferenced building', async () => {
    const user = userEvent.setup();
    installRealisticUpsert();
    // The building being renamed has no seat / request referencing it.
    useBuildingsMock.mockReturnValue(liveResult<Building>([mkBuilding()]));
    useSeatsMock.mockReturnValue(liveResult<Seat>([mkSeat({ building_names: ['Other'] })]));
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-building-edit-black-forest'));
    const nameInput = screen.getByLabelText(/^Name$/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Schwarzwald');
    await user.click(screen.getByTestId('config-building-submit'));
    await vi.waitFor(() => expect(upsertBuildingMock).toHaveBeenCalled());
    expect(upsertBuildingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        building_name: 'Schwarzwald',
        previousBuildingName: 'Black Forest',
      }),
    );
  });
});

// ---- Organizations tab ----------------------------------------------
//
// Stake-level seat pools. Create derives a slug from the name; edit
// carries the immutable slug through unchanged (no re-slug). Delete is
// blocked while any seat references the org (primary organization_id or
// a duplicate-grant organization_id), gated on the seats snapshot.

describe('Organizations tab', () => {
  const mkOrg = (overrides: Partial<Organization> = {}): Organization =>
    ({
      organization_id: 'primary-children',
      name: 'Primary Children',
      seat_cap: 25,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(overrides as any),
    }) as Organization;

  it('shows the empty state when no organizations exist', () => {
    useOrganizationsMock.mockReturnValue(liveResult<Organization>([]));
    render(<ConfigurationPage initialTab="organizations" />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-organizations-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('config-organizations-list')).toBeNull();
  });

  it('renders organization rows with name + seat cap, sorted alphabetically', () => {
    useOrganizationsMock.mockReturnValue(
      liveResult<Organization>([
        mkOrg({ organization_id: 'scouts', name: 'Scouts', seat_cap: 10 }),
        mkOrg({ organization_id: 'primary-children', name: 'Primary Children', seat_cap: 25 }),
      ]),
    );
    render(<ConfigurationPage initialTab="organizations" />, { wrapper: Wrapper });
    const list = screen.getByTestId('config-organizations-list');
    const labels = Array.from(list.querySelectorAll('strong')).map((el) => el.textContent);
    expect(labels).toEqual(['Primary Children', 'Scouts']);
    expect(list.textContent).toContain('cap 25');
  });

  it('opens the Add modal and submits name + seat_cap (slug derived in the mutation)', async () => {
    const user = userEvent.setup();
    upsertOrganizationMock.mockResolvedValue(undefined);
    render(<ConfigurationPage initialTab="organizations" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-organizations-add-button'));
    expect(screen.getByRole('heading', { name: 'Add organization' })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Name/i), 'Primary Children');
    const capInput = screen.getByLabelText(/Seat cap/i);
    await user.clear(capInput);
    await user.type(capInput, '25');
    await user.click(screen.getByTestId('config-organization-submit'));
    await vi.waitFor(() => expect(upsertOrganizationMock).toHaveBeenCalled());
    expect(upsertOrganizationMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Primary Children', seat_cap: 25 }),
    );
    // The form never supplies organization_id on create — the mutation
    // derives the slug from the name.
    expect(upsertOrganizationMock.mock.calls[0]?.[0]).not.toHaveProperty('organization_id');
  });

  it('rejects an empty name on Add submit', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPage initialTab="organizations" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-organizations-add-button'));
    await user.click(screen.getByTestId('config-organization-submit'));
    expect(await screen.findByText(/Name is required/i)).toBeInTheDocument();
    expect(upsertOrganizationMock).not.toHaveBeenCalled();
  });

  it('opens the Edit modal pre-populated and carries the immutable slug through on save', async () => {
    const user = userEvent.setup();
    upsertOrganizationMock.mockResolvedValue(undefined);
    useOrganizationsMock.mockReturnValue(liveResult<Organization>([mkOrg()]));
    render(<ConfigurationPage initialTab="organizations" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-organization-edit-primary-children'));
    expect(
      screen.getByRole('heading', { name: /Edit organization — Primary Children/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Name/i)).toHaveValue('Primary Children');
    // Rename the org — the slug must still ride through unchanged.
    const nameInput = screen.getByLabelText(/Name/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Primary Org Renamed');
    await user.click(screen.getByTestId('config-organization-submit'));
    await vi.waitFor(() => expect(upsertOrganizationMock).toHaveBeenCalled());
    expect(upsertOrganizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: 'primary-children',
        name: 'Primary Org Renamed',
      }),
    );
  });

  it('Delete calls the delete mutation with the org id and live seats snapshot', async () => {
    const user = userEvent.setup();
    deleteOrganizationMock.mockResolvedValue(undefined);
    useOrganizationsMock.mockReturnValue(liveResult<Organization>([mkOrg()]));
    const seatRef = {
      member_canonical: 'a@x.com',
      organization_id: 'scouts',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    useSeatsMock.mockReturnValue(liveResult<Seat>([seatRef]));
    render(<ConfigurationPage initialTab="organizations" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-organization-delete-primary-children'));
    expect(deleteOrganizationMock).toHaveBeenCalledWith({
      organizationId: 'primary-children',
      seats: [seatRef],
    });
  });

  it('Delete surfaces the ref-guard error via toast when a seat references the org', async () => {
    const { useToastStore } = await import('../../../lib/store/toast');
    useToastStore.getState().clear();
    const user = userEvent.setup();
    useOrganizationsMock.mockReturnValue(liveResult<Organization>([mkOrg()]));
    useSeatsMock.mockReturnValue(
      liveResult<Seat>([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { member_canonical: 'a@x.com', organization_id: 'primary-children' } as any,
      ]),
    );
    deleteOrganizationMock.mockImplementation(async () => {
      throw new Error(
        'Cannot delete: 1 seat still reference this organization. Reassign or remove them first.',
      );
    });
    render(<ConfigurationPage initialTab="organizations" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-organization-delete-primary-children'));
    await vi.waitFor(() => {
      const errors = useToastStore.getState().toasts.filter((t) => t.kind === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain('Cannot delete');
    });
  });

  it('disables Delete while the seats snapshot is loading', () => {
    useOrganizationsMock.mockReturnValue(liveResult<Organization>([mkOrg()]));
    useSeatsMock.mockReturnValue(loadingResult());
    render(<ConfigurationPage initialTab="organizations" />, { wrapper: Wrapper });
    const btn = screen.getByTestId('config-organization-delete-primary-children');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Loading…');
  });

  it('disables Add while the organizations snapshot is loading', () => {
    useOrganizationsMock.mockReturnValue(loadingResult());
    render(<ConfigurationPage initialTab="organizations" />, { wrapper: Wrapper });
    const btn = screen.getByTestId('config-organizations-add-button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Loading…');
  });
});

// ---- Stake config form vs. the sliders below it ---------------------
//
// The Config tab is two controls-with-different-save-semantics stacked:
// a react-hook-form saved by `Save config`, and beneath it a stack of
// sliders that write on flip. The line between them is the thing worth
// pinning — a slider that drifted back into the form would be governed
// by a Save button the manager has no reason to press.

describe('<ConfigurationPage /> Config tab save boundary', () => {
  it('Save config writes the three form fields and neither slider', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    await user.click(screen.getByRole('button', { name: /^Save config$/ }));
    await waitFor(() => expect(updateStakeConfigMock).toHaveBeenCalled());
    expect(Object.keys(updateStakeConfigMock.mock.calls[0]![0] as object).sort()).toEqual([
      'stake_name',
      'stake_seat_cap',
      'timezone',
    ]);
    expect(setStakeToggleMock).not.toHaveBeenCalled();
    expect(setSyncReminderEnabledMock).not.toHaveBeenCalled();
  });

  it('renders the three sliders below the form, not inside it', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    for (const id of [
      'config-notifications-enabled',
      'config-sync-reminder-enabled',
      'config-eq-president-access',
    ]) {
      expect(screen.getByTestId(id).closest('form')).toBeNull();
    }
  });
});

// ---- Email Notifications Enabled ------------------------------------

describe('<ConfigurationPage /> email notifications slider', () => {
  it('reads on when the stake field is absent, since email defaults on', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-notifications-enabled')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('reads off when the stake has turned email off', () => {
    useStakeDocMock.mockReturnValue(stakeDocResult({ notifications_enabled: false }));
    render(<ConfigurationPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-notifications-enabled')).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('writes the field the moment the slider moves, with no Save', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-notifications-enabled'));
    await waitFor(() =>
      expect(setStakeToggleMock).toHaveBeenCalledWith({
        field: 'notifications_enabled',
        value: false,
      }),
    );
    expect(updateStakeConfigMock).not.toHaveBeenCalled();
  });

  it('reports the failure and leaves the config form alone when the write is rejected', async () => {
    const { useToastStore } = await import('../../../lib/store/toast');
    setStakeToggleMock.mockRejectedValue(new Error('Missing or insufficient permissions.'));
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-notifications-enabled'));
    await vi.waitFor(() => {
      const errors = useToastStore.getState().toasts.filter((t) => t.kind === 'error');
      expect(errors.map((t) => t.message)).toContain('Missing or insufficient permissions.');
    });
  });
});

// ---- Elders Quorum President app-access slider -----------------------
//
// An ordinary write-on-flip slider. What's load-bearing is the backfill
// offer: it follows the flip (there is no Save to hang it off any more)
// and only once setup is complete, since initial setup has no seats to
// reconcile.

describe('<ConfigurationPage /> Elders Quorum President app-access', () => {
  it('writes eq_president_app_access the moment the slider is turned on', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-eq-president-access'));
    await vi.waitFor(() => {
      expect(setStakeToggleMock).toHaveBeenCalledWith({
        field: 'eq_president_app_access',
        value: true,
      });
    });
    expect(updateStakeConfigMock).not.toHaveBeenCalled();
  });

  it('offers to grant access to current Elders Quorum Presidents after turning the slider on', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-eq-president-access'));
    await screen.findByRole('heading', {
      name: 'Grant access to current Elders Quorum Presidents?',
    });
    expect(screen.getByRole('button', { name: 'Grant access now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
  });

  it('runs the grant backfill and reports the count when the offer is confirmed', async () => {
    const { useToastStore } = await import('../../../lib/store/toast');
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-eq-president-access'));
    await user.click(await screen.findByTestId('config-eq-backfill-confirm'));
    await vi.waitFor(() => {
      expect(backfillEqPresidentAccessMock).toHaveBeenCalledWith('grant');
    });
    await vi.waitFor(() => {
      const messages = useToastStore.getState().toasts.map((t) => t.message);
      expect(messages).toContain('Granted app access to 3 member(s).');
    });
    expect(
      screen.queryByRole('heading', { name: 'Grant access to current Elders Quorum Presidents?' }),
    ).toBeNull();
  });

  it('does not run the backfill when the grant offer is declined', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-eq-president-access'));
    await user.click(await screen.findByTestId('config-eq-backfill-cancel'));
    await vi.waitFor(() => {
      expect(
        screen.queryByRole('heading', {
          name: 'Grant access to current Elders Quorum Presidents?',
        }),
      ).toBeNull();
    });
    expect(backfillEqPresidentAccessMock).not.toHaveBeenCalled();
  });

  it('offers to revoke access after turning the slider off', async () => {
    useStakeDocMock.mockReturnValue(stakeDocResult({ eq_president_app_access: true }));
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-eq-president-access'));
    await screen.findByRole('heading', { name: 'Revoke access from Elders Quorum Presidents?' });
    expect(screen.getByRole('button', { name: 'Revoke access now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave access in place' })).toBeInTheDocument();
  });

  it('counts written plus deleted access docs in the revoke success toast', async () => {
    const { useToastStore } = await import('../../../lib/store/toast');
    // seats_matched is deliberately unequal to docs_written + docs_deleted so the
    // assertion fails if the toast reads seats_matched instead.
    backfillEqPresidentAccessMock.mockResolvedValue({
      ok: true,
      seats_matched: 7,
      docs_written: 2,
      docs_deleted: 3,
    });
    useStakeDocMock.mockReturnValue(stakeDocResult({ eq_president_app_access: true }));
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-eq-president-access'));
    await user.click(await screen.findByTestId('config-eq-backfill-confirm'));
    await vi.waitFor(() => {
      expect(backfillEqPresidentAccessMock).toHaveBeenCalledWith('revoke');
    });
    await vi.waitFor(() => {
      const messages = useToastStore.getState().toasts.map((t) => t.message);
      expect(messages).toContain('Revoked app access for 5 member(s).');
    });
  });

  it('does not offer a backfill when the slider flips before setup is complete', async () => {
    useStakeDocMock.mockReturnValue(stakeDocResult({ setup_complete: false }));
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-eq-president-access'));
    await vi.waitFor(() => {
      expect(setStakeToggleMock).toHaveBeenCalledWith({
        field: 'eq_president_app_access',
        value: true,
      });
    });
    expect(screen.queryByTestId('config-eq-backfill-confirm')).toBeNull();
  });

  it('does not offer a backfill when the write is rejected', async () => {
    setStakeToggleMock.mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-eq-president-access'));
    await vi.waitFor(() => expect(setStakeToggleMock).toHaveBeenCalled());
    expect(screen.queryByTestId('config-eq-backfill-confirm')).toBeNull();
  });
});

// ---- Slider tooltips -------------------------------------------------
//
// The body of each row is slider + name; everything explanatory hangs
// off an "i" affordance beside it. It has to open on a tap, because
// managers use this page from a phone and an iPad where nothing hovers.

describe('<ConfigurationPage /> slider tooltips', () => {
  const TIPS: Array<[string, RegExp]> = [
    ['config-notifications-enabled', /stake-wide switch for email/i],
    ['config-sync-reminder', /temporary seat has expired in Kindoo/i],
    ['config-eq-president-access', /Sync grants app access/i],
  ];

  it.each(TIPS)('%s keeps its explanation behind the information affordance', (testId) => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    expect(screen.getByTestId(`${testId}-info`)).toBeInTheDocument();
    expect(screen.queryByTestId(`${testId}-info-panel`)).toBeNull();
  });

  it.each(TIPS)('%s opens its explanation on a click', async (testId, copy) => {
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId(`${testId}-info`));
    const panel = await screen.findByTestId(`${testId}-info-panel`);
    expect(panel).toHaveTextContent(copy);
  });

  it('does not require a hover, which a touch device never produces', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    await user.hover(screen.getByTestId('config-notifications-enabled-info'));
    expect(screen.queryByTestId('config-notifications-enabled-info-panel')).toBeNull();
    await user.click(screen.getByTestId('config-notifications-enabled-info'));
    expect(await screen.findByTestId('config-notifications-enabled-info-panel')).toBeVisible();
  });

  it('stays readable on a row whose slider is disabled — what the setting is still matters', async () => {
    useStakeScheduleMock.mockReturnValue(scheduleDocResult(undefined));
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-sync-reminder-enabled')).toBeDisabled();
    await user.click(screen.getByTestId('config-sync-reminder-info'));
    expect(await screen.findByTestId('config-sync-reminder-info-panel')).toHaveTextContent(
      /temporary seat has expired in Kindoo/i,
    );
  });

  it('names the option it explains, so three identical icons are still distinguishable', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-sync-reminder-info')).toHaveAttribute(
      'aria-label',
      'More about Sync reminders',
    );
  });
});

// ---- Sync reminders slider -------------------------------------------

describe('<ConfigurationPage /> sync reminders slider', () => {
  it('sits directly beneath Email Notifications Enabled, indented under it', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    const rows = Array.from(
      screen.getByTestId('config-toggles').querySelectorAll('.kd-setting-toggle'),
    );
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'config-notifications-enabled-row',
      'config-sync-reminder-row',
      'config-eq-president-access-row',
    ]);
    expect(screen.getByTestId('config-sync-reminder-row')).toHaveClass('kd-setting-toggle--sub');
    expect(screen.getByTestId('config-notifications-enabled-row')).not.toHaveClass(
      'kd-setting-toggle--sub',
    );
  });

  describe('before its snapshot has landed', () => {
    beforeEach(() => {
      useStakeScheduleMock.mockReturnValue(schedulePendingResult());
    });

    it('renders no switch at all, so it cannot show a value it does not have', () => {
      // The defect this replaces: `syncReminderTask(undefined)` is null
      // while pending, so the row collapsed into "not seeded" and
      // rendered a disabled, unchecked switch — indistinguishable from
      // a settled off, on a stake whose reminder is on.
      render(<ConfigurationPage />, { wrapper: Wrapper });
      expect(screen.queryByTestId('config-sync-reminder-enabled')).toBeNull();
      expect(screen.getByTestId('config-sync-reminder-enabled-pending')).toBeInTheDocument();
      expect(screen.getByTestId('config-sync-reminder-row')).toHaveAttribute('aria-busy', 'true');
    });

    it('is the only thing that distinguishes loading from never-seeded', () => {
      // The tooltip states what the setting is and nothing about its
      // state, so the control itself carries the whole distinction: a
      // placeholder while loading, a real (disabled, off) switch once we
      // know the row was never seeded.
      const { rerender } = render(<ConfigurationPage />, { wrapper: Wrapper });
      expect(screen.getByTestId('config-sync-reminder-enabled-pending')).toBeInTheDocument();
      useStakeScheduleMock.mockReturnValue(scheduleDocResult(undefined));
      rerender(<ConfigurationPage />);
      expect(screen.queryByTestId('config-sync-reminder-enabled-pending')).toBeNull();
      const sw = screen.getByTestId('config-sync-reminder-enabled');
      expect(sw).toBeDisabled();
      expect(sw).toHaveAttribute('aria-checked', 'false');
    });

    it('leaves the two stake-doc sliders alone — they render from data the tab already has', () => {
      render(<ConfigurationPage />, { wrapper: Wrapper });
      expect(screen.getByTestId('config-notifications-enabled')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(screen.getByTestId('config-eq-president-access')).toBeInTheDocument();
      expect(screen.queryByTestId('config-notifications-enabled-pending')).toBeNull();
    });

    it('settles onto the row’s real value once the snapshot arrives', () => {
      const { rerender } = render(<ConfigurationPage />, { wrapper: Wrapper });
      expect(screen.getByTestId('config-sync-reminder-enabled-pending')).toBeInTheDocument();
      useStakeScheduleMock.mockReturnValue(scheduleDocResult([syncReminderRow({ enabled: true })]));
      rerender(<ConfigurationPage />);
      expect(screen.queryByTestId('config-sync-reminder-enabled-pending')).toBeNull();
      expect(screen.getByTestId('config-sync-reminder-enabled')).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });
  });

  it('greys and disables the slider until the dispatcher has seeded the row', () => {
    useStakeScheduleMock.mockReturnValue(scheduleDocResult(undefined));
    render(<ConfigurationPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-sync-reminder-enabled')).toBeDisabled();
    expect(screen.getByTestId('config-sync-reminder-row')).toHaveClass(
      'kd-setting-toggle--disabled',
    );
  });

  it('disables the slider when the schedule doc exists but carries no syncReminder row', () => {
    useStakeScheduleMock.mockReturnValue(
      scheduleDocResult([
        {
          job: 'someOtherJob',
          enabled: true,
          schedule: { type: 'hourly' },
        } satisfies ScheduledTask,
      ]),
    );
    render(<ConfigurationPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-sync-reminder-enabled')).toBeDisabled();
  });

  it('never offers to create the row itself', async () => {
    useStakeScheduleMock.mockReturnValue(scheduleDocResult(undefined));
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-sync-reminder-enabled'));
    expect(setSyncReminderEnabledMock).not.toHaveBeenCalled();
  });

  it('flips the row on when the slider is turned on', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-sync-reminder-enabled'));
    await waitFor(() => expect(setSyncReminderEnabledMock).toHaveBeenCalledWith(true));
    expect(updateStakeConfigMock).not.toHaveBeenCalled();
  });

  it('flips the row off when the slider is turned off', async () => {
    useStakeScheduleMock.mockReturnValue(scheduleDocResult([syncReminderRow({ enabled: true })]));
    const user = userEvent.setup();
    render(<ConfigurationPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-sync-reminder-enabled'));
    await waitFor(() => expect(setSyncReminderEnabledMock).toHaveBeenCalledWith(false));
  });

  describe('when the stake-level email kill-switch is off', () => {
    beforeEach(() => {
      useStakeDocMock.mockReturnValue(stakeDocResult({ notifications_enabled: false }));
    });

    it('greys and disables the slider — the parent decides whether it can be changed', async () => {
      const user = userEvent.setup();
      render(<ConfigurationPage />, { wrapper: Wrapper });
      const sw = screen.getByTestId('config-sync-reminder-enabled');
      expect(sw).toBeDisabled();
      expect(screen.getByTestId('config-sync-reminder-row')).toHaveClass(
        'kd-setting-toggle--disabled',
      );
      await user.click(sw);
      expect(setSyncReminderEnabledMock).not.toHaveBeenCalled();
    });

    it('never writes enabled: false as a side effect — the row keeps its own value', () => {
      useStakeScheduleMock.mockReturnValue(scheduleDocResult([syncReminderRow({ enabled: true })]));
      render(<ConfigurationPage />, { wrapper: Wrapper });
      // Greyed, but still reading ON, because it is still running.
      expect(screen.getByTestId('config-sync-reminder-enabled')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(setSyncReminderEnabledMock).not.toHaveBeenCalled();
    });
  });

  it('is live and ungreyed when email notifications are on', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-sync-reminder-enabled')).toBeEnabled();
    expect(screen.getByTestId('config-sync-reminder-row')).not.toHaveClass(
      'kd-setting-toggle--disabled',
    );
  });
});
