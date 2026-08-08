// Component tests for the Bootstrap Wizard page. We mock the Firestore
// hooks + mutations so the component renders without a live emulator.
// Coverage:
//   - Initial render shows step 1.
//   - Complete-Setup button is disabled until steps 1–3 all have data.
//     Its helper text listing the remaining prerequisites renders on
//     step 4 only; steps 1–3 carry the step-scoped Next hint instead.
//   - Switching tabs renders the matching step pane.
//   - Next is disabled (with a reason) on step 2 with zero buildings
//     and step 3 with zero wards; step 1's Next, Back, and the step
//     tabs stay unrestricted.
//   - Step 1 form: form validation surfaces errors on empty submit.
//   - Step indicator turns green for steps whose validation passes.
//   - Bootstrap admin row hides both deactivate + delete actions
//     (deactivating themselves would lock them out).
//   - Mutation failures surface as error toasts (delete failures must
//     not be silent — the original staging-bug regression).
//   - Escape bar (PR #258 reviewer finding): a principal with other
//     accessible stakes gets a way back to them that overwrites BOTH
//     persisted storage tiers (so the resolver doesn't bounce back into
//     this bootstrap-only stake); a pure bootstrap admin (no other
//     stake) gets a sign-out control instead. Neither gates the
//     wizard's own step-through behaviour.
//   - Escape bar in-setup-stake exclusion (follow-up finding on PR
//     #258): the "Back to my stake(s)" control's source set excludes
//     the stake under setup, even after `useEnsureBootstrapAdmin`'s
//     in-session auto-add mutates `accessibleStakes(principal)` to
//     include it. A pure bootstrap admin who has been auto-added as
//     manager of the in-setup stake must see ONLY sign-out (not a
//     self-pointing back button); a dual-role admin whose bootstrap
//     stake sorts alphabetically first must be sent to their OTHER
//     stake, never the one under setup.
//
// `lib/activeStake` and `lib/useActiveStake` are NOT mocked here — the
// escape-bar tests exercise the real `accessibleStakes` / `useActiveStake` /
// `useActiveStakeSwitcher` implementations against jsdom's real
// sessionStorage/localStorage so the "does it actually stop the
// bounce-back" claim is verified, not assumed.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Building, KindooManager, Stake, Ward } from '@kindoo/shared';
import {
  ACTIVE_STAKE_LOCAL_KEY,
  ACTIVE_STAKE_SESSION_KEY,
  persistActiveStakeChoice,
} from '../../lib/activeStake';

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
const signOutMock = vi.fn();

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
vi.mock('../auth/signOut', () => ({
  signOut: () => signOutMock(),
}));

import { BootstrapWizardPage, nextBlocker } from './BootstrapWizardPage';

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
  window.sessionStorage.clear();
  window.localStorage.clear();
  // Default principal: a pure bootstrap admin with no claim-derived
  // stake access anywhere — the common case per PR #258's finding, and
  // the shape `accessibleStakes()` / `useActiveStake()` (both real,
  // unmocked here) read. Individual escape-bar tests override
  // `managerStakes` / `stakeMemberStakes` / `bishopricWards` /
  // `bootstrapStakes` to exercise the "other stakes" branch.
  // `bootstrapStakes` must always be present (even empty) — the real
  // `useActiveStake()`/`resolveActiveStake()` spreads it unconditionally.
  usePrincipalMock.mockReturnValue({
    email: 'admin@example.com',
    canonical: 'admin@example.com',
    managerStakes: [],
    stakeMemberStakes: [],
    bishopricWards: {},
    bootstrapStakes: [],
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
  signOutMock.mockResolvedValue(undefined);
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

  it('step 1 offers the Elders Quorum President app-access opt-in, off by default', () => {
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    const step = screen.getByTestId('wizard-step-1');
    const sw = within(step).getByTestId('bootstrap-eq-president-access');
    expect(sw).toHaveAttribute('role', 'switch');
    // Opt-in: the persisted field is absent on a fresh stake, so the
    // switch must render off (not on, as `notifications_enabled` would).
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(within(step).getByLabelText(/Elders Quorum Presidents Get App Access/i)).toBe(sw);
  });

  it('step 1 shows the opt-in switch on when the stake already has it set', () => {
    useStakeDocMock.mockReturnValue(stakeResult(makeStake({ eq_president_app_access: true })));
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('bootstrap-eq-president-access')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('step 1 writes the Elders Quorum President opt-in when saved', async () => {
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    await user.type(within(screen.getByTestId('wizard-step-1')).getByLabelText(/Stake name/i), 'S');
    await user.click(screen.getByTestId('bootstrap-eq-president-access'));
    await user.click(
      within(screen.getByTestId('wizard-step-1')).getByRole('button', { name: /^Save$/ }),
    );
    await vi.waitFor(() => {
      expect(step1Mutate).toHaveBeenCalledWith(
        expect.objectContaining({ eq_president_app_access: true }),
      );
    });
  });

  it('step 1 raises no backfill dialog when the opt-in is toggled during setup', async () => {
    // Deliberate: a stake still in setup has no seats to reconcile, so
    // the wizard saves silently where the Config tab would prompt.
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    await user.type(within(screen.getByTestId('wizard-step-1')).getByLabelText(/Stake name/i), 'S');
    await user.click(screen.getByTestId('bootstrap-eq-president-access'));
    await user.click(
      within(screen.getByTestId('wizard-step-1')).getByRole('button', { name: /^Save$/ }),
    );
    await vi.waitFor(() => expect(step1Mutate).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(/Grant access now/i)).toBeNull();
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

  it('lists missing prerequisites under the Complete Setup button on step 4', async () => {
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('wizard-step-tab-4'));
    const blockers = screen.getByTestId('bootstrap-complete-blockers');
    expect(blockers).toHaveTextContent(/Fill in stake name/);
    expect(blockers).toHaveTextContent(/at least one building/);
    expect(blockers).toHaveTextContent(/at least one ward/);
  });

  it('keeps the full checklist on step 4 even for blockers the earlier steps own', async () => {
    // Step 4 is the only place the whole list renders, so it must still
    // name the building and ward gaps the step-2/3 Next hints covered.
    useStakeDocMock.mockReturnValue(
      stakeResult(makeStake({ stake_name: 'My Stake', stake_seat_cap: 200 })),
    );
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('wizard-step-tab-4'));
    const blockers = screen.getByTestId('bootstrap-complete-blockers');
    expect(blockers).not.toHaveTextContent(/Fill in stake name/);
    expect(blockers).toHaveTextContent(/at least one building \(Step 2\)/);
    expect(blockers).toHaveTextContent(/at least one ward \(Step 3\)/);
  });

  it('does not repeat the checklist on steps 1-3, where the Next hint speaks instead', async () => {
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    // Step 1: nothing to say beyond the step's own Save.
    expect(screen.queryByTestId('bootstrap-complete-blockers')).not.toBeInTheDocument();

    for (const step of [2, 3]) {
      await user.click(screen.getByTestId(`wizard-step-tab-${step}`));
      expect(screen.queryByTestId('bootstrap-complete-blockers')).not.toBeInTheDocument();
      // The step-scoped hint is what explains the blocked Next there.
      expect(screen.getByTestId('bootstrap-next-blocker')).toBeInTheDocument();
    }

    await user.click(screen.getByTestId('wizard-step-tab-4'));
    expect(screen.getByTestId('bootstrap-complete-blockers')).toBeInTheDocument();
    expect(screen.queryByTestId('bootstrap-next-blocker')).not.toBeInTheDocument();
  });

  it('drops the helper-text blockers list on step 4 once every prerequisite is met', async () => {
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
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('wizard-step-tab-4'));
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

  it('blocks adding a ward whose name matches one already in the list (legacy code)', async () => {
    useBuildingsMock.mockReturnValue(
      liveResult<Building>([
        { building_id: 'maple-building', building_name: 'Maple Building', address: '' } as Building,
      ]),
    );
    // A legacy ward at doc id 'CO' named 'Maple Ward' — the name-based
    // check must catch a re-add of 'Maple Ward' even though it slugs to a
    // different id ('maple-ward').
    useWardsMock.mockReturnValue(
      liveResult<Ward>([
        {
          ward_code: 'CO',
          ward_name: 'Maple Ward',
          building_name: 'Maple Building',
          seat_cap: 20,
        } as Ward,
      ]),
    );
    const user = userEvent.setup();
    render(<BootstrapWizardPage />, { wrapper: Wrapper });
    await user.click(screen.getByTestId('wizard-step-tab-3'));
    await user.type(screen.getByLabelText(/Ward name/i), 'maple ward');
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

  describe('Next-button gating on the buildings and wards steps', () => {
    const building = { building_id: 'b1', building_name: 'B', address: '' } as Building;
    const ward = {
      ward_code: 'CO',
      ward_name: 'Maple',
      building_name: 'B',
      seat_cap: 1,
    } as Ward;

    it('leaves Next enabled on step 1 regardless of buildings and wards', async () => {
      const user = userEvent.setup();
      render(<BootstrapWizardPage />, { wrapper: Wrapper });
      expect(screen.getByTestId('bootstrap-next')).not.toBeDisabled();
      expect(screen.queryByTestId('bootstrap-next-blocker')).not.toBeInTheDocument();

      await user.click(screen.getByTestId('bootstrap-next'));
      expect(screen.getByTestId('wizard-step-2')).toBeInTheDocument();
    });

    it('disables Next on the buildings step until a building exists, and says why', async () => {
      const user = userEvent.setup();
      render(<BootstrapWizardPage />, { wrapper: Wrapper });
      await user.click(screen.getByTestId('wizard-step-tab-2'));

      expect(screen.getByTestId('bootstrap-next')).toBeDisabled();
      expect(screen.getByTestId('bootstrap-next-blocker')).toHaveTextContent(
        /Add at least one building to continue/i,
      );
    });

    it('enables Next on the buildings step once a building exists', async () => {
      useBuildingsMock.mockReturnValue(liveResult<Building>([building]));
      const user = userEvent.setup();
      render(<BootstrapWizardPage />, { wrapper: Wrapper });
      await user.click(screen.getByTestId('wizard-step-tab-2'));

      expect(screen.getByTestId('bootstrap-next')).not.toBeDisabled();
      expect(screen.queryByTestId('bootstrap-next-blocker')).not.toBeInTheDocument();

      await user.click(screen.getByTestId('bootstrap-next'));
      expect(screen.getByTestId('wizard-step-3')).toBeInTheDocument();
    });

    it('points at the missing building, not the ward, when step 3 is reached with step 2 empty', async () => {
      // The tabs make this reachable, and `Step3Wards` disables its own
      // Add-ward button here — so "add a ward" would name an impossible
      // action.
      const user = userEvent.setup();
      render(<BootstrapWizardPage />, { wrapper: Wrapper });
      await user.click(screen.getByTestId('wizard-step-tab-3'));

      expect(screen.getByTestId('bootstrap-next')).toBeDisabled();
      expect(screen.getByTestId('bootstrap-next-blocker')).toHaveTextContent(
        /Add a building \(Step 2\) before adding wards/i,
      );
      expect(screen.getByTestId('bootstrap-next-blocker')).not.toHaveTextContent(/one ward/i);
    });

    it('disables Next on the wards step until a ward exists, and says why', async () => {
      // Buildings populated so the block is unambiguously the ward one.
      useBuildingsMock.mockReturnValue(liveResult<Building>([building]));
      const user = userEvent.setup();
      render(<BootstrapWizardPage />, { wrapper: Wrapper });
      await user.click(screen.getByTestId('wizard-step-tab-3'));

      expect(screen.getByTestId('bootstrap-next')).toBeDisabled();
      expect(screen.getByTestId('bootstrap-next-blocker')).toHaveTextContent(
        /Add at least one ward to continue/i,
      );
    });

    it('enables Next on the wards step once a ward exists', async () => {
      useBuildingsMock.mockReturnValue(liveResult<Building>([building]));
      useWardsMock.mockReturnValue(liveResult<Ward>([ward]));
      const user = userEvent.setup();
      render(<BootstrapWizardPage />, { wrapper: Wrapper });
      await user.click(screen.getByTestId('wizard-step-tab-3'));

      expect(screen.getByTestId('bootstrap-next')).not.toBeDisabled();

      await user.click(screen.getByTestId('bootstrap-next'));
      expect(screen.getByTestId('wizard-step-4')).toBeInTheDocument();
    });

    it('keeps the step tabs freely clickable while Next is blocked', async () => {
      const user = userEvent.setup();
      render(<BootstrapWizardPage />, { wrapper: Wrapper });

      // Zero buildings and zero wards — Next is blocked on 2 and 3, but
      // the tabs are the deliberate escape hatch and skip straight past.
      await user.click(screen.getByTestId('wizard-step-tab-2'));
      expect(screen.getByTestId('bootstrap-next')).toBeDisabled();

      await user.click(screen.getByTestId('wizard-step-tab-4'));
      expect(screen.getByTestId('wizard-step-4')).toBeInTheDocument();

      await user.click(screen.getByTestId('wizard-step-tab-3'));
      expect(screen.getByTestId('wizard-step-3')).toBeInTheDocument();

      await user.click(screen.getByTestId('wizard-step-tab-1'));
      expect(screen.getByTestId('wizard-step-1')).toBeInTheDocument();
    });

    it('keeps Back working out of a step whose Next is blocked', async () => {
      const user = userEvent.setup();
      render(<BootstrapWizardPage />, { wrapper: Wrapper });
      await user.click(screen.getByTestId('wizard-step-tab-2'));
      expect(screen.getByTestId('bootstrap-next')).toBeDisabled();

      await user.click(screen.getByRole('button', { name: /^Back$/ }));
      expect(screen.getByTestId('wizard-step-1')).toBeInTheDocument();
    });
  });

  describe('escape bar (PR #258 finding: "Setup needed" was a one-way door)', () => {
    it('offers a way back to other accessible stakes and does not bounce back into the wizard', async () => {
      // Simulate the precondition that created the one-way door: the
      // StakeSwitcher's "Setup needed" click already wrote THIS
      // bootstrap-only stake into both storage tiers before landing here.
      persistActiveStakeChoice('bootstrap-only-stake');
      expect(window.sessionStorage.getItem(ACTIVE_STAKE_SESSION_KEY)).toBe('bootstrap-only-stake');
      expect(window.localStorage.getItem(ACTIVE_STAKE_LOCAL_KEY)).toBe('bootstrap-only-stake');

      usePrincipalMock.mockReturnValue({
        email: 'admin@example.com',
        canonical: 'admin@example.com',
        managerStakes: ['acmestake'],
        stakeMemberStakes: [],
        bishopricWards: {},
        // Named bootstrap admin of 'bootstrap-only-stake' (the stake the
        // wizard is FOR) — required for the real `useActiveStake()` to
        // actually resolve the persisted storage value to it, same as
        // the live app would while this wizard is showing.
        bootstrapStakes: ['bootstrap-only-stake'],
      });
      const user = userEvent.setup();
      render(<BootstrapWizardPage />, { wrapper: Wrapper });

      expect(screen.queryByTestId('wizard-escape-sign-out')).toBeInTheDocument();
      const back = screen.getByTestId('wizard-escape-back-to-stakes');
      expect(back).toHaveTextContent(/Back to my stake/i);

      await user.click(back);

      expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true });
      // The stale bootstrap-only value must be OVERWRITTEN in both
      // tiers — leaving it in place is exactly what re-resolves back
      // into this wizard on the next render (the reported bug).
      expect(window.sessionStorage.getItem(ACTIVE_STAKE_SESSION_KEY)).toBe('acmestake');
      expect(window.localStorage.getItem(ACTIVE_STAKE_LOCAL_KEY)).toBe('acmestake');
    });

    it('renders sign-out (no way-back link) for a pure bootstrap admin with no other accessible stakes', async () => {
      // Default beforeEach principal already has zero accessible stakes.
      const user = userEvent.setup();
      render(<BootstrapWizardPage />, { wrapper: Wrapper });

      expect(screen.queryByTestId('wizard-escape-back-to-stakes')).not.toBeInTheDocument();
      const signOutButton = screen.getByTestId('wizard-escape-sign-out');
      expect(signOutButton).toHaveTextContent(/Sign out/i);

      await user.click(signOutButton);
      expect(signOutMock).toHaveBeenCalledTimes(1);
    });

    it('shows only Sign out for a pure bootstrap admin already auto-added as manager of the in-setup stake', async () => {
      // The post-auto-add claim shape: `useEnsureBootstrapAdmin` (the
      // effect at the top of the page component) mints a manager claim
      // on THIS stake in-session, so `managerStakes` now includes it —
      // exactly the mutation that made the un-filtered escape bar point
      // "Back to my stake" straight back into the wizard it's supposed
      // to escape. `bootstrapStakes` still carries the marker too
      // (setup isn't complete yet). Omitting either half of this shape
      // would let the bug pass unnoticed.
      usePrincipalMock.mockReturnValue({
        email: 'admin@example.com',
        canonical: 'admin@example.com',
        managerStakes: ['onlystake'],
        stakeMemberStakes: [],
        bishopricWards: {},
        bootstrapStakes: ['onlystake'],
      });
      const user = userEvent.setup();
      render(<BootstrapWizardPage />, { wrapper: Wrapper });

      // No self-pointing "Back to my stake" — the only accessible stake
      // IS the one under setup.
      expect(screen.queryByTestId('wizard-escape-back-to-stakes')).not.toBeInTheDocument();
      const signOutButton = screen.getByTestId('wizard-escape-sign-out');
      expect(signOutButton).toHaveTextContent(/Sign out/i);

      await user.click(signOutButton);
      expect(signOutMock).toHaveBeenCalledTimes(1);
    });

    it('sends a dual-role admin whose bootstrap stake sorts first to their OTHER stake, not the one under setup', async () => {
      // `aaa-bootstrap-stake` sorts before `zzz-real-stake`, so it wins
      // tier 4 of `resolveActiveStake` and is the stake this wizard is
      // FOR. The admin is also a manager of `zzz-real-stake` elsewhere.
      // An unfiltered escape bar would offer only the alphabetically-
      // first accessible stake — the bootstrap stake itself — losing
      // the route back to the admin's real stake entirely.
      usePrincipalMock.mockReturnValue({
        email: 'admin@example.com',
        canonical: 'admin@example.com',
        managerStakes: ['aaa-bootstrap-stake', 'zzz-real-stake'],
        stakeMemberStakes: [],
        bishopricWards: {},
        bootstrapStakes: ['aaa-bootstrap-stake'],
      });
      const user = userEvent.setup();
      render(<BootstrapWizardPage />, { wrapper: Wrapper });

      const back = screen.getByTestId('wizard-escape-back-to-stakes');
      // Singular label — the filtered set has exactly one entry
      // (`zzz-real-stake`); the excluded bootstrap stake doesn't count.
      expect(back).toHaveTextContent(/Back to my stake/i);

      await user.click(back);

      expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true });
      expect(window.sessionStorage.getItem(ACTIVE_STAKE_SESSION_KEY)).toBe('zzz-real-stake');
      expect(window.localStorage.getItem(ACTIVE_STAKE_LOCAL_KEY)).toBe('zzz-real-stake');
    });

    it('does not itself gate step-through: the ungated step-1 Next and the step tabs still move', async () => {
      const user = userEvent.setup();
      render(<BootstrapWizardPage />, { wrapper: Wrapper });
      expect(screen.getByTestId('wizard-escape-sign-out')).toBeInTheDocument();

      // Step 1's Next is ungated (only steps 2 and 3 gate on their own
      // data — see the Next-button gating block above).
      await user.click(screen.getByTestId('bootstrap-next'));
      expect(screen.getByTestId('wizard-step-2')).toBeInTheDocument();

      // And the tabs stay free even from a step whose Next is blocked.
      await user.click(screen.getByTestId('wizard-step-tab-4'));
      expect(screen.getByTestId('wizard-step-4')).toBeInTheDocument();
    });
  });
});

describe('nextBlocker()', () => {
  it('blocks only step 2 without buildings and step 3 without wards', () => {
    expect(nextBlocker({ step: 1, step2Done: false, step3Done: false })).toBeNull();
    expect(nextBlocker({ step: 2, step2Done: false, step3Done: false })).toMatch(/one building/i);
    expect(nextBlocker({ step: 2, step2Done: true, step3Done: false })).toBeNull();
    expect(nextBlocker({ step: 3, step2Done: true, step3Done: false })).toMatch(/one ward/i);
    // Step 3 reached via the tabs with step 2 still empty: naming the
    // ward would instruct an action the step's own form disables.
    expect(nextBlocker({ step: 3, step2Done: false, step3Done: false })).toMatch(
      /building \(Step 2\)/i,
    );
    expect(nextBlocker({ step: 3, step2Done: true, step3Done: true })).toBeNull();
    expect(nextBlocker({ step: 4, step2Done: false, step3Done: false })).toBeNull();
  });
});
