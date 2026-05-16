// Component tests for SignInPage. The Firebase popup flow is mocked at
// the module boundary (`./signIn`) so we exercise the UI contract:
//   - The hero "Sign in with Google" button renders (and is the primary CTA).
//   - Clicking calls `signIn()`.
//   - A rejection from `signIn()` surfaces in an accessible alert region.
//   - Footer links to Privacy, the Chrome extension, and a contact target.
//
// The Tailwind v4 preflight regression (PR #12) is still covered: the
// primary hero button must carry the `.btn` chrome from `base.css`.
// Deeper visual check lives in
// `e2e/tests/auth/sign-in-button-renders.spec.ts`.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const signInMock = vi.fn();

vi.mock('./signIn', () => ({
  signIn: () => signInMock(),
}));

// `<Link>` from TanStack Router needs a router context. The homepage
// only uses it for the Privacy footer link; stub to a plain anchor so
// the test does not have to spin up a full router.
vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    Link: ({
      to,
      children,
      className,
    }: {
      to: string;
      children: React.ReactNode;
      className?: string;
    }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
  };
});

import { SignInPage } from './SignInPage';

beforeEach(() => {
  signInMock.mockReset();
});

describe('SignInPage', () => {
  // Distinct accessible names — Playwright's `getByRole` is strict, so
  // two buttons with the same name would break the existing E2E. The
  // hero CTA keeps the canonical "Sign in with Google" label; the
  // topbar CTA uses the shorter "Sign in".
  it('renders exactly one "Sign in with Google" button (the hero CTA)', () => {
    render(<SignInPage />);
    const heroButtons = screen.getAllByRole('button', { name: /Sign in with Google/i });
    expect(heroButtons).toHaveLength(1);
  });

  it('renders a separate "Sign in" topbar button', () => {
    render(<SignInPage />);
    const topbar = screen.getByRole('button', { name: /^Sign in$/i });
    expect(topbar).toBeInTheDocument();
    expect(topbar).toHaveClass('btn-secondary');
  });

  it('renders the homepage headline', () => {
    render(<SignInPage />);
    expect(
      screen.getByRole('heading', { level: 1, name: /Building access for your stake/i }),
    ).toBeInTheDocument();
  });

  it('renders three feature bullets', () => {
    render(<SignInPage />);
    // Each bullet is a level-2 heading inside the features list.
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.length).toBe(3);
    expect(headings[0]).toHaveTextContent(/Request access for any member/i);
  });

  // Regression guard: Tailwind v4 preflight strips chrome from bare
  // `<button>`s. Both buttons must route through the shadcn `<Button>`
  // primitive (which adds `.btn` from `base.css`).
  it('routes both Sign in buttons through the styled Button primitive', () => {
    render(<SignInPage />);
    const hero = screen.getByRole('button', { name: /Sign in with Google/i });
    const topbar = screen.getByRole('button', { name: /^Sign in$/i });
    expect(hero).toHaveClass('btn');
    expect(topbar).toHaveClass('btn');
  });

  it('calls signIn when the hero button is clicked', async () => {
    signInMock.mockResolvedValueOnce({ uid: 'u1' });
    render(<SignInPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Sign in with Google/i }));
    expect(signInMock).toHaveBeenCalledTimes(1);
  });

  it('calls signIn when the topbar button is clicked', async () => {
    signInMock.mockResolvedValueOnce({ uid: 'u1' });
    render(<SignInPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Sign in$/i }));
    expect(signInMock).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while sign-in is pending', async () => {
    let resolveSignIn: ((value: { uid: string }) => void) | null = null;
    signInMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSignIn = resolve;
        }),
    );
    render(<SignInPage />);
    const user = userEvent.setup();
    const hero = screen.getByRole('button', { name: /Sign in with Google/i });
    await user.click(hero);
    // Both the hero and the topbar swap to "Signing in…" while the
    // promise is in flight; both must be disabled. Use getAllByRole
    // because both buttons now share the same accessible name.
    const pendingButtons = screen.getAllByRole('button', { name: /Signing in…/i });
    expect(pendingButtons).toHaveLength(2);
    for (const button of pendingButtons) {
      expect(button).toBeDisabled();
    }
    resolveSignIn!({ uid: 'u1' });
  });

  it('surfaces sign-in failures in an alert region', async () => {
    signInMock.mockRejectedValueOnce(new Error('popup blocked'));
    render(<SignInPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Sign in with Google/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/popup blocked/i);
  });

  it('renders the footer with Privacy, Chrome extension, and Contact links', () => {
    render(<SignInPage />);
    const privacy = screen.getByRole('link', { name: /Privacy/i });
    expect(privacy).toHaveAttribute('href', '/privacy');

    const ext = screen.getByRole('link', { name: /Chrome extension/i });
    expect(ext.getAttribute('href')).toMatch(/^https?:\/\//);

    const contact = screen.getByRole('link', { name: /Contact/i });
    expect(contact.getAttribute('href')).toMatch(/^mailto:/);
  });
});
