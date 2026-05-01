// Component tests for the Manager Queue page. Mocks every hook so the
// test exercises just the rendering shape + the per-row dialog gating.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccessRequest, Building } from '@kindoo/shared';
import { makeRequest } from '../../../../test/fixtures';

const usePendingMock = vi.fn();
const useBuildingsMock = vi.fn();
const completeAddMutate = vi.fn().mockResolvedValue(undefined);
const completeRemoveMutate = vi.fn().mockResolvedValue(undefined);
const rejectMutate = vi.fn().mockResolvedValue(undefined);
const useSeatForMemberMock = vi.fn();

vi.mock('./hooks', () => ({
  usePendingRequests: () => usePendingMock(),
  useCompleteAddRequest: () => ({ mutateAsync: completeAddMutate, isPending: false }),
  useCompleteRemoveRequest: () => ({ mutateAsync: completeRemoveMutate, isPending: false }),
  useRejectRequest: () => ({ mutateAsync: rejectMutate, isPending: false }),
}));

vi.mock('../allSeats/hooks', () => ({
  useBuildings: () => useBuildingsMock(),
}));

vi.mock('../../requests/hooks', () => ({
  useSeatForMember: (canonical: string | null) => useSeatForMemberMock(canonical),
  usePendingRemoveRequests: () => ({
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
  useSubmitRequest: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { ManagerQueuePage } from './QueuePage';

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

function liveDocResult<T>(data: T | undefined) {
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

function buildings(): Building[] {
  return [
    {
      building_id: 'cordera',
      building_name: 'Cordera Building',
      address: '',
      created_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
      last_modified_at: {
        seconds: 0,
        nanoseconds: 0,
        toDate: () => new Date(),
        toMillis: () => 0,
      },
      lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
    },
    {
      building_id: 'genoa',
      building_name: 'Genoa Building',
      address: '',
      created_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
      last_modified_at: {
        seconds: 0,
        nanoseconds: 0,
        toDate: () => new Date(),
        toMillis: () => 0,
      },
      lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  useBuildingsMock.mockReturnValue(liveResult(buildings()));
  useSeatForMemberMock.mockReturnValue(liveDocResult(undefined));
});

describe('<ManagerQueuePage />', () => {
  it('renders the empty-state copy when there are no pending requests', () => {
    usePendingMock.mockReturnValue(liveResult([] as AccessRequest[]));
    render(<ManagerQueuePage />);
    expect(screen.getByText(/no pending requests/i)).toBeInTheDocument();
  });

  it('wraps the page in the medium-width container (800px max)', () => {
    usePendingMock.mockReturnValue(liveResult([] as AccessRequest[]));
    const { container } = render(<ManagerQueuePage />);
    expect(container.querySelector('section.kd-page-medium')).not.toBeNull();
  });

  it('renders one card per pending request with action buttons', () => {
    const requests = [
      makeRequest({ request_id: 'r1', type: 'add_manual', scope: 'CO', member_email: 'a@x.com' }),
      makeRequest({
        request_id: 'r2',
        type: 'add_temp',
        scope: 'stake',
        member_email: 'b@x.com',
        member_canonical: 'b@x.com',
        start_date: '2026-05-01',
        end_date: '2026-05-08',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    expect(screen.getByTestId('queue-card-r1')).toBeInTheDocument();
    expect(screen.getByTestId('queue-card-r2')).toBeInTheDocument();
    expect(screen.getByTestId('queue-complete-r1')).toBeInTheDocument();
    expect(screen.getByTestId('queue-reject-r1')).toBeInTheDocument();
  });

  it('disables Confirm in the complete dialog when no buildings are ticked', async () => {
    const user = userEvent.setup();
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'stake',
        member_email: 'a@x.com',
        building_names: [],
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    await user.click(screen.getByTestId('queue-complete-r1'));
    const confirmBtn = await screen.findByTestId('complete-add-confirm');
    expect(confirmBtn).toBeDisabled();
  });

  it('enables Confirm in the complete dialog once a building is ticked', async () => {
    const user = userEvent.setup();
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'stake',
        member_email: 'a@x.com',
        building_names: [],
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    await user.click(screen.getByTestId('queue-complete-r1'));
    const confirmBtn = await screen.findByTestId('complete-add-confirm');
    expect(confirmBtn).toBeDisabled();
    await user.click(screen.getByTestId('complete-building-cordera'));
    expect(confirmBtn).toBeEnabled();
  });

  it('blocks reject submit when the reason is empty', async () => {
    const user = userEvent.setup();
    const requests = [
      makeRequest({ request_id: 'r1', type: 'add_manual', scope: 'CO', member_email: 'a@x.com' }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    await user.click(screen.getByTestId('queue-reject-r1'));
    const form = await screen.findByTestId('reject-dialog-form');
    await user.click(within(form).getByTestId('reject-confirm'));
    expect(rejectMutate).not.toHaveBeenCalled();
    expect(within(form).getByText(/rejection reason is required/i)).toBeInTheDocument();
  });

  it('surfaces a duplicate-warning chip on add cards when the member already has a seat', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'stake',
        member_email: 'a@x.com',
        member_canonical: 'a@x.com',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    useSeatForMemberMock.mockReturnValue(
      liveDocResult({
        member_canonical: 'a@x.com',
        member_email: 'a@x.com',
        member_name: 'A',
        scope: 'GE',
        type: 'auto',
        callings: ['Bishop'],
        building_names: [],
        duplicate_grants: [],
        created_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
        last_modified_at: {
          seconds: 0,
          nanoseconds: 0,
          toDate: () => new Date(),
          toMillis: () => 0,
        },
        last_modified_by: { email: 'a@b.c', canonical: 'a@b.c' },
        lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
      }),
    );
    render(<ManagerQueuePage />);
    expect(screen.getByTestId('queue-duplicate-r1')).toBeInTheDocument();
  });
});
