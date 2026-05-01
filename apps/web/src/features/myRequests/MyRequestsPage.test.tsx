// Component tests for the cross-role MyRequests page. Mocks the live
// hook + cancel mutation so the test exercises rendering shape + the
// cancel-confirmation dance.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccessRequest } from '@kindoo/shared';
import { makeRequest } from '../../../test/fixtures';

const usePrincipalMock = vi.fn();
const useMyRequestsMock = vi.fn();
const useCancelRequestMock = vi.fn();

vi.mock('../../lib/principal', () => ({
  usePrincipal: () => usePrincipalMock(),
}));

vi.mock('./hooks', () => ({
  useMyRequests: (canonical: string | null) => useMyRequestsMock(canonical),
}));

vi.mock('./cancelRequest', () => ({
  useCancelRequest: () => useCancelRequestMock(),
}));

import { MyRequestsPage } from './MyRequestsPage';

function principal(overrides: Record<string, unknown> = {}) {
  return {
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    email: 'bob@example.com',
    canonical: 'bob@example.com',
    isPlatformSuperadmin: false,
    managerStakes: [],
    stakeMemberStakes: [],
    bishopricWards: { csnorth: ['CO'] },
    hasAnyRole: () => true,
    wardsInStake: () => ['CO'],
    ...overrides,
  };
}

function mockRequests(rows: AccessRequest[] | undefined, isLoading = false) {
  useMyRequestsMock.mockReturnValue({
    data: rows,
    error: null,
    status: isLoading ? 'pending' : 'success',
    isPending: isLoading,
    isLoading,
    isSuccess: !isLoading,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  });
}

function mockCancel(opts: { isPending?: boolean; mutateAsync?: () => Promise<void> } = {}) {
  useCancelRequestMock.mockReturnValue({
    isPending: opts.isPending ?? false,
    mutateAsync: opts.mutateAsync ?? vi.fn().mockResolvedValue(undefined),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCancel();
});

describe('<MyRequestsPage />', () => {
  it('renders the empty state when the user has no requests', () => {
    usePrincipalMock.mockReturnValue(principal());
    mockRequests([]);
    render(<MyRequestsPage />);
    expect(screen.getByText(/no requests yet/i)).toBeInTheDocument();
  });

  it('renders one card per request with the type + status badges', () => {
    usePrincipalMock.mockReturnValue(principal());
    mockRequests([
      makeRequest({ request_id: 'r1', status: 'pending', type: 'add_manual' }),
      makeRequest({ request_id: 'r2', status: 'complete', type: 'add_temp' }),
    ]);
    render(<MyRequestsPage />);
    expect(screen.getByTestId('myrequest-r1')).toBeInTheDocument();
    expect(screen.getByTestId('myrequest-r2')).toBeInTheDocument();
    expect(screen.getByTestId('myrequest-r1')).toHaveAttribute('data-status', 'pending');
    expect(screen.getByTestId('myrequest-r2')).toHaveAttribute('data-status', 'complete');
  });

  it('shows the Cancel button only on pending rows', () => {
    usePrincipalMock.mockReturnValue(principal());
    mockRequests([
      makeRequest({ request_id: 'r-pending', status: 'pending' }),
      makeRequest({ request_id: 'r-complete', status: 'complete' }),
    ]);
    render(<MyRequestsPage />);
    const pending = screen.getByTestId('myrequest-r-pending');
    const complete = screen.getByTestId('myrequest-r-complete');
    expect(within(pending).getByRole('button', { name: /^Cancel$/ })).toBeInTheDocument();
    expect(within(complete).queryByRole('button', { name: /^Cancel$/ })).toBeNull();
  });

  it('places the Cancel button on the pill row in pill-height styling', () => {
    usePrincipalMock.mockReturnValue(principal());
    mockRequests([makeRequest({ request_id: 'r-pending', status: 'pending' })]);
    render(<MyRequestsPage />);
    const card = screen.getByTestId('myrequest-r-pending');
    const line1 = card.querySelector('.kd-myrequests-card-line1');
    expect(line1).not.toBeNull();
    const cancelBtn = screen.getByTestId('myrequest-cancel-r-pending');
    expect(line1?.contains(cancelBtn)).toBe(true);
    expect(cancelBtn).toHaveClass('btn-pill');
  });

  it('renders the rejection reason inline on rejected rows', () => {
    usePrincipalMock.mockReturnValue(principal());
    mockRequests([
      makeRequest({
        request_id: 'r-rej',
        status: 'rejected',
        rejection_reason: 'Already has stake access',
      }),
    ]);
    render(<MyRequestsPage />);
    const reason = screen.getByTestId('rejection-reason');
    expect(reason).toHaveTextContent(/Already has stake access/i);
    expect(reason).toHaveTextContent(/Rejection reason/i);
  });

  it('surfaces the completion_note inline on a completed remove request', () => {
    usePrincipalMock.mockReturnValue(principal());
    mockRequests([
      makeRequest({
        request_id: 'r-rmv',
        type: 'remove',
        status: 'complete',
        completion_note: 'Seat already removed at completion time (no-op).',
      }),
    ]);
    render(<MyRequestsPage />);
    expect(screen.getByText(/seat already removed at completion time/i)).toBeInTheDocument();
  });

  it('renders no scope filter when the principal has only one requestable scope', () => {
    usePrincipalMock.mockReturnValue(
      principal({ stakeMemberStakes: [], bishopricWards: { csnorth: ['CO'] } }),
    );
    mockRequests([]);
    render(<MyRequestsPage />);
    expect(screen.queryByLabelText(/^Scope:/)).toBeNull();
    expect(screen.getByText(/Scope: Ward CO/)).toBeInTheDocument();
  });

  it('renders a scope filter when the principal has multiple requestable scopes', () => {
    usePrincipalMock.mockReturnValue(
      principal({ stakeMemberStakes: ['csnorth'], bishopricWards: { csnorth: ['CO'] } }),
    );
    mockRequests([]);
    render(<MyRequestsPage />);
    expect(screen.getByLabelText(/^Scope:/)).toBeInTheDocument();
  });

  it('filters cards by the selected scope', async () => {
    const user = userEvent.setup();
    usePrincipalMock.mockReturnValue(
      principal({ stakeMemberStakes: ['csnorth'], bishopricWards: { csnorth: ['CO'] } }),
    );
    mockRequests([
      makeRequest({ request_id: 'r-stake', scope: 'stake' }),
      makeRequest({ request_id: 'r-co', scope: 'CO' }),
    ]);
    render(<MyRequestsPage />);
    await user.selectOptions(screen.getByLabelText(/^Scope:/), 'stake');
    expect(screen.getByTestId('myrequest-r-stake')).toBeInTheDocument();
    expect(screen.queryByTestId('myrequest-r-co')).toBeNull();
  });

  it('confirms before cancelling and dispatches the mutation', async () => {
    const user = userEvent.setup();
    const mutate = vi.fn().mockResolvedValue(undefined);
    mockCancel({ mutateAsync: mutate });
    usePrincipalMock.mockReturnValue(principal());
    mockRequests([makeRequest({ request_id: 'r-pending', status: 'pending' })]);
    render(<MyRequestsPage />);
    await user.click(screen.getByRole('button', { name: /^Cancel$/ }));
    // The dialog opens.
    const confirmBtn = await screen.findByRole('button', { name: /Cancel request/ });
    expect(confirmBtn).toBeInTheDocument();
    await user.click(confirmBtn);
    expect(mutate).toHaveBeenCalledWith({ requestId: 'r-pending' });
  });

  it('displays an inline error if the cancel mutation rejects', async () => {
    const user = userEvent.setup();
    const mutate = vi.fn().mockRejectedValue(new Error('PERMISSION_DENIED'));
    mockCancel({ mutateAsync: mutate });
    usePrincipalMock.mockReturnValue(principal());
    mockRequests([makeRequest({ request_id: 'r-pending', status: 'pending' })]);
    render(<MyRequestsPage />);
    await user.click(screen.getByRole('button', { name: /^Cancel$/ }));
    const confirmBtn = await screen.findByRole('button', { name: /Cancel request/ });
    await user.click(confirmBtn);
    expect(await screen.findByTestId('cancel-error')).toHaveTextContent(/PERMISSION_DENIED/);
  });
});
