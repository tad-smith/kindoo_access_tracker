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
//   - StrictMode double-mount idempotency (PR #140 reviewer Fix 1):
//     the effect's stash read does not consume the value, so the
//     second mount does not slip into the cross-device prompt while
//     the first mount's `completeSignInWithEmailLink` is still in flight.

import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FirebaseError } from 'firebase/app';

// Helper — produce a real `FirebaseError` instance with the right
// `code`. Mocks that previously used `new Error('… auth/foo …')` no
// longer trigger the recoverable-error branch (Fix 14 switched to
// `instanceof FirebaseError` + `err.code` matching, NOT
// `err.message.includes(…)`).
function fbError(code: string, message = `Firebase: Error (${code}).`): FirebaseError {
  return new FirebaseError(code, message);
}

const isSignInWithEmailLinkMock = vi.fn();
const peekStashedEmailMock = vi.fn<() => string | null>();
const clearStashedEmailMock = vi.fn();
const completeSignInWithEmailLinkMock = vi.fn();

vi.mock('../../features/auth/signIn', () => ({
  isSignInWithEmailLink: (href: string) => isSignInWithEmailLinkMock(href),
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
  peekStashedEmailMock.mockReset();
  clearStashedEmailMock.mockReset();
  completeSignInWithEmailLinkMock.mockReset();
  navigateMock.mockClear();
  navigateMock.mockResolvedValue(undefined);
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
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue('zach@example.com');
    completeSignInWithEmailLinkMock.mockResolvedValue({ uid: 'u1' });

    render(<EmailLinkRoute />);

    await waitFor(() =>
      expect(completeSignInWithEmailLinkMock).toHaveBeenCalledWith(
        'zach@example.com',
        'https://example.com/auth/email-link?apiKey=abc&oobCode=xyz',
      ),
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true }));
    // Clear happens on the success path so a future link's stash
    // doesn't carry forward.
    await waitFor(() => expect(clearStashedEmailMock).toHaveBeenCalled());
  });

  it('cross-device branch — no stashed email → renders the email prompt', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue(null);

    render(<EmailLinkRoute />);

    expect(await screen.findByText(/Confirm your email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Email address/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm and sign in/i })).toBeInTheDocument();
    expect(completeSignInWithEmailLinkMock).not.toHaveBeenCalled();
  });

  it('cross-device branch — submitting the prompt completes sign-in and navigates to /', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue(null);
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

  it('cross-device branch — refuses to submit an empty email and keeps the prompt visible', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue(null);

    render(<EmailLinkRoute />);
    const user = userEvent.setup();
    await screen.findByLabelText(/Email address/i);
    await user.click(screen.getByRole('button', { name: /Confirm and sign in/i }));

    // Zod resolver surfaces "Enter your email address." for the empty
    // case (see features/auth/schemas.ts). Field-level error renders
    // inside the still-visible prompt.
    const inline = await screen.findByTestId('email-link-prompt-error');
    expect(inline).toHaveTextContent(/Enter your email/i);
    expect(completeSignInWithEmailLinkMock).not.toHaveBeenCalled();
    // Prompt is still visible — user can retype + retry.
    expect(screen.getByRole('button', { name: /Confirm and sign in/i })).toBeInTheDocument();
  });

  // Regression — PR #140 reviewer Fix 6. The cross-device prompt must
  // apply the same client-side email-format check the initial sign-in
  // form applies. Without it, a user typing "alice" (no `@`) would
  // burn a (still-valid) `oobCode` redemption attempt against the
  // SDK and surface an indistinguishable `auth/invalid-email`.
  it('cross-device branch — rejects a malformed email client-side without calling the SDK', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue(null);

    render(<EmailLinkRoute />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Email address/i), 'alice');
    await user.click(screen.getByRole('button', { name: /Confirm and sign in/i }));

    // Zod resolver surfaces "Enter a valid email address." for the
    // format-fail case (see features/auth/schemas.ts).
    const inline = await screen.findByTestId('email-link-prompt-error');
    expect(inline).toHaveTextContent(/valid email/i);
    expect(completeSignInWithEmailLinkMock).not.toHaveBeenCalled();
    // Prompt still visible — link is still good, user just needs to fix
    // the typo and retry.
    expect(screen.getByRole('button', { name: /Confirm and sign in/i })).toBeInTheDocument();
  });

  // Regression — PR #140 reviewer Fix 5. When the user is in the
  // cross-device prompt branch and the SDK rejects with a
  // typed-email-class error (`auth/invalid-email` /
  // `auth/argument-error`), the link itself is still valid (Firebase
  // only consumes the `oobCode` on a *successful* redemption). Keep
  // the prompt visible with an inline error so the user can fix the
  // typo and resubmit without burning the link. Verifies a retry
  // with the corrected email then completes sign-in.
  it('cross-device branch — auth/invalid-email rejection keeps the prompt visible for retry', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue(null);
    // First attempt rejects (wrong typed email); second attempt
    // resolves (corrected email).
    completeSignInWithEmailLinkMock
      .mockRejectedValueOnce(fbError('auth/invalid-email'))
      .mockResolvedValueOnce({ uid: 'u1' });

    render(<EmailLinkRoute />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Email address/i), 'wrong@example.com');
    await user.click(screen.getByRole('button', { name: /Confirm and sign in/i }));

    // Inline error inside the still-visible prompt — NOT the full
    // ErrorCard with the "Send a new link" affordance.
    const inline = await screen.findByTestId('email-link-prompt-error');
    expect(inline).toHaveTextContent(/invalid-email/i);
    expect(screen.queryByTestId('email-link-error')).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();

    // User fixes the typo and resubmits → sign-in completes. Re-query
    // the input since the inline-error render may have given React a
    // chance to swap nodes; focus state is not guaranteed.
    const retryInput = screen.getByLabelText(/Email address/i) as HTMLInputElement;
    await user.clear(retryInput);
    await user.type(retryInput, 'right@example.com');
    await user.click(screen.getByRole('button', { name: /Confirm and sign in/i }));

    await waitFor(() =>
      expect(completeSignInWithEmailLinkMock).toHaveBeenLastCalledWith(
        'right@example.com',
        'https://example.com/auth/email-link?apiKey=abc&oobCode=xyz',
      ),
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true }));
  });

  // Companion to Fix 5 — auth/argument-error from the prompt is the
  // same "typed-email is wrong" class; the prompt stays visible.
  it('cross-device branch — auth/argument-error rejection keeps the prompt visible', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue(null);
    completeSignInWithEmailLinkMock.mockRejectedValueOnce(fbError('auth/argument-error'));

    render(<EmailLinkRoute />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Email address/i), 'still@example.com');
    await user.click(screen.getByRole('button', { name: /Confirm and sign in/i }));

    const inline = await screen.findByTestId('email-link-prompt-error');
    expect(inline).toHaveTextContent(/argument-error/i);
    expect(screen.queryByTestId('email-link-error')).toBeNull();
  });

  // Regression — PR #140 reviewer Fix 10. A network blip during the
  // SDK call never consumes the `oobCode` (Firebase only consumes it
  // on a *successful* redemption). Keep the prompt visible with an
  // inline error so the user can re-click submit against the same
  // (still-valid) link instead of being forced to request a fresh
  // one. Verifies a retry then completes sign-in.
  it('cross-device branch — auth/network-request-failed keeps the prompt visible for retry', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue(null);
    // First attempt fails on transient network; second resolves.
    completeSignInWithEmailLinkMock
      .mockRejectedValueOnce(fbError('auth/network-request-failed'))
      .mockResolvedValueOnce({ uid: 'u1' });

    render(<EmailLinkRoute />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Email address/i), 'zach@example.com');
    await user.click(screen.getByRole('button', { name: /Confirm and sign in/i }));

    // Inline error on the still-visible prompt; ErrorCard NOT rendered.
    const inline = await screen.findByTestId('email-link-prompt-error');
    expect(inline).toHaveTextContent(/network-request-failed/i);
    expect(screen.queryByTestId('email-link-error')).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();

    // User re-clicks submit (no input changes needed — the typed
    // value survives the bounce per Fix 7).
    await user.click(screen.getByRole('button', { name: /Confirm and sign in/i }));

    await waitFor(() => expect(completeSignInWithEmailLinkMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true }));
  });

  // Other (non-recoverable) errors from the prompt still swap to the
  // full ErrorCard with the re-send affordance — the link is unusable.
  it('cross-device branch — expired-link rejection swaps to the full ErrorCard', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue(null);
    completeSignInWithEmailLinkMock.mockRejectedValueOnce(fbError('auth/invalid-action-code'));

    render(<EmailLinkRoute />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Email address/i), 'zach@example.com');
    await user.click(screen.getByRole('button', { name: /Confirm and sign in/i }));

    const errorCard = await screen.findByTestId('email-link-error');
    expect(errorCard).toHaveTextContent(/invalid-action-code/i);
    expect(screen.queryByTestId('email-link-prompt-error')).toBeNull();
  });

  it('error branch — expired link surfaces the SDK error and renders the re-send link', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue('zach@example.com');
    completeSignInWithEmailLinkMock.mockRejectedValue(fbError('auth/invalid-action-code'));

    render(<EmailLinkRoute />);

    const errorCard = await screen.findByTestId('email-link-error');
    expect(errorCard).toHaveTextContent(/invalid-action-code/i);
    const resend = screen.getByRole('link', { name: /Send a new link/i });
    expect(resend).toHaveAttribute('href', '/');
    expect(navigateMock).not.toHaveBeenCalled();
    // Clear runs on the failure path so a retry / re-send flow doesn't
    // carry the spent value forward.
    await waitFor(() => expect(clearStashedEmailMock).toHaveBeenCalled());
  });

  it('error branch — malformed URL surfaces the SDK error', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue('zach@example.com');
    completeSignInWithEmailLinkMock.mockRejectedValue(fbError('auth/argument-error'));

    render(<EmailLinkRoute />);

    const errorCard = await screen.findByTestId('email-link-error');
    expect(errorCard).toHaveTextContent(/argument-error/i);
  });

  it('error branch — email mismatch surfaces the SDK error', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue('zach@example.com');
    completeSignInWithEmailLinkMock.mockRejectedValue(fbError('auth/invalid-email'));

    render(<EmailLinkRoute />);

    const errorCard = await screen.findByTestId('email-link-error');
    expect(errorCard).toHaveTextContent(/invalid-email/i);
  });

  // Regression — PR #140 reviewer Fix 13. Auto-signin path on a
  // transient network failure keeps the stash intact and renders a
  // "Retry sign-in" affordance against the same still-valid link,
  // symmetric with the cross-device prompt path's handling. A
  // subsequent retry that resolves completes the sign-in.
  it('auto-signin path — network failure keeps the stash and offers Retry sign-in', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue('zach@example.com');
    // First attempt fails on transient network; second resolves.
    completeSignInWithEmailLinkMock
      .mockRejectedValueOnce(fbError('auth/network-request-failed'))
      .mockResolvedValueOnce({ uid: 'u1' });

    render(<EmailLinkRoute />);

    // RetryCard renders — NOT the unrecoverable ErrorCard.
    const retryCard = await screen.findByTestId('email-link-retry');
    expect(retryCard).toHaveTextContent(/network-request-failed/i);
    expect(screen.queryByTestId('email-link-error')).toBeNull();
    // Stash NOT cleared — link is still valid.
    expect(clearStashedEmailMock).not.toHaveBeenCalled();

    // User clicks Retry sign-in → second call resolves, navigate fires.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Retry sign-in/i }));

    await waitFor(() => expect(completeSignInWithEmailLinkMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true }));
    // After success, stash IS cleared.
    expect(clearStashedEmailMock).toHaveBeenCalled();
  });

  // Same auto-signin path with a non-recoverable error code: the link
  // IS unusable, so the stash is cleared and the unrecoverable
  // ErrorCard renders with the "Send a new link" affordance.
  it('auto-signin path — non-recoverable rejection clears the stash and shows ErrorCard', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue('zach@example.com');
    completeSignInWithEmailLinkMock.mockRejectedValue(fbError('auth/invalid-action-code'));

    render(<EmailLinkRoute />);

    const errorCard = await screen.findByTestId('email-link-error');
    expect(errorCard).toHaveTextContent(/invalid-action-code/i);
    expect(screen.queryByTestId('email-link-retry')).toBeNull();
    await waitFor(() => expect(clearStashedEmailMock).toHaveBeenCalled());
  });

  // Regression — PR #140 reviewer Fix 14. The recoverable check
  // matches on `FirebaseError.code` (the SDK's stable contract), not
  // on `err.message`. A FirebaseError whose message text omits the
  // code (e.g. a future SDK version reformats the message) must
  // still trigger the recoverable branch.
  it('cross-device branch — FirebaseError with a generic message still hits the recoverable branch via .code', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue(null);
    // Generic message that does NOT embed the code string. The old
    // `err.message.includes('auth/network-request-failed')` check
    // would have missed this.
    completeSignInWithEmailLinkMock.mockRejectedValueOnce(
      fbError('auth/network-request-failed', 'Network unreachable.'),
    );

    render(<EmailLinkRoute />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Email address/i), 'zach@example.com');
    await user.click(screen.getByRole('button', { name: /Confirm and sign in/i }));

    const inline = await screen.findByTestId('email-link-prompt-error');
    // The displayed message is whatever the SDK gave us (generic in
    // this case) — the recoverable decision was made on `.code`.
    expect(inline).toHaveTextContent(/Network unreachable/i);
    expect(screen.queryByTestId('email-link-error')).toBeNull();
  });

  // Regression — PR #140 reviewer Fix 14. Error-code matching uses
  // `FirebaseError.code`, NOT `err.message.includes(code)`. A plain
  // `Error` whose message happens to contain "auth/invalid-email"
  // is NOT a Firebase SDK error and must fall through to the
  // non-recoverable ErrorCard.
  it('cross-device branch — non-FirebaseError rejection falls through to ErrorCard even if message contains the code', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue(null);
    completeSignInWithEmailLinkMock.mockRejectedValueOnce(
      new Error('upstream proxy returned auth/invalid-email'),
    );

    render(<EmailLinkRoute />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Email address/i), 'zach@example.com');
    await user.click(screen.getByRole('button', { name: /Confirm and sign in/i }));

    // The `instanceof FirebaseError` check filtered this out of the
    // recoverable bucket, so the prompt's typed-email error UI is NOT
    // shown — the full ErrorCard is.
    const errorCard = await screen.findByTestId('email-link-error');
    expect(errorCard).toHaveTextContent(/auth\/invalid-email/i);
    expect(screen.queryByTestId('email-link-prompt-error')).toBeNull();
  });

  // Regression — PR #140 reviewer Fix 7. The cross-device prompt's
  // typed email must survive the `prompt → signing-in-from-prompt →
  // prompt` transition that fires on a typed-email rejection. The
  // previous implementation used an uncontrolled `<input
  // defaultValue=…>` inside a subcomponent that unmounted on the
  // signing-in branch; the re-mount on rejection wiped the user's
  // input. The fix lifts the form to RHF state at the parent level
  // and keeps the form mounted across the in-flight transition.
  it('preserves the typed email across a typed-email rejection', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue(null);
    // First attempt rejects with the email-typo class; second resolves.
    completeSignInWithEmailLinkMock
      .mockRejectedValueOnce(fbError('auth/invalid-email'))
      .mockResolvedValueOnce({ uid: 'u1' });

    render(<EmailLinkRoute />);
    const user = userEvent.setup();
    const input = (await screen.findByLabelText(/Email address/i)) as HTMLInputElement;
    // Use a distinctive long-ish string so a wipe is obvious.
    await user.type(input, 'verylongname.with.dots@example.com');
    await user.click(screen.getByRole('button', { name: /Confirm and sign in/i }));

    // Inline error rendered — the SDK rejected the first attempt.
    const inline = await screen.findByTestId('email-link-prompt-error');
    expect(inline).toHaveTextContent(/invalid-email/i);

    // CRITICAL: the user's typed value is STILL in the field after the
    // bounce. Re-query because RHF may swap React identities; the
    // input behind the same label is what the user sees.
    const inputAfter = screen.getByLabelText(/Email address/i) as HTMLInputElement;
    expect(inputAfter.value).toBe('verylongname.with.dots@example.com');

    // User fixes the typo and resubmits.
    await user.clear(inputAfter);
    await user.type(inputAfter, 'correct@example.com');
    await user.click(screen.getByRole('button', { name: /Confirm and sign in/i }));

    await waitFor(() =>
      expect(completeSignInWithEmailLinkMock).toHaveBeenLastCalledWith(
        'correct@example.com',
        'https://example.com/auth/email-link?apiKey=abc&oobCode=xyz',
      ),
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true }));
  });

  // Regression — PR #140 reviewer Fix 1 (actually-correct take). Under
  // React 18 StrictMode the effect double-mounts in dev. Firebase
  // consumes the `oobCode` on the FIRST `signInWithEmailLink` call;
  // the second call rejects with `auth/invalid-action-code`. If the
  // effect dispatches sign-in twice, the second rejection runs AFTER
  // the first succeeded, flipping state to the ErrorCard even though
  // sign-in actually worked.
  //
  // This mock matches real Firebase semantics: first call resolves,
  // every subsequent call rejects with `auth/invalid-action-code`.
  // Under a `useRef` started-this-render guard the second mount bails
  // before dispatching a second call, so navigate fires and the user
  // never sees ErrorCard. Without the guard this test fails because
  // state ends on ErrorCard.
  it('does not surface a spurious invalid-action-code under StrictMode double-mount', async () => {
    setHref('https://example.com/auth/email-link?apiKey=abc&oobCode=xyz');
    isSignInWithEmailLinkMock.mockReturnValue(true);
    peekStashedEmailMock.mockReturnValue('zach@example.com');
    completeSignInWithEmailLinkMock
      .mockResolvedValueOnce({ uid: 'u1' })
      .mockRejectedValue(fbError('auth/invalid-action-code'));

    render(
      <StrictMode>
        <EmailLinkRoute />
      </StrictMode>,
    );

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/', replace: true }));

    // Only ONE sign-in call dispatched in total — the second mount
    // saw the started-ref and bailed.
    expect(completeSignInWithEmailLinkMock).toHaveBeenCalledTimes(1);
    expect(completeSignInWithEmailLinkMock).toHaveBeenCalledWith(
      'zach@example.com',
      'https://example.com/auth/email-link?apiKey=abc&oobCode=xyz',
    );
    // ErrorCard never rendered.
    expect(screen.queryByTestId('email-link-error')).toBeNull();
    // Cross-device prompt never rendered either.
    expect(screen.queryByText(/Confirm your email/i)).toBeNull();
  });
});
