// Component tests for SetupInProgressPage. Covers:
//   - admin email rendered when stake doc has it.
//   - Generic copy when bootstrap_admin_email isn't loaded yet.
//   - Distinct from NotAuthorized (different heading, no sign-out button).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Stake } from '@kindoo/shared';

const useFirestoreDocMock = vi.fn();
const usePrincipalMock = vi.fn();

vi.mock('../../lib/data', () => ({
  useFirestoreDoc: (...args: unknown[]) => useFirestoreDocMock(...args),
}));
vi.mock('../../lib/principal', () => ({
  usePrincipal: () => usePrincipalMock(),
}));
vi.mock('../../lib/firebase', () => ({ db: {} }));
vi.mock('../../lib/docs', () => ({ stakeRef: () => ({}) }));

import { SetupInProgressPage } from './SetupInProgressPage';

function makeStake(over: Partial<Stake> = {}): Partial<Stake> {
  return {
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePrincipalMock.mockReturnValue({ email: 'someone@example.com' });
});

describe('<SetupInProgressPage />', () => {
  it('renders the Setup in progress heading (distinct from NotAuthorized)', () => {
    useFirestoreDocMock.mockReturnValue({ data: makeStake() });
    render(<SetupInProgressPage />);
    expect(screen.getByRole('heading', { name: /setup in progress/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
  });

  it('shows the admin email when present', () => {
    useFirestoreDocMock.mockReturnValue({ data: makeStake({ bootstrap_admin_email: 'a@b.com' }) });
    render(<SetupInProgressPage />);
    expect(screen.getByText(/a@b.com/)).toBeInTheDocument();
  });

  it('falls back to a generic message when admin email is loading', () => {
    useFirestoreDocMock.mockReturnValue({ data: undefined });
    render(<SetupInProgressPage />);
    expect(screen.getByText(/contact your administrator/i)).toBeInTheDocument();
  });

  it('shows the signed-in email so the user can confirm which account', () => {
    usePrincipalMock.mockReturnValue({ email: 'me@bishop.org' });
    useFirestoreDocMock.mockReturnValue({ data: makeStake() });
    render(<SetupInProgressPage />);
    expect(screen.getByText(/me@bishop.org/)).toBeInTheDocument();
  });
});
