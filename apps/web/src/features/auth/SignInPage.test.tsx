// Component tests for SignInPage. The magic-link helper is mocked at
// the module boundary (`./signIn`) so we exercise the UI contract:
//   - The hero renders the email input + "Send me a sign-in link"
//     primary CTA (no Google button, no password field anywhere).
//   - The topbar carries a secondary "Sign in" button (focuses the form).
//   - The new-user explanatory sentence renders verbatim from spec §4.1.
//   - Submitting a valid email calls `sendMagicLink`; the hero swaps
//     to the "Check your email" confirmation state.
//   - Empty / malformed emails are rejected client-side without
//     calling `sendMagicLink`.
//   - A rejection from `sendMagicLink` surfaces in an accessible alert.
//   - Footer links to Privacy and a contact target; Chrome extension
//     link stays hidden while the Web Store URL is a placeholder.
//
// The Tailwind v4 preflight regression (PR #12) is still covered: the
// submit button must carry the `.btn` chrome from `base.css`. The
// deeper visual check lives in
// `e2e/tests/auth/sign-in-button-renders.spec.ts`.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const sendMagicLinkMock = vi.fn();
const clearStashedEmailMock = vi.fn();

vi.mock('./signIn', () => ({
  sendMagicLink: (email: string) => sendMagicLinkMock(email),
  clearStashedEmail: () => clearStashedEmailMock(),
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
  sendMagicLinkMock.mockReset();
  clearStashedEmailMock.mockReset();
  window.localStorage.clear();
});

describe('SignInPage — email magic link', () => {
  it('renders no Google button and no password field', () => {
    render(<SignInPage />);
    expect(screen.queryByRole('button', { name: /Google/i })).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('renders the email input and the "Send me a sign-in link" CTA', () => {
    render(<SignInPage />);
    expect(screen.getByLabelText(/Email address/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send me a sign-in link/i })).toBeInTheDocument();
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

  it('renders the verbatim new-user explanatory sentence from spec §4.1', () => {
    render(<SignInPage />);
    expect(
      screen.getByText(
        /New sign-ins land in pending authorization until a stake manager adds your email\./i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Contact your stake manager if you can.t reach the next screen\./i),
    ).toBeInTheDocument();
  });

  it('renders two feature bullets', () => {
    render(<SignInPage />);
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.length).toBeGreaterThanOrEqual(2);
    expect(headings[0]).toHaveTextContent(/Request access for any member/i);
  });

  // Regression guard: Tailwind v4 preflight strips chrome from bare
  // `<button>`s. The submit button must route through the shadcn
  // `<Button>` primitive (which adds `.btn` from `base.css`).
  it('routes the primary CTA through the styled Button primitive', () => {
    render(<SignInPage />);
    const hero = screen.getByRole('button', { name: /Send me a sign-in link/i });
    const topbar = screen.getByRole('button', { name: /^Sign in$/i });
    expect(hero).toHaveClass('btn');
    expect(topbar).toHaveClass('btn');
  });

  it('calls sendMagicLink with the typed email on submit', async () => {
    sendMagicLinkMock.mockResolvedValueOnce(undefined);
    render(<SignInPage />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/Email address/i), 'zach@example.com');
    await user.click(screen.getByRole('button', { name: /Send me a sign-in link/i }));

    expect(sendMagicLinkMock).toHaveBeenCalledTimes(1);
    expect(sendMagicLinkMock).toHaveBeenCalledWith('zach@example.com');
  });

  it('trims surrounding whitespace before submitting', async () => {
    sendMagicLinkMock.mockResolvedValueOnce(undefined);
    render(<SignInPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Email address/i), '  zach@example.com  ');
    await user.click(screen.getByRole('button', { name: /Send me a sign-in link/i }));
    expect(sendMagicLinkMock).toHaveBeenCalledWith('zach@example.com');
  });

  it('shows an inline error and does not submit when the email is empty', async () => {
    render(<SignInPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Send me a sign-in link/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Enter your email/i);
    expect(sendMagicLinkMock).not.toHaveBeenCalled();
  });

  it('shows an inline error and does not submit when the email is malformed', async () => {
    render(<SignInPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Email address/i), 'not-an-email');
    await user.click(screen.getByRole('button', { name: /Send me a sign-in link/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/valid email/i);
    expect(sendMagicLinkMock).not.toHaveBeenCalled();
  });

  it('swaps to the "Check your email" confirmation state on success', async () => {
    sendMagicLinkMock.mockResolvedValueOnce(undefined);
    render(<SignInPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Email address/i), 'zach@example.com');
    await user.click(screen.getByRole('button', { name: /Send me a sign-in link/i }));

    expect(await screen.findByText(/Check your email/i)).toBeInTheDocument();
    // The confirmation surfaces the email so the user can verify it.
    const confirmation = screen.getByTestId('signin-confirmation');
    expect(confirmation).toHaveTextContent('zach@example.com');
    // Form is gone; submit button no longer rendered.
    expect(screen.queryByRole('button', { name: /Send me a sign-in link/i })).toBeNull();
  });

  it('returns to the form when the user clicks "Use a different email"', async () => {
    sendMagicLinkMock.mockResolvedValueOnce(undefined);
    render(<SignInPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Email address/i), 'zach@example.com');
    await user.click(screen.getByRole('button', { name: /Send me a sign-in link/i }));

    await screen.findByText(/Check your email/i);
    await user.click(screen.getByRole('button', { name: /Use a different email/i }));

    expect(screen.getByLabelText(/Email address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Email address/i)).toHaveValue('');
    expect(screen.getByRole('button', { name: /Send me a sign-in link/i })).toBeInTheDocument();
  });

  // Regression — see PR #140 reviewer Fix 2. The previous stashed
  // email must be cleared when the user resets to a different email,
  // so any prior link already in their inbox routes through the
  // action handler's cross-device prompt rather than completing
  // against the new email (which would reject with `auth/invalid-email`).
  it('clears the stashed email when the user clicks "Use a different email"', async () => {
    sendMagicLinkMock.mockResolvedValueOnce(undefined);
    render(<SignInPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Email address/i), 'first@example.com');
    await user.click(screen.getByRole('button', { name: /Send me a sign-in link/i }));
    await screen.findByText(/Check your email/i);

    expect(clearStashedEmailMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Use a different email/i }));
    expect(clearStashedEmailMock).toHaveBeenCalledTimes(1);
  });

  // Regression — see PR #140 reviewer Fix 3. The topbar "Sign in"
  // button becomes a dead click once the hero swaps to the
  // confirmation state (the form is unmounted, so focusing it is a
  // null-ref no-op). Hide it instead.
  it('hides the topbar "Sign in" button once the hero shows the confirmation state', async () => {
    sendMagicLinkMock.mockResolvedValueOnce(undefined);
    render(<SignInPage />);
    const user = userEvent.setup();

    // Topbar present before submit.
    expect(screen.getByRole('button', { name: /^Sign in$/i })).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Email address/i), 'zach@example.com');
    await user.click(screen.getByRole('button', { name: /Send me a sign-in link/i }));
    await screen.findByText(/Check your email/i);

    expect(screen.queryByRole('button', { name: /^Sign in$/i })).toBeNull();
  });

  it('re-renders the topbar "Sign in" button after "Use a different email"', async () => {
    sendMagicLinkMock.mockResolvedValueOnce(undefined);
    render(<SignInPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Email address/i), 'zach@example.com');
    await user.click(screen.getByRole('button', { name: /Send me a sign-in link/i }));
    await screen.findByText(/Check your email/i);
    expect(screen.queryByRole('button', { name: /^Sign in$/i })).toBeNull();

    await user.click(screen.getByRole('button', { name: /Use a different email/i }));
    expect(screen.getByRole('button', { name: /^Sign in$/i })).toBeInTheDocument();
  });

  it('disables the submit button while the request is in flight', async () => {
    let resolveSend: (() => void) | null = null;
    sendMagicLinkMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    render(<SignInPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Email address/i), 'zach@example.com');
    await user.click(screen.getByRole('button', { name: /Send me a sign-in link/i }));

    const pending = screen.getByRole('button', { name: /Sending…/i });
    expect(pending).toBeDisabled();
    resolveSend!();
  });

  it('surfaces sendMagicLink failures in an accessible alert region', async () => {
    sendMagicLinkMock.mockRejectedValueOnce(new Error('auth/unauthorized-continue-uri'));
    render(<SignInPage />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Email address/i), 'zach@example.com');
    await user.click(screen.getByRole('button', { name: /Send me a sign-in link/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/unauthorized-continue-uri/i);
    // The form remains on screen so the user can correct + retry.
    expect(screen.getByRole('button', { name: /Send me a sign-in link/i })).toBeInTheDocument();
  });

  it('renders the footer with Privacy and Contact links', () => {
    render(<SignInPage />);
    const privacy = screen.getByRole('link', { name: /Privacy/i });
    expect(privacy).toHaveAttribute('href', '/privacy');

    const contact = screen.getByRole('link', { name: /Contact/i });
    expect(contact.getAttribute('href')).toMatch(/^mailto:/);
  });

  it('hides the Chrome extension link while the Web Store URL is the placeholder', () => {
    render(<SignInPage />);
    expect(screen.queryByRole('link', { name: /Chrome extension/i })).toBeNull();
  });
});
