// Component tests for SignInPage. The Firebase popup flow is mocked at
// the module boundary (`./signIn`) so we exercise the UI contract:
//   - "Sign in with Google" button renders.
//   - Clicking calls `signIn()`.
//   - A rejection from `signIn()` surfaces in an accessible alert region.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const signInMock = vi.fn();

vi.mock('./signIn', () => ({
  signIn: () => signInMock(),
}));

import { SignInPage } from './SignInPage';

beforeEach(() => {
  signInMock.mockReset();
});

describe('SignInPage', () => {
  it('renders a Sign in with Google button', () => {
    render(<SignInPage />);
    expect(screen.getByRole('button', { name: /Sign in with Google/i })).toBeInTheDocument();
  });

  it('calls signIn when the button is clicked', async () => {
    signInMock.mockResolvedValueOnce({ uid: 'u1' });
    render(<SignInPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Sign in with Google/i }));
    expect(signInMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces sign-in failures in an alert region', async () => {
    signInMock.mockRejectedValueOnce(new Error('popup blocked'));
    render(<SignInPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Sign in with Google/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/popup blocked/i);
  });
});
