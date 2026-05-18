// Tests for /auth/email-link — the action-handler route for the email
// magic link round-trip (spec §4.1, T-44). The signIn helpers are
// mocked at the module boundary so we exercise:
//   - Happy path: localStorage populated → completeSignInWithEmailLink
//     called with the stashed email; navigate('/') fires.
//   - Cross-device branch: localStorage empty → prompt rendered;
//     submitting the form calls completeSignInWithEmailLink with the
//     typed email.
//   - URL is not a sign-in link → friendly "not a valid sign-in link"
//     branch.
//   - completeSignInWithEmailLink rejections (expired / malformed /
//     mismatch / network) → error branch with a "Send a new link" link.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const isSignInWithEmailLinkMock = vi.fn();
const readAndClearStashedEmailMock = vi.fn<() => string | null>();
const peekStashedEmailMock = vi.fn<() => string | null>();
const clearStashedEmailMock = vi.fn();
const completeSignInWithEmailLinkMock = vi.fn();

vi.mock('../../features/auth/signIn', () => ({
  isSignInWithEmailLink: (href: string) => isSignInWithEmailLinkMock(href),
  readAndClearStashedEmail: () => readAndClearStashedEmailMock(),
  peekStashedEmail: () => peekStashedEmailMock(),
  clearStashedEmail: () => clearStashedEmailMock(),
  completeSignInWithEmailLink: (email: string, href: string) =>
    completeSignInWithEmailLinkMock(email, href),
}));

const navigateMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    useNavigate: () => navigateMock,
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

import { Route } from './email-link';

const EmailLinkRoute = Route.options.component as () => React.ReactElement | null;

const ORIGINAL_LOCATION = window.location;

function setHref(href: string) {
  // jsdom forbids reassigning window.location, but lets us swap it via
  // a `configurable: true` defineProperty.
  Object.defineProperty(window, 'location', {
    configurable: true,
    enumerable: true,
    value: new URL(href),
    writable: true,
  });
  // `new URL()` lacks the `assign`/`replace`/`reload` methods Location
  // would carry; they're not exercised here, so the partial replacement
  // is fine.
}

beforeEach(() => {
  isSignInWithEmailLinkMock.mockReset();
  readAndClearStashedEmailMock.mockReset();
  peekStashedEmailMock.mockReset();
  clearStashedEmailMock.mockReset();
  completeSignInWithEmailLinkMock.mockReset();
  navigateMock.mockClear();
  navigateMock.mockResolvedValue(undefined);
  readAndClearStashedEmailMock.mockReturnValue(null);
  peekStashedEmailMock.mockReturnValue(null);
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    enumerable: true,
    value: ORIGINAL_LOCATION,
    writable: true,
  });
});

describe('/auth/email-link', () => {
  it('shows the not-a-link branch when the URL is not a sign-in link', async () => {
    setHref('https://example.com/auth/email-link');
    isSignInWithEmailLinkMock.mockReturnValueOnce(false);

    render(<EmailLinkRoute />);

    expect(await screen.findByText(/not a valid sign-in link/i)).toBeInTheDocument();
    expect(completeSignInWithEmailLinkMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('happy path — stashed email present → calls completeSignInWithEmailLink and navigates to /', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValueOnce(true);
    readAndClearStashedEmailMock.mockReturnValueOnce('zach@example.com');
    completeSignInWithEmailLinkMock.mockResolvedValueOnce({ uid: 'u1' });

    render(<EmailLinkRoute />);

    await waitFor(() =>
      expect(completeSignInWithEmailLinkMock).toHaveBeenCalledWith(
        'zach@example.com',
        'https://example.com/auth/email-link?apiKey=abc&oobCode=xyz',
      ),
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true }));
  });

  it('cross-device branch — no stashed email → renders the email prompt', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValueOnce(true);
    readAndClearStashedEmailMock.mockReturnValueOnce(null);

    render(<EmailLinkRoute />);

    expect(await screen.findByText(/Confirm your email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Email address/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm and sign in/i })).toBeInTheDocument();
    expect(completeSignInWithEmailLinkMock).not.toHaveBeenCalled();
  });

  it('cross-device branch — submitting the prompt completes sign-in and navigates to /', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValueOnce(true);
    readAndClearStashedEmailMock.mockReturnValueOnce(null);
    completeSignInWithEmailLinkMock.mockResolvedValueOnce({ uid: 'u1' });

    render(<EmailLinkRoute />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Email address/i), 'zach@example.com');
    await user.click(screen.getByRole('button', { name: /Confirm and sign in/i }));

    await waitFor(() =>
      expect(completeSignInWithEmailLinkMock).toHaveBeenCalledWith(
        'zach@example.com',
        'https://example.com/auth/email-link?apiKey=abc&oobCode=xyz',
      ),
    );
    expect(clearStashedEmailMock).toHaveBeenCalled();
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true }));
  });

  it('cross-device branch — refuses to submit an empty email', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValueOnce(true);
    readAndClearStashedEmailMock.mockReturnValueOnce(null);

    render(<EmailLinkRoute />);
    const user = userEvent.setup();
    await screen.findByLabelText(/Email address/i);
    await user.click(screen.getByRole('button', { name: /Confirm and sign in/i }));

    expect(await screen.findByText(/Enter the email/i)).toBeInTheDocument();
    expect(completeSignInWithEmailLinkMock).not.toHaveBeenCalled();
  });

  it('error branch — expired link surfaces the SDK error and renders the re-send link', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValueOnce(true);
    readAndClearStashedEmailMock.mockReturnValueOnce('zach@example.com');
    completeSignInWithEmailLinkMock.mockRejectedValueOnce(
      new Error('Firebase: Error (auth/invalid-action-code).'),
    );

    render(<EmailLinkRoute />);

    const errorCard = await screen.findByTestId('email-link-error');
    expect(errorCard).toHaveTextContent(/invalid-action-code/i);
    const resend = screen.getByRole('link', { name: /Send a new link/i });
    expect(resend).toHaveAttribute('href', '/');
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('error branch — malformed URL surfaces the SDK error', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValueOnce(true);
    readAndClearStashedEmailMock.mockReturnValueOnce('zach@example.com');
    completeSignInWithEmailLinkMock.mockRejectedValueOnce(
      new Error('Firebase: Error (auth/argument-error).'),
    );

    render(<EmailLinkRoute />);

    const errorCard = await screen.findByTestId('email-link-error');
    expect(errorCard).toHaveTextContent(/argument-error/i);
  });

  it('error branch — email mismatch surfaces the SDK error', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValueOnce(true);
    readAndClearStashedEmailMock.mockReturnValueOnce('zach@example.com');
    completeSignInWithEmailLinkMock.mockRejectedValueOnce(
      new Error('Firebase: Error (auth/invalid-email).'),
    );

    render(<EmailLinkRoute />);

    const errorCard = await screen.findByTestId('email-link-error');
    expect(errorCard).toHaveTextContent(/invalid-email/i);
  });

  it('error branch — network failure surfaces the SDK error', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValueOnce(true);
    readAndClearStashedEmailMock.mockReturnValueOnce('zach@example.com');
    completeSignInWithEmailLinkMock.mockRejectedValueOnce(
      new Error('Firebase: Error (auth/network-request-failed).'),
    );

    render(<EmailLinkRoute />);

    const errorCard = await screen.findByTestId('email-link-error');
    expect(errorCard).toHaveTextContent(/network-request-failed/i);
  });

  it('cross-device prompt prefills the email field from peekStashedEmail when present', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValueOnce(true);
    // readAndClear returns null (so the cross-device branch fires) but
    // peek returns a value (e.g. another tab still has it stashed) —
    // the prompt should prefill from that peek.
    readAndClearStashedEmailMock.mockReturnValueOnce(null);
    peekStashedEmailMock.mockReturnValueOnce('zach@example.com');

    render(<EmailLinkRoute />);

    const input = (await screen.findByLabelText(/Email address/i)) as HTMLInputElement;
    expect(input.value).toBe('zach@example.com');
  });
});
