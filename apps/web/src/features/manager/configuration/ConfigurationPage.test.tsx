// Component tests for the Configuration page. Each tab is exercised
// once: list rendering + form validation. Mutations are mocked.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type {
  AccessRequest,
  Building,
  KindooManager,
  KindooSite,
  Seat,
  Stake,
  Ward,
} from '@kindoo/shared';

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
  useUpdateStakeConfigMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

import { ConfigurationPage } from './ConfigurationPage';

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

beforeEach(() => {
  vi.clearAllMocks();
  useStakeDocMock.mockReturnValue({
    data: {
      stake_name: 'My Stake',
      stake_seat_cap: 200,
      expiry_hour: 4,
      timezone: 'America/Denver',
      notifications_enabled: true,
    } satisfies Partial<Stake>,
    error: null,
    status: 'success',
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  });
  useWardsMock.mockReturnValue(liveResult<Ward>([]));
  useBuildingsMock.mockReturnValue(liveResult<Building>([]));
  useManagersMock.mockReturnValue(liveResult<KindooManager>([]));
  useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([]));
  useSeatsMock.mockReturnValue(liveResult<Seat>([]));
  useRequestsMock.mockReturnValue(liveResult<AccessRequest>([]));
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
    const sw = screen.getByLabelText(/Email Notifications Enabled/i);
    expect(sw).toBeInTheDocument();
    expect(sw).toHaveAttribute('role', 'switch');
  });

  it('does not render a Triggers tab', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    expect(screen.queryByTestId('config-tab-triggers')).toBeNull();
    expect(screen.queryByTestId('config-triggers')).toBeNull();
  });

  it('renders tabs in the operator-specified order (Buildings before Wards)', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    const labels = Array.from(document.querySelectorAll('.kd-config-tab')).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(['Config', 'Managers', 'Kindoo Sites', 'Buildings', 'Wards']);
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
    expect(await screen.findByText(/Ward code is required/i)).toBeInTheDocument();
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

  it('opens the Edit Ward modal pre-populated; ward_code is read-only', async () => {
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
    const wardCodeInput = screen.getByLabelText(/Ward code/i) as HTMLInputElement;
    expect(wardCodeInput.value).toBe('CO');
    expect(wardCodeInput).toHaveAttribute('readonly');
    expect(screen.getByRole('heading', { name: /Edit ward — CO/ })).toBeInTheDocument();
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
    await user.type(screen.getByLabelText(/Ward code/i), 'CO');
    await user.type(screen.getByLabelText(/Ward name/i), 'Maple');
    await user.selectOptions(screen.getByLabelText('Building'), 'maple-building');
    await user.click(screen.getByTestId('config-ward-submit'));
    await vi.waitFor(() => expect(upsertWardMock).toHaveBeenCalled());
    expect(upsertWardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ward_code: 'CO',
        building_id: 'maple-building',
        building_name: 'Maple Building',
      }),
    );
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
    const nameInput = screen.getByLabelText(/Ward name/i) as HTMLInputElement;
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
    expect((screen.getByLabelText(/Ward name/i) as HTMLInputElement).value).toBe('Maple Renamed');
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
              `Can't rename "${prev}" — 1 seat reference it. Remove or reassign them first.`,
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

  it('enables Edit once seats + requests snapshots are loaded (even when empty)', () => {
    useBuildingsMock.mockReturnValue(liveResult<Building>([mkBuilding()]));
    useSeatsMock.mockReturnValue(liveResult<Seat>([]));
    useRequestsMock.mockReturnValue(liveResult<AccessRequest>([]));
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-building-edit-black-forest')).not.toBeDisabled();
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
