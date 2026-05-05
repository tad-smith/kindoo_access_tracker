// Component tests for NotAuthorizedPage. The Firebase sign-out call
// and `usePrincipal` are mocked at module boundaries so we exercise UI
// contract only.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const signOutMock = vi.fn();
const usePrincipalMock = vi.fn();

vi.mock('./signOut', () => ({
  signOut: () => signOutMock(),
}));
vi.mock('../../lib/principal', () => ({
  usePrincipal: () => usePrincipalMock(),
}));

import { NotAuthorizedPage } from './NotAuthorizedPage';

beforeEach(() => {
  signOutMock.mockReset();
  usePrincipalMock.mockReset();
  usePrincipalMock.mockReturnValue({ email: 'someone@example.com' });
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

  // Regression guard: same Tailwind v4 preflight reset that bit
  // SignInPage in PR #12 also stripped this page's bare `<button>`.
  // Routing through the shadcn `<Button>` primitive carries the `.btn`
  // class from `base.css` so the button is actually styled. The deeper
  // visual check lives in `e2e/tests/auth/not-authorized-button-renders.spec.ts`
  // because RTL's jsdom doesn't apply CSS.
  it('renders the sign-out button with the .btn class so it is actually styled', () => {
    render(<NotAuthorizedPage />);
    const button = screen.getByRole('button', { name: /Sign out/i });
    expect(button).toHaveClass('btn');
  });

  // Triage support: a screenshot of this page must show which account
  // the user actually used. Original page omitted it, which forced
  // support to ping the user back asking "which account did you sign
  // in with?". Email comes from `usePrincipal().email` (the typed-form
  // email, populated whenever Firebase Auth has run).
  it('shows the signed-in email so support can triage from a screenshot', () => {
    usePrincipalMock.mockReturnValue({ email: 'alice@gmail.com' });
    render(<NotAuthorizedPage />);
    expect(screen.getByText(/alice@gmail.com/)).toBeInTheDocument();
    expect(screen.getByText(/You are signed in as/i)).toBeInTheDocument();
  });

  // Defensive: if the principal is somehow missing an email (shouldn't
  // happen on this page since the user is authenticated), don't render
  // a half-formed sentence with an empty email.
  it('omits the signed-in-as line when the principal email is missing', () => {
    usePrincipalMock.mockReturnValue({ email: '' });
    render(<NotAuthorizedPage />);
    expect(screen.queryByText(/You are signed in as/i)).toBeNull();
  });

  // Triage UX: each reason renders as its own bullet so a screenshot
  // is scannable, not a wall of prose.
  it('renders the reasons as a single <ul> with one <li> per reason', () => {
    const { container } = render(<NotAuthorizedPage />);
    const list = container.querySelector('ul');
    expect(list).not.toBeNull();
    expect(container.querySelectorAll('ul')).toHaveLength(1);
    const items = list!.querySelectorAll('li');
    expect(items).toHaveLength(2);
  });
});
