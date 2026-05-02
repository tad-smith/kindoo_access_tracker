// Component tests for the Configuration page. Each tab is exercised
// once: list rendering + form validation. Mutations are mocked.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Building, KindooManager, Stake, Ward } from '@kindoo/shared';

const useStakeDocMock = vi.fn();
const useWardsMock = vi.fn();
const useBuildingsMock = vi.fn();
const useManagersMock = vi.fn();
const useWardCallingTemplatesMock = vi.fn();
const useStakeCallingTemplatesMock = vi.fn();
const navigateMock = vi.fn().mockResolvedValue(undefined);

const addWardCallingTemplateMock = vi.fn();
const upsertWardCallingTemplateMock = vi.fn();
const deleteWardCallingTemplateWithResequenceMock = vi.fn();
const reorderWardCallingTemplatesMock = vi.fn();
const addStakeCallingTemplateMock = vi.fn();
const upsertStakeCallingTemplateMock = vi.fn();
const deleteStakeCallingTemplateWithResequenceMock = vi.fn();
const reorderStakeCallingTemplatesMock = vi.fn();

vi.mock('./hooks', () => ({
  useStakeDoc: () => useStakeDocMock(),
  useWards: () => useWardsMock(),
  useBuildings: () => useBuildingsMock(),
  useManagers: () => useManagersMock(),
  useWardCallingTemplates: () => useWardCallingTemplatesMock(),
  useStakeCallingTemplates: () => useStakeCallingTemplatesMock(),
  useUpsertWardMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteWardMutation: () => ({ mutateAsync: vi.fn() }),
  useUpsertBuildingMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteBuildingMutation: () => ({ mutateAsync: vi.fn() }),
  useUpsertManagerMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteManagerMutation: () => ({ mutateAsync: vi.fn() }),
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

// Stub the Push Notifications panel — it owns its own data hooks +
// browser APIs that aren't relevant to the Configuration test surface.
// The panel's own component test exercises its rendering states.
vi.mock('../../notifications/components/PushNotificationsPanel', () => ({
  PushNotificationsPanel: () => <div data-testid="push-notifications-panel-stub" />,
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
});

describe('<ConfigurationPage />', () => {
  it('renders the Config tab by default (leftmost)', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    expect(screen.getByRole('heading', { name: /^Stake config$/ })).toBeInTheDocument();
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

  it('renders the notifications-enabled checkbox with the email-specific label', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/Email Notifications Enabled/i)).toBeInTheDocument();
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
