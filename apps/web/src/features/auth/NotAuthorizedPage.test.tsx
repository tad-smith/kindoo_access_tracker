// Component tests for NotAuthorizedPage. The Firebase sign-out call is
// mocked at the module boundary so we exercise UI contract only.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const signOutMock = vi.fn();

vi.mock('./signOut', () => ({
  signOut: () => signOutMock(),
}));

import { NotAuthorizedPage } from './NotAuthorizedPage';

beforeEach(() => {
  signOutMock.mockReset();
});

describe('NotAuthorizedPage', () => {
  it('renders the explanation text', () => {
    render(<NotAuthorizedPage />);
    expect(screen.getByRole('heading', { name: /Not authorized/i })).toBeInTheDocument();
    expect(screen.getByText(/newly-called bishopric member/i)).toBeInTheDocument();
    expect(screen.getByText(/isn[’']t matched to any stake or ward role/i)).toBeInTheDocument();
  });

  it('renders a sign-out button that calls signOut', async () => {
    signOutMock.mockResolvedValueOnce(undefined);
    render(<NotAuthorizedPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Sign out/i }));
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });
});
