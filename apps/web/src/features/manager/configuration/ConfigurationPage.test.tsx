// Component tests for the Configuration page. Each tab is exercised
// once: list rendering + form validation. Mutations are mocked.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Building, KindooManager, KindooSite, Stake, Ward } from '@kindoo/shared';

const useStakeDocMock = vi.fn();
const useWardsMock = vi.fn();
const useBuildingsMock = vi.fn();
const useManagersMock = vi.fn();
const useWardCallingTemplatesMock = vi.fn();
const useStakeCallingTemplatesMock = vi.fn();
const useKindooSitesMock = vi.fn();
const navigateMock = vi.fn().mockResolvedValue(undefined);

const addWardCallingTemplateMock = vi.fn();
const upsertWardCallingTemplateMock = vi.fn();
const deleteWardCallingTemplateWithResequenceMock = vi.fn();
const reorderWardCallingTemplatesMock = vi.fn();
const addStakeCallingTemplateMock = vi.fn();
const upsertStakeCallingTemplateMock = vi.fn();
const deleteStakeCallingTemplateWithResequenceMock = vi.fn();
const reorderStakeCallingTemplatesMock = vi.fn();
const upsertKindooSiteMock = vi.fn();
const deleteKindooSiteMock = vi.fn();
const upsertWardMock = vi.fn();
const upsertBuildingMock = vi.fn();

vi.mock('./hooks', () => ({
  useStakeDoc: () => useStakeDocMock(),
  useWards: () => useWardsMock(),
  useBuildings: () => useBuildingsMock(),
  useManagers: () => useManagersMock(),
  useWardCallingTemplates: () => useWardCallingTemplatesMock(),
  useStakeCallingTemplates: () => useStakeCallingTemplatesMock(),
  useKindooSites: () => useKindooSitesMock(),
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
  useAddWardCallingTemplateMutation: () => ({
    mutateAsync: addWardCallingTemplateMock,
    isPending: false,
  }),
  useUpsertWardCallingTemplateMutation: () => ({
    mutateAsync: upsertWardCallingTemplateMock,
    isPending: false,
  }),
  useDeleteWardCallingTemplateWithResequenceMutation: () => ({
    mutateAsync: deleteWardCallingTemplateWithResequenceMock,
  }),
  useReorderWardCallingTemplatesMutation: () => ({
    mutateAsync: reorderWardCallingTemplatesMock,
  }),
  useAddStakeCallingTemplateMutation: () => ({
    mutateAsync: addStakeCallingTemplateMock,
    isPending: false,
  }),
  useUpsertStakeCallingTemplateMutation: () => ({
    mutateAsync: upsertStakeCallingTemplateMock,
    isPending: false,
  }),
  useDeleteStakeCallingTemplateWithResequenceMutation: () => ({
    mutateAsync: deleteStakeCallingTemplateWithResequenceMock,
  }),
  useReorderStakeCallingTemplatesMutation: () => ({
    mutateAsync: reorderStakeCallingTemplatesMock,
  }),
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

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  useStakeDocMock.mockReturnValue({
    data: {
      stake_name: 'My Stake',
      callings_sheet_id: 'sheet1',
      stake_seat_cap: 200,
      expiry_hour: 4,
      import_day: 'MONDAY',
      import_hour: 6,
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
  useWardCallingTemplatesMock.mockReturnValue(liveResult([]));
  useStakeCallingTemplatesMock.mockReturnValue(liveResult([]));
  useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([]));
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

  it('renders tabs in the operator-specified order', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    const labels = Array.from(document.querySelectorAll('.kd-config-tab')).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual([
      'Config',
      'Managers',
      'Wards',
      'Buildings',
      'Kindoo Sites',
      'Auto Ward Callings',
      'Auto Stake Callings',
    ]);
  });

  it('shows ward-form validation error on empty submit (modal-driven)', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-wards-add-button'));
    await user.click(screen.getByTestId('config-ward-submit'));
    expect(await screen.findByText(/Ward code is required/i)).toBeInTheDocument();
  });

  it('opens the Add Ward modal from the section header', async () => {
    const user = userEvent.setup();
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
          ward_name: 'Cordera',
          building_name: 'Cordera Building',
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

  it('renders an Edit button on each Building row; building_id is never shown in form', async () => {
    const user = userEvent.setup();
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        {
          building_id: 'cordera-building',
          building_name: 'Cordera Building',
          address: '123 Main',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]),
    );
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-building-edit-cordera-building'));
    expect(screen.getByLabelText(/Name/i)).toHaveValue('Cordera Building');
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

describe('Auto Ward Callings tab', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mkTpl = (calling_name: string, sheet_order: number, overrides: any = {}) => ({
    calling_name,
    give_app_access: false,
    auto_kindoo_access: false,
    sheet_order,
    ...overrides,
  });

  it('renders rows in sheet_order ascending', () => {
    useWardCallingTemplatesMock.mockReturnValue(
      liveResult([mkTpl('B', 2), mkTpl('A', 1), mkTpl('C', 3)]),
    );
    render(<ConfigurationPage initialTab="ward-callings" />, { wrapper: Wrapper });
    const rows = Array.from(
      document.querySelectorAll('[data-testid^="config-ward-callings-row-"]'),
    );
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'config-ward-callings-row-A',
      'config-ward-callings-row-B',
      'config-ward-callings-row-C',
    ]);
  });

  it('opens the Add modal with both flags blank and submits via Add Calling', async () => {
    const user = userEvent.setup();
    useWardCallingTemplatesMock.mockReturnValue(liveResult([mkTpl('A', 1)]));
    addWardCallingTemplateMock.mockResolvedValue(undefined);
    render(<ConfigurationPage initialTab="ward-callings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-ward-callings-add-button'));
    expect(screen.getByRole('heading', { name: 'Add calling' })).toBeInTheDocument();
    const callingName = screen.getByLabelText(/Calling name/i);
    await user.type(callingName, 'Bishop');
    await user.click(screen.getByLabelText('Auto Kindoo Access'));
    await user.click(screen.getByLabelText('Can Request Access'));
    await user.click(screen.getByRole('button', { name: 'Add Calling' }));
    expect(addWardCallingTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        calling_name: 'Bishop',
        give_app_access: true,
        auto_kindoo_access: true,
        existing: expect.any(Array),
      }),
    );
  });

  it('opens the Edit modal pre-populated with calling_name read-only', async () => {
    const user = userEvent.setup();
    useWardCallingTemplatesMock.mockReturnValue(
      liveResult([mkTpl('Bishop', 1, { auto_kindoo_access: true, give_app_access: true })]),
    );
    render(<ConfigurationPage initialTab="ward-callings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-ward-callings-edit-Bishop'));
    expect(screen.getByRole('heading', { name: /Edit calling — Bishop/ })).toBeInTheDocument();
    const nameInput = screen.getByLabelText(/Calling name/i) as HTMLInputElement;
    expect(nameInput.value).toBe('Bishop');
    expect(nameInput).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
  });

  it('Edit submit calls upsert with original sheet_order preserved', async () => {
    const user = userEvent.setup();
    useWardCallingTemplatesMock.mockReturnValue(
      liveResult([mkTpl('Bishop', 7, { auto_kindoo_access: true, give_app_access: true })]),
    );
    upsertWardCallingTemplateMock.mockResolvedValue(undefined);
    render(<ConfigurationPage initialTab="ward-callings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-ward-callings-edit-Bishop'));
    await user.click(screen.getByLabelText('Auto Kindoo Access')); // toggle off
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(upsertWardCallingTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        calling_name: 'Bishop',
        auto_kindoo_access: false,
        give_app_access: true,
        sheet_order: 7,
      }),
    );
  });

  it('Delete calls the resequence mutation with current snapshot', async () => {
    const user = userEvent.setup();
    const tpls = [mkTpl('A', 1), mkTpl('B', 2), mkTpl('C', 3)];
    useWardCallingTemplatesMock.mockReturnValue(liveResult(tpls));
    deleteWardCallingTemplateWithResequenceMock.mockResolvedValue(undefined);
    render(<ConfigurationPage initialTab="ward-callings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-ward-callings-delete-B'));
    expect(deleteWardCallingTemplateWithResequenceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        callingName: 'B',
        current: expect.any(Array),
      }),
    );
  });

  it('renders the grip handle button on every row', () => {
    useWardCallingTemplatesMock.mockReturnValue(liveResult([mkTpl('A', 1), mkTpl('B', 2)]));
    render(<ConfigurationPage initialTab="ward-callings" />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-ward-callings-grip-A')).toBeInTheDocument();
    expect(screen.getByTestId('config-ward-callings-grip-B')).toBeInTheDocument();
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

  it('Delete calls the delete mutation with the doc id', async () => {
    const user = userEvent.setup();
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([mkSite()]));
    deleteKindooSiteMock.mockResolvedValue(undefined);
    render(<ConfigurationPage initialTab="kindoo-sites" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-kindoo-site-delete-east-stake'));
    expect(deleteKindooSiteMock).toHaveBeenCalledWith('east-stake');
  });
});

describe('Ward dialog Kindoo Site field', () => {
  // The `kindoo_site_id` dropdown moved off the inline list rows and
  // into the Ward create/edit dialog. The dialog submits the full ward
  // payload via the existing upsert mutation — there is no dedicated
  // dropdown-only mutation any more.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ward = (overrides: Partial<Ward> = {}): Ward => ({
    ward_code: 'CO',
    ward_name: 'Cordera',
    building_name: 'Cordera Building',
    seat_cap: 22,
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
    useWardsMock.mockReturnValue(liveResult<Ward>([ward()]));
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([site()]));
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    expect(screen.queryByTestId('config-ward-kindoo-site-CO')).toBeNull();
  });

  it('Edit dialog defaults Kindoo Site to Home for a home-site ward', async () => {
    const user = userEvent.setup();
    useWardsMock.mockReturnValue(liveResult<Ward>([ward()]));
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([site()]));
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-ward-edit-CO'));
    const dd = screen.getByTestId('config-ward-kindoo-site') as HTMLSelectElement;
    expect(Array.from(dd.options).map((o) => o.text)).toEqual(['Home', 'East']);
    expect(dd.value).toBe('__home__');
  });

  it('Edit dialog pre-selects the existing kindoo_site_id', async () => {
    const user = userEvent.setup();
    useWardsMock.mockReturnValue(liveResult<Ward>([ward({ kindoo_site_id: 'east' })]));
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([site()]));
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-ward-edit-CO'));
    const dd = screen.getByTestId('config-ward-kindoo-site') as HTMLSelectElement;
    expect(dd.value).toBe('east');
  });

  it('Edit submit writes the selected kindoo_site_id through the ward upsert', async () => {
    const user = userEvent.setup();
    useWardsMock.mockReturnValue(liveResult<Ward>([ward()]));
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        {
          building_id: 'cordera-building',
          building_name: 'Cordera Building',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]),
    );
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([site()]));
    upsertWardMock.mockResolvedValue(undefined);
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-ward-edit-CO'));
    await user.selectOptions(screen.getByTestId('config-ward-kindoo-site'), 'east');
    await user.click(screen.getByTestId('config-ward-submit'));
    expect(upsertWardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ward_code: 'CO',
        ward_name: 'Cordera',
        building_name: 'Cordera Building',
        seat_cap: 22,
        kindoo_site_id: 'east',
      }),
    );
  });

  it('Edit submit writes null when the operator picks Home', async () => {
    const user = userEvent.setup();
    useWardsMock.mockReturnValue(liveResult<Ward>([ward({ kindoo_site_id: 'east' })]));
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        {
          building_id: 'cordera-building',
          building_name: 'Cordera Building',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]),
    );
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([site()]));
    upsertWardMock.mockResolvedValue(undefined);
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-ward-edit-CO'));
    await user.selectOptions(screen.getByTestId('config-ward-kindoo-site'), '__home__');
    await user.click(screen.getByTestId('config-ward-submit'));
    expect(upsertWardMock).toHaveBeenCalledWith(
      expect.objectContaining({ ward_code: 'CO', kindoo_site_id: null }),
    );
  });
});

describe('Building dialog Kindoo Site field', () => {
  // The `kindoo_site_id` dropdown moved off the inline list rows and
  // into the Building create/edit dialog.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const building = (overrides: Partial<Building> = {}): Building => ({
    building_id: 'cordera-building',
    building_name: 'Cordera Building',
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
    expect(screen.queryByTestId('config-building-kindoo-site-cordera-building')).toBeNull();
  });

  it('Edit dialog defaults Kindoo Site to Home for a home-site building', async () => {
    const user = userEvent.setup();
    useBuildingsMock.mockReturnValue(liveResult<Building>([building()]));
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([site()]));
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-building-edit-cordera-building'));
    const dd = screen.getByTestId('config-building-kindoo-site') as HTMLSelectElement;
    expect(Array.from(dd.options).map((o) => o.text)).toEqual(['Home', 'East']);
    expect(dd.value).toBe('__home__');
  });

  it('Edit dialog pre-selects the existing kindoo_site_id', async () => {
    const user = userEvent.setup();
    useBuildingsMock.mockReturnValue(liveResult<Building>([building({ kindoo_site_id: 'east' })]));
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([site()]));
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-building-edit-cordera-building'));
    const dd = screen.getByTestId('config-building-kindoo-site') as HTMLSelectElement;
    expect(dd.value).toBe('east');
  });

  it('Edit submit writes the selected kindoo_site_id through the building upsert', async () => {
    const user = userEvent.setup();
    useBuildingsMock.mockReturnValue(liveResult<Building>([building()]));
    useKindooSitesMock.mockReturnValue(liveResult<KindooSite>([site()]));
    upsertBuildingMock.mockResolvedValue(undefined);
    render(<ConfigurationPage initialTab="buildings" />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('config-building-edit-cordera-building'));
    await user.selectOptions(screen.getByTestId('config-building-kindoo-site'), 'east');
    await user.click(screen.getByTestId('config-building-submit'));
    expect(upsertBuildingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        building_name: 'Cordera Building',
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
    await user.click(screen.getByTestId('config-building-edit-cordera-building'));
    await user.selectOptions(screen.getByTestId('config-building-kindoo-site'), '__home__');
    await user.click(screen.getByTestId('config-building-submit'));
    expect(upsertBuildingMock).toHaveBeenCalledWith(
      expect.objectContaining({ building_name: 'Cordera Building', kindoo_site_id: null }),
    );
  });
});
