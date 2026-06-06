// Component tests for the NewRequestDialog — the roster-header modal
// wrapper around NewRequestForm. The form's own validation + field
// behaviour is covered by NewRequestForm.test.tsx; this file focuses on
// the dialog shell:
//
//   - locks the launched scope to a fixed label (no dropdown), even for
//     a multi-scope principal
//   - a successful submit closes the dialog (onOpenChange(false)),
//     toasts, and submits the launched scope
//   - Cancel closes the dialog without submitting
//   - the spinner renders while the shared data hook is loading

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Building, Seat, Ward } from '@kindoo/shared';
import type { ScopeOption } from './NewRequestForm';
import type { NewRequestFormData } from '../hooks';

const submitMock = vi.fn().mockResolvedValue({ id: 'req-stub' });
const useSeatForMemberMock = vi.fn();
const useNewRequestFormDataMock = vi.fn();
const toastMock = vi.fn();

vi.mock('../hooks', () => ({
  useSubmitRequest: () => ({ mutateAsync: submitMock, isPending: false }),
  useSeatForMember: (canonical: string | null) => useSeatForMemberMock(canonical),
  useNewRequestFormData: () => useNewRequestFormDataMock(),
}));

vi.mock('../../../lib/store/toast', () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));

// The org selector subscribes to the organizations catalogue. These
// tests don't exercise org behaviour, so return an empty live result;
// keep the real pure helpers (sortOrganizations / NO_ORGANIZATION_LABEL).
vi.mock('../../organizations/hooks', async () => {
  const actual = await vi.importActual<object>('../../organizations/hooks');
  return {
    ...actual,
    useOrganizations: () => ({
      data: [],
      error: null,
      status: 'success',
      isPending: false,
      isLoading: false,
      isSuccess: true,
      isError: false,
      isFetching: false,
      fetchStatus: 'idle',
    }),
  };
});

import { NewRequestDialog } from './NewRequestDialog';

const FAKE_TS = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
const FAKE_ACTOR = { email: 'a@b.c', canonical: 'a@b.c' } as const;

function building(id: string, name: string): Building {
  return {
    building_id: id,
    building_name: name,
    address: '',
    created_at: FAKE_TS,
    last_modified_at: FAKE_TS,
    lastActor: FAKE_ACTOR,
  } as unknown as Building;
}

function ward(code: string, building_name: string): Ward {
  return {
    ward_code: code,
    ward_name: `Ward ${code}`,
    building_name,
    seat_cap: 20,
    created_at: FAKE_TS,
    last_modified_at: FAKE_TS,
    lastActor: FAKE_ACTOR,
  } as unknown as Ward;
}

function liveSeatResult(seat: Seat | undefined) {
  return {
    data: seat,
    error: null,
    status: 'success',
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  } as const;
}

function mockFormData(overrides: Partial<NewRequestFormData> = {}) {
  const scopes: ScopeOption[] = overrides.scopes ?? [
    { value: 'stake', label: 'Stake' },
    { value: 'CO', label: 'Ward CO' },
    { value: 'GE', label: 'Ward GE' },
  ];
  useNewRequestFormDataMock.mockReturnValue({
    scopes,
    buildings: overrides.buildings ?? [building('maple', 'Maple Building')],
    wards: overrides.wards ?? [ward('CO', 'Maple Building'), ward('GE', 'Maple Building')],
    isLoading: overrides.isLoading ?? false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  submitMock.mockResolvedValue({ id: 'req-stub' });
  useSeatForMemberMock.mockReturnValue(liveSeatResult(undefined));
  mockFormData();
});

describe('<NewRequestDialog />', () => {
  it('renders the dialog with its title when open', () => {
    render(<NewRequestDialog open onOpenChange={() => {}} scope="CO" />);
    expect(screen.getByRole('heading', { name: 'New Request' })).toBeInTheDocument();
    expect(screen.getByTestId('new-request-form')).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(<NewRequestDialog open={false} onOpenChange={() => {}} scope="CO" />);
    expect(screen.queryByTestId('new-request-form')).toBeNull();
  });

  it('locks the launched scope to a fixed label (no dropdown) for a multi-scope principal', () => {
    // mockFormData() returns a multi-scope principal (stake + CO + GE).
    // The dialog narrows to the launched scope, so the form shows it as
    // a fixed label rather than a picker.
    render(<NewRequestDialog open onOpenChange={() => {}} scope="GE" />);
    expect(screen.queryByTestId('new-request-scope')).toBeNull();
    expect(screen.getByText('Requesting for:')).toBeInTheDocument();
    expect(screen.getByText('Ward GE')).toBeInTheDocument();
  });

  it('renders a spinner instead of the form while the data hook is loading', () => {
    mockFormData({ isLoading: true });
    render(<NewRequestDialog open onOpenChange={() => {}} scope="CO" />);
    expect(screen.queryByTestId('new-request-form')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('closes the dialog (onOpenChange false), toasts, and submits the launched scope', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<NewRequestDialog open onOpenChange={onOpenChange} scope="CO" />);
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(screen.getByTestId('new-request-submit'));
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    expect(submitMock).toHaveBeenCalledWith(expect.objectContaining({ scope: 'CO' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toastMock).toHaveBeenCalledWith('Request submitted.', 'success');
  });

  it('closes the dialog via Cancel without submitting', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<NewRequestDialog open onOpenChange={onOpenChange} scope="CO" />);
    await user.click(screen.getByTestId('new-request-cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(submitMock).not.toHaveBeenCalled();
  });
});
