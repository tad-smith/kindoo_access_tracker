// Component tests for the Manager Access page.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Access } from '@kindoo/shared';
import { makeAccess } from '../../../../test/fixtures';

const useAccessListMock = vi.fn();
const useStakeWardsMock = vi.fn();
const addManualMutate = vi.fn().mockResolvedValue(undefined);
const deleteManualMutate = vi.fn().mockResolvedValue(undefined);

vi.mock('./hooks', () => ({
  useAccessList: () => useAccessListMock(),
  useAddManualGrantMutation: () => ({ mutateAsync: addManualMutate, isPending: false }),
  useDeleteManualGrantMutation: () => ({ mutateAsync: deleteManualMutate, isPending: false }),
}));

vi.mock('../dashboard/hooks', () => ({
  useStakeWards: () => useStakeWardsMock(),
}));

// AccessPage filters the scope dropdown by the principal's claims.
// Default the test principal to a manager so all wards + 'stake'
// surface; individual tests can override.
vi.mock('../../../lib/principal', () => ({
  usePrincipal: () => ({
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    email: 'mgr@example.com',
    canonical: 'mgr@example.com',
    isPlatformSuperadmin: false,
    managerStakes: ['csnorth'],
    stakeMemberStakes: [],
    bishopricWards: {},
    hasAnyRole: () => true,
    wardsInStake: () => [],
  }),
}));

import { AccessPage } from './AccessPage';

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

beforeEach(() => {
  vi.clearAllMocks();
  useStakeWardsMock.mockReturnValue(liveResult([]));
});

describe('<AccessPage />', () => {
  it('renders the empty-state copy when no access rows exist', () => {
    useAccessListMock.mockReturnValue(liveResult<Access>([]));
    render(<AccessPage />);
    expect(screen.getByText(/no access rows/i)).toBeInTheDocument();
  });

  it('renders one card per user', () => {
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({ member_canonical: 'a@x.com', member_email: 'a@x.com' }),
        makeAccess({ member_canonical: 'b@x.com', member_email: 'b@x.com' }),
      ]),
    );
    render(<AccessPage />);
    expect(screen.getByTestId('access-card-a@x.com')).toBeInTheDocument();
    expect(screen.getByTestId('access-card-b@x.com')).toBeInTheDocument();
  });

  it('renders only the importer section for an importer-only user', () => {
    useAccessListMock.mockReturnValue(
      liveResult([makeAccess({ importer_callings: { CO: ['Bishop'] }, manual_grants: {} })]),
    );
    render(<AccessPage />);
    expect(screen.getByTestId('access-section-importer')).toBeInTheDocument();
    expect(screen.queryByTestId('access-section-manual')).toBeNull();
  });

  it('renders only the manual section for a manual-only user', () => {
    const grant = {
      grant_id: 'g1',
      reason: 'Covering bishop',
      granted_by: { email: 'm@example.com', canonical: 'm@example.com' },
      granted_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
    };
    useAccessListMock.mockReturnValue(
      liveResult([makeAccess({ importer_callings: {}, manual_grants: { stake: [grant] } })]),
    );
    render(<AccessPage />);
    expect(screen.queryByTestId('access-section-importer')).toBeNull();
    expect(screen.getByTestId('access-section-manual')).toBeInTheDocument();
    expect(screen.getByText(/covering bishop/i)).toBeInTheDocument();
  });

  it('renders both sections for a split-ownership user', () => {
    const grant = {
      grant_id: 'g1',
      reason: 'Stake exec',
      granted_by: { email: 'm@example.com', canonical: 'm@example.com' },
      granted_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
    };
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          importer_callings: { CO: ['Bishop'] },
          manual_grants: { stake: [grant] },
        }),
      ]),
    );
    render(<AccessPage />);
    const card = screen.getByTestId('access-card-alice@example.com');
    expect(within(card).getByTestId('access-section-importer')).toBeInTheDocument();
    expect(within(card).getByTestId('access-section-manual')).toBeInTheDocument();
  });

  it('filters by scope', async () => {
    const u = userEvent.setup();
    // Scope dropdown is sourced from the principal's claims + the wards
    // collection. Seed wards so CO + GE surface in the picker.
    useStakeWardsMock.mockReturnValue(
      liveResult([
        { ward_code: 'CO', ward_name: 'Cordera' },
        { ward_code: 'GE', ward_name: 'Genoa' },
      ]),
    );
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'co@x.com',
          member_email: 'co@x.com',
          importer_callings: { CO: ['Bishop'] },
        }),
        makeAccess({
          member_canonical: 'ge@x.com',
          member_email: 'ge@x.com',
          importer_callings: { GE: ['Bishop'] },
        }),
      ]),
    );
    render(<AccessPage />);
    expect(screen.getByTestId('access-card-co@x.com')).toBeInTheDocument();
    expect(screen.getByTestId('access-card-ge@x.com')).toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText(/^Scope:/), 'CO');
    expect(screen.getByTestId('access-card-co@x.com')).toBeInTheDocument();
    expect(screen.queryByTestId('access-card-ge@x.com')).toBeNull();
  });

  it('renders the Add Manual Access button (form is in a modal)', () => {
    useAccessListMock.mockReturnValue(liveResult<Access>([]));
    render(<AccessPage />);
    expect(screen.getByTestId('access-add-manual-button')).toBeInTheDocument();
    expect(screen.queryByTestId('add-manual-form')).toBeNull();
  });

  it('opens the Add Manual Access modal when the button is clicked', async () => {
    const u = userEvent.setup();
    useAccessListMock.mockReturnValue(liveResult<Access>([]));
    render(<AccessPage />);
    await u.click(screen.getByTestId('access-add-manual-button'));
    expect(screen.getByTestId('add-manual-form')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add Manual Access' })).toBeInTheDocument();
  });

  it('add-modal scope dropdown shows stake + one option per configured ward', async () => {
    const u = userEvent.setup();
    useStakeWardsMock.mockReturnValue(
      liveResult([
        { ward_code: 'GE', ward_name: 'Genoa' },
        { ward_code: 'CO', ward_name: 'Cordera' },
      ]),
    );
    useAccessListMock.mockReturnValue(liveResult<Access>([]));
    render(<AccessPage />);
    await u.click(screen.getByTestId('access-add-manual-button'));
    const dropdown = screen.getByTestId('add-manual-scope') as HTMLSelectElement;
    const values = Array.from(dropdown.options).map((o) => o.value);
    // 'stake' first; wards alphabetical.
    expect(values).toEqual(['stake', 'CO', 'GE']);
  });

  it('add-modal scope dropdown shows only stake when no wards are configured', async () => {
    const u = userEvent.setup();
    useStakeWardsMock.mockReturnValue(liveResult([]));
    useAccessListMock.mockReturnValue(liveResult<Access>([]));
    render(<AccessPage />);
    await u.click(screen.getByTestId('access-add-manual-button'));
    const dropdown = screen.getByTestId('add-manual-scope') as HTMLSelectElement;
    const values = Array.from(dropdown.options).map((o) => o.value);
    expect(values).toEqual(['stake']);
    expect(screen.getByTestId('add-manual-no-wards')).toBeInTheDocument();
  });

  it('add-modal scope dropdown is disabled while wards are still loading', async () => {
    const u = userEvent.setup();
    useStakeWardsMock.mockReturnValue(liveResult(undefined, true));
    useAccessListMock.mockReturnValue(liveResult<Access>([]));
    render(<AccessPage />);
    await u.click(screen.getByTestId('access-add-manual-button'));
    const dropdown = screen.getByTestId('add-manual-scope') as HTMLSelectElement;
    expect(dropdown).toBeDisabled();
  });

  it('invokes the add-mutation when the modal form is submitted with valid input', async () => {
    useAccessListMock.mockReturnValue(liveResult<Access>([]));
    const u = userEvent.setup();
    render(<AccessPage />);
    await u.click(screen.getByTestId('access-add-manual-button'));
    const form = screen.getByTestId('add-manual-form');
    await u.type(within(form).getByLabelText(/Email/i), 'sub@example.com');
    await u.type(within(form).getByLabelText(/Name/i), 'Sub');
    await u.type(within(form).getByLabelText(/Reason/i), 'Covering bishop');
    await u.click(screen.getByTestId('access-add-manual-submit'));
    expect(addManualMutate).toHaveBeenCalledWith(
      expect.objectContaining({ member_email: 'sub@example.com', reason: 'Covering bishop' }),
    );
  });

  it('opens the delete confirmation dialog when a grant Delete is clicked', async () => {
    const u = userEvent.setup();
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          manual_grants: {
            stake: [
              {
                grant_id: 'g1',
                reason: 'Covering bishop',
                granted_by: { email: 'm@x.com', canonical: 'm@x.com' },
                granted_at: {
                  seconds: 0,
                  nanoseconds: 0,
                  toDate: () => new Date(),
                  toMillis: () => 0,
                },
              },
            ],
          },
        }),
      ]),
    );
    render(<AccessPage />);
    const buttons = screen.getAllByRole('button', { name: /^Delete$/ });
    await u.click(buttons[0]!);
    expect(screen.getByText(/Remove manual access\?/i)).toBeInTheDocument();
    // Confirm via the dialog's Remove button.
    await u.click(screen.getByRole('button', { name: /^Remove$/ }));
    expect(deleteManualMutate).toHaveBeenCalled();
  });
});
