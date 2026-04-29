// Component tests for the Bootstrap Wizard page. We mock the Firestore
// hooks + mutations so the component renders without a live emulator.
// Coverage:
//   - Initial render shows step 1.
//   - Complete-Setup button is disabled until steps 1–3 all have data.
//   - Switching tabs renders the matching step pane.
//   - Step 1 form: form validation surfaces errors on empty submit.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Building, KindooManager, Stake, Ward } from '@kindoo/shared';

const useStakeDocMock = vi.fn();
const useBuildingsMock = vi.fn();
const useWardsMock = vi.fn();
const useManagersMock = vi.fn();
const ensureAdminMutate = vi.fn().mockResolvedValue(undefined);
const completeSetupMutate = vi.fn().mockResolvedValue(undefined);
const step1Mutate = vi.fn().mockResolvedValue(undefined);
const usePrincipalMock = vi.fn();
const navigateMock = vi.fn().mockResolvedValue(undefined);

vi.mock('./hooks', () => ({
  useStakeDoc: () => useStakeDocMock(),
  useBuildings: () => useBuildingsMock(),
  useWards: () => useWardsMock(),
  useManagers: () => useManagersMock(),
  useEnsureBootstrapAdmin: () => ({ mutateAsync: ensureAdminMutate }),
  useCompleteSetupMutation: () => ({ mutateAsync: completeSetupMutate, isPending: false }),
  useStep1Mutation: () => ({ mutateAsync: step1Mutate, isPending: false }),
  useAddBuildingMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteBuildingMutation: () => ({ mutateAsync: vi.fn() }),
  useAddWardMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteWardMutation: () => ({ mutateAsync: vi.fn() }),
  useAddManagerMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateManagerActiveMutation: () => ({ mutateAsync: vi.fn() }),
  useDeleteManagerMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../../lib/principal', () => ({
  usePrincipal: () => usePrincipalMock(),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));
vi.mock('./callables', () => ({
  invokeInstallScheduledJobs: vi.fn().mockResolvedValue({ ok: true }),
  invokeRunImportNow: vi.fn(),
}));

import { BootstrapWizardPage } from './BootstrapWizardPage';

function liveResult<T>(data: T[] | undefined) {
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

function stakeResult(data: Partial<Stake> | undefined) {
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

function makeStake(overrides: Partial<Stake> = {}): Partial<Stake> {
  return {
    stake_id: 'csnorth',
    stake_name: '',
    callings_sheet_id: '',
    stake_seat_cap: 0,
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: false,
    ...overrides,
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  usePrincipalMock.mockReturnValue({
    email: 'admin@example.com',
    canonical: 'admin@example.com',
  });
  useStakeDocMock.mockReturnValue(stakeResult(makeStake()));
  useBuildingsMock.mockReturnValue(liveResult<Building>([]));
  useWardsMock.mockReturnValue(liveResult<Ward>([]));
  useManagersMock.mockReturnValue(liveResult<KindooManager>([]));
});

describe('<BootstrapWizardPage />', () => {
  it('renders step 1 by default with the stake-setup form', () => {
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('wizard-step-1')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Stake settings/i })).toBeInTheDocument();
  });

  it('disables Complete Setup until steps 1–3 are valid', () => {
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('bootstrap-complete-setup')).toBeDisabled();
  });

  it('enables Complete Setup once stake/building/ward are populated', () => {
    useStakeDocMock.mockReturnValue(
      stakeResult(
        makeStake({
          stake_name: 'My Stake',
          callings_sheet_id: 'sheet1',
          stake_seat_cap: 200,
        }),
      ),
    );
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        {
          building_id: 'main',
          building_name: 'Main',
          address: '1 St',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]),
    );
    useWardsMock.mockReturnValue(
      liveResult<Ward>([
        {
          ward_code: 'CO',
          ward_name: 'Cordera',
          building_name: 'Main',
          seat_cap: 20,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]),
    );
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('bootstrap-complete-setup')).not.toBeDisabled();
  });

  it('switches to step 2 when the Buildings tab is clicked', async () => {
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('wizard-step-tab-2'));
    expect(screen.getByTestId('wizard-step-2')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('wizard-step-2')).getByRole('heading', { name: /Buildings/i }),
    ).toBeInTheDocument();
  });

  it('shows validation error when step 1 submitted with empty fields', async () => {
    useStakeDocMock.mockReturnValue(
      stakeResult(
        makeStake({
          stake_name: '',
          callings_sheet_id: '',
          stake_seat_cap: 0,
        }),
      ),
    );
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    // Click Save with stake_name empty
    await user.click(screen.getByRole('button', { name: /Save$/i }));
    expect(await screen.findByText(/Stake name is required/i)).toBeInTheDocument();
  });
});
