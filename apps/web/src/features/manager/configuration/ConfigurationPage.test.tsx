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
  useUpsertWardCallingTemplateMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteWardCallingTemplateMutation: () => ({ mutateAsync: vi.fn() }),
  useUpsertStakeCallingTemplateMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteStakeCallingTemplateMutation: () => ({ mutateAsync: vi.fn() }),
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
});

describe('<ConfigurationPage />', () => {
  it('renders the wards tab by default', () => {
    render(<ConfigurationPage />, { wrapper: Wrapper });
    expect(screen.getByRole('heading', { name: /^Wards$/ })).toBeInTheDocument();
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

  it('renders the Triggers placeholder', () => {
    render(<ConfigurationPage initialTab="triggers" />, { wrapper: Wrapper });
    expect(screen.getByTestId('config-triggers')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Scheduled triggers/i })).toBeInTheDocument();
  });

  it('shows ward-form validation error on empty submit', async () => {
    const user = userEvent.setup();
    render(<ConfigurationPage initialTab="wards" />, { wrapper: Wrapper });
    await user.click(screen.getByRole('button', { name: /Save ward/i }));
    expect(await screen.findByText(/Ward code is required/i)).toBeInTheDocument();
  });
});
