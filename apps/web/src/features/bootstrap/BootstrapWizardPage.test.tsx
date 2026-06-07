// Component tests for the Bootstrap Wizard page. We mock the Firestore
// hooks + mutations so the component renders without a live emulator.
// Coverage:
//   - Initial render shows step 1.
//   - Complete-Setup button is disabled until steps 1–3 all have data
//     and surfaces helper text listing the remaining prerequisites.
//   - Switching tabs renders the matching step pane.
//   - Step 1 form: form validation surfaces errors on empty submit.
//   - Step indicator turns green for steps whose validation passes.
//   - Bootstrap admin row hides both deactivate + delete actions
//     (deactivating themselves would lock them out).
//   - Mutation failures surface as error toasts (delete failures must
//     not be silent — the original staging-bug regression).

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
const toastSpy = vi.fn();

const deleteBuildingMutate = vi.fn();
const deleteWardMutate = vi.fn();
const deleteManagerMutate = vi.fn();
const addBuildingMutate = vi.fn();
const addWardMutate = vi.fn();
const addManagerMutate = vi.fn();

vi.mock('./hooks', () => ({
  useStakeDoc: () => useStakeDocMock(),
  useBuildings: () => useBuildingsMock(),
  useWards: () => useWardsMock(),
  useManagers: () => useManagersMock(),
  useEnsureBootstrapAdmin: () => ({ mutateAsync: ensureAdminMutate }),
  useCompleteSetupMutation: () => ({ mutateAsync: completeSetupMutate, isPending: false }),
  useStep1Mutation: () => ({ mutateAsync: step1Mutate, isPending: false }),
  useAddBuildingMutation: () => ({ mutateAsync: addBuildingMutate, isPending: false }),
  useDeleteBuildingMutation: () => ({ mutateAsync: deleteBuildingMutate }),
  useAddWardMutation: () => ({ mutateAsync: addWardMutate, isPending: false }),
  useDeleteWardMutation: () => ({ mutateAsync: deleteWardMutate }),
  useAddManagerMutation: () => ({ mutateAsync: addManagerMutate, isPending: false }),
  useUpdateManagerActiveMutation: () => ({ mutateAsync: vi.fn() }),
  useDeleteManagerMutation: () => ({ mutateAsync: deleteManagerMutate }),
}));
// `useToastStore` is consumed by the wizard's mounted <ToastHost />.
// The component test only cares about toast() calls, so we stub the
// store hook with an empty toast list. Mock acts like a Zustand store
// hook (selector in, selected slice out).
vi.mock('../../lib/store/toast', () => {
  const state = { toasts: [] as unknown[], dismiss: () => {} };
  type Selector<T> = (s: typeof state) => T;
  const useToastStore = <T,>(sel: Selector<T>) => sel(state);
  return {
    toast: (msg: string, kind?: string) => toastSpy(msg, kind),
    useToastStore,
  };
});
vi.mock('../../lib/principal', () => ({
  usePrincipal: () => usePrincipalMock(),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
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
    stake_name: '',
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
  // Default: mutation calls resolve. Individual tests override to reject.
  deleteBuildingMutate.mockResolvedValue(undefined);
  deleteWardMutate.mockResolvedValue(undefined);
  deleteManagerMutate.mockResolvedValue(undefined);
  addBuildingMutate.mockResolvedValue(undefined);
  addWardMutate.mockResolvedValue(undefined);
  addManagerMutate.mockResolvedValue(undefined);
});

describe('<BootstrapWizardPage />', () => {
  it('renders step 1 by default with the stake-setup form', () => {
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('wizard-step-1')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Stake settings/i })).toBeInTheDocument();
  });

  it('step 1 does NOT collect a callings-sheet ID (T-45)', () => {
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    const step = screen.getByTestId('wizard-step-1');
    // No "Callings" / "sheet" label, no input bound to the field.
    expect(within(step).queryByLabelText(/callings/i)).not.toBeInTheDocument();
    expect(within(step).queryByLabelText(/sheet/i)).not.toBeInTheDocument();
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
          ward_name: 'Maple',
          building_name: 'Main',
          seat_cap: 20,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]),
    );
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('bootstrap-complete-setup')).not.toBeDisabled();
  });

  it('completes setup via the Firestore flip alone and surfaces the success toast', async () => {
    // Complete Setup is now the single `setup_complete=true` flip — no
    // scheduled-jobs callable. Clicking it must run the flip mutation,
    // surface "Setup complete!", and navigate home for the gate to
    // redirect.
    useStakeDocMock.mockReturnValue(
      stakeResult(makeStake({ stake_name: 'My Stake', stake_seat_cap: 200 })),
    );
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        { building_id: 'main', building_name: 'Main', address: '1 St' } as Building,
      ]),
    );
    useWardsMock.mockReturnValue(
      liveResult<Ward>([
        { ward_code: 'CO', ward_name: 'Maple', building_name: 'Main', seat_cap: 20 } as Ward,
      ]),
    );
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('bootstrap-complete-setup'));
    await vi.waitFor(() => expect(completeSetupMutate).toHaveBeenCalledTimes(1));
    expect(toastSpy).toHaveBeenCalledWith('Setup complete!', 'success');
    expect(navigateMock).toHaveBeenCalled();
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

  it('lists missing prerequisites under the Complete Setup button when disabled', () => {
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    const blockers = screen.getByTestId('bootstrap-complete-blockers');
    expect(blockers).toHaveTextContent(/Fill in stake name/);
    expect(blockers).toHaveTextContent(/at least one building/);
    expect(blockers).toHaveTextContent(/at least one ward/);
  });

  it('drops the helper-text blockers list once every prerequisite is met', () => {
    useStakeDocMock.mockReturnValue(
      stakeResult(
        makeStake({
          stake_name: 'My Stake',
          stake_seat_cap: 200,
        }),
      ),
    );
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([{ building_id: 'b1', building_name: 'B', address: '' } as Building]),
    );
    useWardsMock.mockReturnValue(
      liveResult<Ward>([
        { ward_code: 'CO', ward_name: 'Maple', building_name: 'B', seat_cap: 1 } as Ward,
      ]),
    );
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    expect(screen.queryByTestId('bootstrap-complete-blockers')).not.toBeInTheDocument();
  });

  it('marks step indicator green for steps whose validation passes', () => {
    useStakeDocMock.mockReturnValue(
      stakeResult(
        makeStake({
          stake_name: 'My Stake',
          stake_seat_cap: 200,
        }),
      ),
    );
    useBuildingsMock.mockReturnValue(liveResult<Building>([]));
    useWardsMock.mockReturnValue(liveResult<Ward>([]));
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('wizard-step-tab-1')).toHaveAttribute('data-step-done', 'true');
    // Buildings and wards still empty → step 2/3 not done.
    expect(screen.getByTestId('wizard-step-tab-2')).toHaveAttribute('data-step-done', 'false');
    expect(screen.getByTestId('wizard-step-tab-3')).toHaveAttribute('data-step-done', 'false');
    // Trailing pill is the canFinish summary; off until 1+2+3 all done.
    expect(screen.getByTestId('wizard-step-complete-pill')).toHaveAttribute(
      'data-step-done',
      'false',
    );
  });

  it('turns the trailing complete pill green once every step is satisfied', () => {
    useStakeDocMock.mockReturnValue(
      stakeResult(
        makeStake({
          stake_name: 'My Stake',
          stake_seat_cap: 200,
        }),
      ),
    );
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([{ building_id: 'b1', building_name: 'B', address: '' } as Building]),
    );
    useWardsMock.mockReturnValue(
      liveResult<Ward>([
        { ward_code: 'CO', ward_name: 'Maple', building_name: 'B', seat_cap: 1 } as Ward,
      ]),
    );
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('wizard-step-tab-1')).toHaveAttribute('data-step-done', 'true');
    expect(screen.getByTestId('wizard-step-tab-2')).toHaveAttribute('data-step-done', 'true');
    expect(screen.getByTestId('wizard-step-tab-3')).toHaveAttribute('data-step-done', 'true');
    expect(screen.getByTestId('wizard-step-complete-pill')).toHaveAttribute(
      'data-step-done',
      'true',
    );
  });

  it('hides deactivate + delete on the bootstrap admin manager row', async () => {
    const adminCanonical = 'admin@example.com';
    useStakeDocMock.mockReturnValue(
      stakeResult(makeStake({ bootstrap_admin_email: 'admin@example.com' })),
    );
    useManagersMock.mockReturnValue(
      liveResult<KindooManager>([
        {
          member_canonical: adminCanonical,
          member_email: 'admin@example.com',
          name: 'Admin',
          active: true,
        } as KindooManager,
        {
          member_canonical: 'other@example.com',
          member_email: 'other@example.com',
          name: 'Other',
          active: true,
        } as KindooManager,
      ]),
    );
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('wizard-step-tab-4'));
    // Bootstrap admin row: no toggle, no delete.
    expect(
      screen.queryByTestId(`bootstrap-manager-toggle-${adminCanonical}`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`bootstrap-manager-delete-${adminCanonical}`),
    ).not.toBeInTheDocument();
    // Other manager row keeps both buttons.
    expect(screen.getByTestId('bootstrap-manager-toggle-other@example.com')).toBeInTheDocument();
    expect(screen.getByTestId('bootstrap-manager-delete-other@example.com')).toBeInTheDocument();
  });

  it('manager add form has no Active checkbox', async () => {
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('wizard-step-tab-4'));
    expect(screen.queryByLabelText(/^Active$/)).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('wizard-step-4')).queryByRole('checkbox', { name: /Active/i }),
    ).not.toBeInTheDocument();
  });

  it('surfaces an error toast when building delete fails', async () => {
    deleteBuildingMutate.mockRejectedValue(new Error('Permission denied: delete buildings'));
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([{ building_id: 'b1', building_name: 'B', address: '' } as Building]),
    );
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('wizard-step-tab-2'));
    await user.click(screen.getByTestId('bootstrap-building-delete-b1'));
    // The component .catch surfaces the error message via toast(..., 'error').
    await vi.waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied: delete buildings'),
        'error',
      ),
    );
  });

  it('passes building name + wards snapshot to the delete mutation so the ref-guard can compute', async () => {
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        { building_id: 'main', building_name: 'Main Building', address: '' } as Building,
      ]),
    );
    const wardsList = [
      { ward_code: 'CO', ward_name: 'Maple', building_name: 'Other', seat_cap: 1 } as Ward,
    ];
    useWardsMock.mockReturnValue(liveResult<Ward>(wardsList));
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('wizard-step-tab-2'));
    await user.click(screen.getByTestId('bootstrap-building-delete-main'));
    await vi.waitFor(() =>
      expect(deleteBuildingMutate).toHaveBeenCalledWith({
        buildingId: 'main',
        buildingName: 'Main Building',
        wards: wardsList,
      }),
    );
  });

  it('surfaces the ref-guard message when the mutation rejects with it', async () => {
    deleteBuildingMutate.mockRejectedValue(
      new Error('Cannot delete: referenced by 1 ward(s) — Maple'),
    );
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        { building_id: 'main', building_name: 'Main Building', address: '' } as Building,
      ]),
    );
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('wizard-step-tab-2'));
    await user.click(screen.getByTestId('bootstrap-building-delete-main'));
    await vi.waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cannot delete: referenced by'),
        'error',
      ),
    );
  });

  it('surfaces an error toast when ward delete fails', async () => {
    deleteWardMutate.mockRejectedValue(new Error('Permission denied: delete wards'));
    useWardsMock.mockReturnValue(
      liveResult<Ward>([
        { ward_code: 'CO', ward_name: 'Maple', building_name: 'B', seat_cap: 1 } as Ward,
      ]),
    );
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('wizard-step-tab-3'));
    await user.click(screen.getByTestId('bootstrap-ward-delete-CO'));
    await vi.waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied: delete wards'),
        'error',
      ),
    );
  });

  it('writes both building_id and building_name when a ward is added', async () => {
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        { building_id: 'maple-building', building_name: 'Maple Building', address: '' } as Building,
      ]),
    );
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('wizard-step-tab-3'));
    await user.type(screen.getByLabelText(/Ward name/i), 'Maple');
    // The select value is the immutable slug, not the display name.
    await user.selectOptions(screen.getByLabelText('Building'), 'maple-building');
    await user.click(screen.getByRole('button', { name: /Add ward/i }));
    await vi.waitFor(() => expect(addWardMutate).toHaveBeenCalled());
    const arg = addWardMutate.mock.calls[0]![0];
    expect(arg).toEqual(
      expect.objectContaining({
        ward_name: 'Maple',
        building_id: 'maple-building',
        building_name: 'Maple Building',
      }),
    );
    // The code is derived by the mutation, not typed in the form.
    expect(arg).not.toHaveProperty('ward_code');
  });

  it('blocks adding a ward whose name slugs to one already in the list', async () => {
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        { building_id: 'maple-building', building_name: 'Maple Building', address: '' } as Building,
      ]),
    );
    // An existing ward whose doc id is the slug of "Maple Ward".
    useWardsMock.mockReturnValue(
      liveResult<Ward>([
        {
          ward_code: 'maple-ward',
          ward_name: 'Maple Ward',
          building_name: 'Maple Building',
          seat_cap: 20,
        } as Ward,
      ]),
    );
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('wizard-step-tab-3'));
    await user.type(screen.getByLabelText(/Ward name/i), 'Maple Ward');
    await user.selectOptions(screen.getByLabelText('Building'), 'maple-building');
    await user.click(screen.getByRole('button', { name: /Add ward/i }));
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    expect(addWardMutate).not.toHaveBeenCalled();
  });

  it('surfaces an error toast when manager delete fails', async () => {
    deleteManagerMutate.mockRejectedValue(new Error('Permission denied: delete kindooManagers'));
    useManagersMock.mockReturnValue(
      liveResult<KindooManager>([
        {
          member_canonical: 'other@example.com',
          member_email: 'other@example.com',
          name: 'Other',
          active: true,
        } as KindooManager,
      ]),
    );
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('wizard-step-tab-4'));
    await user.click(screen.getByTestId('bootstrap-manager-delete-other@example.com'));
    await vi.waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied: delete kindooManagers'),
        'error',
      ),
    );
  });
});
