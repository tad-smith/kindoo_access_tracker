// Component tests for the Manager Queue page. Mocks every hook so the
// test exercises just the rendering shape + the per-row dialog gating.

import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccessRequest, Building } from '@kindoo/shared';
import { makeRequest } from '../../../../test/fixtures';

const usePendingMock = vi.fn();
const useBuildingsMock = vi.fn();
const completeAddMutate = vi.fn().mockResolvedValue(undefined);
const completeRemoveMutate = vi.fn().mockResolvedValue(undefined);
const rejectMutate = vi.fn().mockResolvedValue(undefined);
const useSeatForMemberMock = vi.fn();
const navigateMock = vi.fn().mockResolvedValue(undefined);

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

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
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
  // jsdom does not implement scrollIntoView; stub on the prototype so
  // the focus-card effect does not throw. Using `Object.defineProperty`
  // sidesteps the readonly-element-prototype TS check; restoreAllMocks
  // in afterEach takes care of cleanup.
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<ManagerQueuePage />', () => {
  it('renders the page title as "Request Queue"', () => {
    usePendingMock.mockReturnValue(liveResult([] as AccessRequest[]));
    render(<ManagerQueuePage />);
    expect(screen.getByRole('heading', { name: /^Request Queue$/ })).toBeInTheDocument();
  });

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

  it('shows buildings on a dedicated card row as a comma-delimited list', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'stake',
        member_email: 'a@x.com',
        building_names: ['CO Building', 'BR Building'],
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const row = screen.getByTestId('queue-buildings-r1');
    expect(row).toHaveTextContent(/^Buildings:\s*CO Building, BR Building$/);
  });

  it('omits the buildings row when building_names is empty', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'CO',
        member_email: 'a@x.com',
        building_names: [],
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    expect(screen.queryByTestId('queue-buildings-r1')).toBeNull();
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

  it('renders an optional completion-note textarea on the add-complete dialog', async () => {
    const user = userEvent.setup();
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'stake',
        member_email: 'a@x.com',
        building_names: ['Cordera Building'],
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    await user.click(screen.getByTestId('queue-complete-r1'));
    const note = await screen.findByTestId('complete-add-note');
    expect(note.tagName).toBe('TEXTAREA');
    expect(note).toHaveAttribute(
      'placeholder',
      'What did you do? (Optional context for the requester.)',
    );
    // Labeled "Completion note" — the surrounding <label> wraps the textarea
    // so RTL's getByLabelText sees the same element by accessible name.
    expect(screen.getByLabelText(/completion note/i)).toBe(note);
  });

  it('passes the trimmed completion_note through to the add-complete mutation', async () => {
    const user = userEvent.setup();
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'stake',
        member_email: 'a@x.com',
        building_names: ['Cordera Building'],
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    await user.click(screen.getByTestId('queue-complete-r1'));
    const note = await screen.findByTestId('complete-add-note');
    await user.type(note, '  Granted; door system syncs overnight.  ');
    await user.click(screen.getByTestId('complete-add-confirm'));
    await waitFor(() => {
      expect(completeAddMutate).toHaveBeenCalled();
    });
    const arg = completeAddMutate.mock.calls[0]?.[0] as {
      completion_note: string;
      building_names: string[];
    };
    // react-hook-form ships the raw value; the hook trims server-side
    // before deciding whether to write the field.
    expect(arg.completion_note).toBe('  Granted; door system syncs overnight.  ');
    expect(arg.building_names).toEqual(['Cordera Building']);
  });

  it('passes empty completion_note on the add-complete mutation when the textarea is blank', async () => {
    const user = userEvent.setup();
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'stake',
        member_email: 'a@x.com',
        building_names: ['Cordera Building'],
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    await user.click(screen.getByTestId('queue-complete-r1'));
    await user.click(screen.getByTestId('complete-add-confirm'));
    await waitFor(() => {
      expect(completeAddMutate).toHaveBeenCalled();
    });
    const arg = completeAddMutate.mock.calls[0]?.[0] as { completion_note: string };
    expect(arg.completion_note).toBe('');
  });

  it('renders an optional completion-note textarea on the remove-complete dialog', async () => {
    const user = userEvent.setup();
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'remove',
        scope: 'CO',
        member_email: 'a@x.com',
        member_canonical: 'a@x.com',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    await user.click(screen.getByTestId('queue-complete-r1'));
    const note = await screen.findByTestId('complete-remove-note');
    expect(note.tagName).toBe('TEXTAREA');
    expect(note).toHaveAttribute(
      'placeholder',
      'What did you do? (Optional context for the requester.)',
    );
    expect(screen.getByLabelText(/completion note/i)).toBe(note);
  });

  it('passes the textarea value through to the remove-complete mutation', async () => {
    const user = userEvent.setup();
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'remove',
        scope: 'CO',
        member_email: 'a@x.com',
        member_canonical: 'a@x.com',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    await user.click(screen.getByTestId('queue-complete-r1'));
    const note = await screen.findByTestId('complete-remove-note');
    await user.type(note, 'Removed; awaiting overnight sync.');
    await user.click(screen.getByTestId('complete-remove-confirm'));
    await waitFor(() => {
      expect(completeRemoveMutate).toHaveBeenCalled();
    });
    const arg = completeRemoveMutate.mock.calls[0]?.[0] as { completion_note: string };
    expect(arg.completion_note).toBe('Removed; awaiting overnight sync.');
  });

  it('passes empty completion_note on the remove-complete mutation when the textarea is blank', async () => {
    const user = userEvent.setup();
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'remove',
        scope: 'CO',
        member_email: 'a@x.com',
        member_canonical: 'a@x.com',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    await user.click(screen.getByTestId('queue-complete-r1'));
    await user.click(screen.getByTestId('complete-remove-confirm'));
    await waitFor(() => {
      expect(completeRemoveMutate).toHaveBeenCalled();
    });
    const arg = completeRemoveMutate.mock.calls[0]?.[0] as { completion_note: string };
    expect(arg.completion_note).toBe('');
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

  it('renders only sections that contain at least one request', () => {
    // Two non-urgent add_manual requests with old requested_at land
    // in Outstanding; no urgent or far-future requests are seeded so
    // Urgent and Future should not render.
    const requests = [
      makeRequest({
        request_id: 'r-outstanding',
        type: 'add_manual',
        requested_at: {
          seconds: Math.floor(new Date('2026-04-20').getTime() / 1000),
          nanoseconds: 0,
          toDate: () => new Date('2026-04-20'),
          toMillis: () => new Date('2026-04-20').getTime(),
        },
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    expect(screen.getByTestId('queue-section-outstanding')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-section-urgent')).toBeNull();
    expect(screen.queryByTestId('queue-section-future')).toBeNull();
  });

  it('places urgent requests in the Urgent section with a red top-bar marker', () => {
    const requests = [
      makeRequest({
        request_id: 'r-urgent',
        type: 'add_manual',
        urgent: true,
      }),
      makeRequest({
        request_id: 'r-normal',
        type: 'add_manual',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const urgentSection = screen.getByTestId('queue-section-urgent');
    expect(within(urgentSection).getByTestId('queue-card-r-urgent')).toBeInTheDocument();
    const card = screen.getByTestId('queue-card-r-urgent');
    expect(card).toHaveClass('kd-card-urgent');
    expect(card).toHaveAttribute('data-urgent', 'true');
    // And the non-urgent card is NOT marked.
    const normal = screen.getByTestId('queue-card-r-normal');
    expect(normal).not.toHaveClass('kd-card-urgent');
  });

  it('puts add_temp requests with start_date > today+7 in the Future section', () => {
    const farIso = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    })();
    const requests = [
      makeRequest({
        request_id: 'r-far',
        type: 'add_temp',
        start_date: farIso,
        end_date: farIso,
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const future = screen.getByTestId('queue-section-future');
    expect(within(future).getByTestId('queue-card-r-far')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-section-outstanding')).toBeNull();
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

describe('<ManagerQueuePage /> — ?focus=<rid> deep-link', () => {
  it('applies the is-focused class to the matching card', async () => {
    const requests = [
      makeRequest({ request_id: 'abc123', type: 'add_manual' }),
      makeRequest({ request_id: 'other', type: 'add_manual' }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage focus="abc123" />);
    await waitFor(() => {
      expect(screen.getByTestId('queue-card-abc123')).toHaveClass('is-focused');
    });
    expect(screen.getByTestId('queue-card-other')).not.toHaveClass('is-focused');
  });

  it('scrolls the matching card into view', async () => {
    const scrollIntoViewSpy = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    const requests = [makeRequest({ request_id: 'abc123', type: 'add_manual' })];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage focus="abc123" />);
    await waitFor(() => {
      expect(scrollIntoViewSpy).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'center',
      });
    });
  });

  it('strips the focus param from the URL after the effect runs', async () => {
    const requests = [makeRequest({ request_id: 'abc123', type: 'add_manual' })];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage focus="abc123" />);
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalled();
    });
    const arg = navigateMock.mock.calls[0]?.[0] as {
      to: string;
      replace: boolean;
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(arg.to).toBe('/manager/queue');
    expect(arg.replace).toBe(true);
    // The search reducer should drop `focus` while preserving any
    // sibling params the URL might have carried.
    expect(arg.search({ focus: 'abc123', other: 'x' })).toEqual({
      focus: undefined,
      other: 'x',
    });
  });

  it('still strips the param when no request matches the focus value', async () => {
    const requests = [makeRequest({ request_id: 'r1', type: 'add_manual' })];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage focus="missing" />);
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalled();
    });
    // No card highlights; no error; the rendered card is untouched.
    expect(screen.getByTestId('queue-card-r1')).not.toHaveClass('is-focused');
  });

  it('does not highlight any card when focus is unset', () => {
    const requests = [makeRequest({ request_id: 'r1', type: 'add_manual' })];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    expect(screen.getByTestId('queue-card-r1')).not.toHaveClass('is-focused');
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('removes the is-focused class after the highlight timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      const requests = [makeRequest({ request_id: 'abc123', type: 'add_manual' })];
      usePendingMock.mockReturnValue(liveResult(requests));
      render(<ManagerQueuePage focus="abc123" />);
      // Flush queueMicrotask + the synchronous setFocusedId so the class lands.
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByTestId('queue-card-abc123')).toHaveClass('is-focused');
      // Advance past the highlight window.
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      expect(screen.getByTestId('queue-card-abc123')).not.toHaveClass('is-focused');
    } finally {
      vi.useRealTimers();
    }
  });
});
