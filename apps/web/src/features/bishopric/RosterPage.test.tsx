// Component tests for the Bishopric Roster page. Mocks the data hooks
// + `usePrincipal` so the test exercises just the rendering shape:
//   - empty state copy when no seats are returned
//   - seat cards rendered for the active ward
//   - utilization bar reflects the count and the ward's seat_cap
//   - ward dropdown appears iff the principal has 2+ wards
//
// We don't go through TanStack Router here — the page accepts an
// `initialWard` prop that the route file forwards from the URL. That
// keeps the unit test boundary aligned with the component's contract.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Seat, Ward } from '@kindoo/shared';
import { makeSeat, makeWard } from '../../../test/fixtures';

const usePrincipalMock = vi.fn();
const useBishopricRosterMock = vi.fn();
const useFirestoreOnceMock = vi.fn();
// Real navigate returns a Promise; the page calls `.catch(...)` on it.
const navigateMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../lib/principal', () => ({
  usePrincipal: () => usePrincipalMock(),
}));

vi.mock('./hooks', () => ({
  useBishopricRoster: (ward: string | null) => useBishopricRosterMock(ward),
}));

vi.mock('../../lib/data', () => ({
  useFirestoreOnce: (ref: unknown) => useFirestoreOnceMock(ref),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

// RemovalAffordance subscribes via the requests hooks; mock so we
// don't need a real QueryClient / Firestore listener.
vi.mock('../requests/hooks', () => ({
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

import { BishopricRosterPage } from './RosterPage';

function principal(wards: string[]) {
  return {
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    email: 'bishop@example.com',
    canonical: 'bishop@example.com',
    isPlatformSuperadmin: false,
    managerStakes: [],
    stakeMemberStakes: [],
    bishopricWards: { csnorth: wards },
    hasAnyRole: () => true,
    wardsInStake: () => wards,
  };
}

function mockSeats(seats: Seat[] | undefined, isLoading = false) {
  useBishopricRosterMock.mockReturnValue({
    data: seats,
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

function mockWardDoc(ward: Ward | undefined) {
  useFirestoreOnceMock.mockReturnValue({
    data: ward,
    error: null,
    status: 'success',
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  navigateMock.mockResolvedValue(undefined);
});

describe('<BishopricRosterPage />', () => {
  it('renders the empty-state copy when the ward has no seats', () => {
    usePrincipalMock.mockReturnValue(principal(['CO']));
    mockSeats([]);
    mockWardDoc(makeWard({ ward_code: 'CO', seat_cap: 20 }));
    render(<BishopricRosterPage />);
    expect(screen.getByText(/no seats assigned to this ward/i)).toBeInTheDocument();
  });

  it('renders a seat card per row in the order returned', () => {
    usePrincipalMock.mockReturnValue(principal(['CO']));
    mockSeats([
      makeSeat({ member_canonical: 'a@x.com', member_email: 'a@x.com', member_name: 'Alpha' }),
      makeSeat({ member_canonical: 'b@x.com', member_email: 'b@x.com', member_name: 'Bravo' }),
    ]);
    mockWardDoc(makeWard({ seat_cap: 20 }));
    render(<BishopricRosterPage />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Bravo')).toBeInTheDocument();
  });

  it('shows the ward picker only when the principal holds 2+ bishopric wards', () => {
    usePrincipalMock.mockReturnValue(principal(['CO']));
    mockSeats([]);
    mockWardDoc(makeWard({ seat_cap: 20 }));
    const { rerender } = render(<BishopricRosterPage />);
    expect(screen.queryByLabelText(/^Ward:/)).toBeNull();

    usePrincipalMock.mockReturnValue(principal(['CO', 'GE']));
    mockSeats([]);
    mockWardDoc(makeWard({ seat_cap: 20 }));
    rerender(<BishopricRosterPage />);
    expect(screen.getByLabelText(/^Ward:/)).toBeInTheDocument();
  });

  it('switches the active ward when the picker changes (multi-ward bishopric)', async () => {
    const user = userEvent.setup();
    usePrincipalMock.mockReturnValue(principal(['CO', 'GE']));
    mockSeats([]);
    mockWardDoc(makeWard({ seat_cap: 20 }));
    render(<BishopricRosterPage initialWard="CO" />);
    const select = screen.getByLabelText(/^Ward:/);
    await user.selectOptions(select, 'GE');
    // The hook is called with the new ward at least once.
    expect(useBishopricRosterMock).toHaveBeenCalledWith('GE');
    expect(navigateMock).toHaveBeenCalled();
  });

  it('renders a utilization bar with seat_cap from the ward doc', () => {
    usePrincipalMock.mockReturnValue(principal(['CO']));
    mockSeats([makeSeat(), makeSeat({ member_canonical: 'b@x.com', member_email: 'b@x.com' })]);
    mockWardDoc(makeWard({ seat_cap: 10 }));
    render(<BishopricRosterPage />);
    expect(screen.getByText(/2 \/ 10 seats used/)).toBeInTheDocument();
  });

  it('renders a "no bishopric wards" message when the principal holds none', () => {
    usePrincipalMock.mockReturnValue(principal([]));
    mockSeats([]);
    mockWardDoc(undefined);
    render(<BishopricRosterPage />);
    expect(screen.getByText(/no bishopric wards/i)).toBeInTheDocument();
  });
});
