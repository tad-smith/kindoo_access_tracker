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

  // Regression guard: Phase 5's Tailwind v4 preflight reset stripped
  // the browser-default chrome from the bare `<button>` that Phase 2
  // shipped, leaving "Sign in with Google" rendered as plain text. The
  // fix routes through the shadcn `<Button>` primitive, which carries
  // the `.btn` class from `base.css` so it's actually styled. Asserting
  // on `.btn` is the cheapest unit-level check that the styled button
  // family is in play; the deeper "is it visually a button" check lives
  // in the Playwright spec at
  // `e2e/tests/auth/sign-in-button-renders.spec.ts` because RTL's jsdom
  // doesn't apply CSS.
  it('renders the sign-in button with the .btn class so it is actually styled', () => {
    render(<SignInPage />);
    const button = screen.getByRole('button', { name: /Sign in with Google/i });
    expect(button).toHaveClass('btn');
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
