// Component tests for the Manager Access page.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Access } from '@kindoo/shared';
import { makeAccess } from '../../../../test/fixtures';

const useAccessListMock = vi.fn();

vi.mock('./hooks', () => ({
  useAccessList: () => useAccessListMock(),
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
});
