// Unit tests for the signed-out view's two sign-in paths. Mocks the SW
// wrappers (`lib/extensionApi`) and asserts that each button drives its
// own path and nothing else:
//
//   - the Google button calls `signIn` and never `signInViaWeb`, and the
//     email button the reverse. A manager with no Google account is the
//     entire reason the second button exists, so a mis-wired handler
//     would leave them exactly as stuck as before.
//   - `consent_dismissed` from EITHER path gets the soft-retry copy, not
//     the red hard-failure copy.
//   - both buttons disable while either flow is in flight, so a manager
//     cannot open two auth windows at once.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const signInMock = vi.fn();
const signInViaWebMock = vi.fn();

vi.mock('../lib/extensionApi', async () => {
  const actual = await vi.importActual<typeof import('../lib/extensionApi')>('../lib/extensionApi');
  return {
    ...actual,
    signIn: (...args: unknown[]) => signInMock(...args),
    signInViaWeb: (...args: unknown[]) => signInViaWebMock(...args),
  };
});

import { ExtensionApiError } from '../lib/extensionApi';
import { SignedOutPanel } from './SignedOutPanel';

describe('SignedOutPanel', () => {
  beforeEach(() => {
    signInMock.mockReset();
    signInViaWebMock.mockReset();
  });

  it('offers both sign-in paths', () => {
    render(<SignedOutPanel />);
    expect(screen.getByTestId('sba-sign-in')).toHaveTextContent('Sign in with Google');
    expect(screen.getByTestId('sba-sign-in-email')).toHaveTextContent('Sign in with email');
  });

  it('the Google button drives signIn only', async () => {
    signInMock.mockResolvedValue({ status: 'signed-in' });
    const onSignedIn = vi.fn();
    render(<SignedOutPanel onSignedIn={onSignedIn} />);

    await userEvent.click(screen.getByTestId('sba-sign-in'));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(signInMock).toHaveBeenCalled();
    expect(signInViaWebMock).not.toHaveBeenCalled();
  });

  it('the email button drives signInViaWeb only', async () => {
    signInViaWebMock.mockResolvedValue({ status: 'signed-in' });
    const onSignedIn = vi.fn();
    render(<SignedOutPanel onSignedIn={onSignedIn} />);

    await userEvent.click(screen.getByTestId('sba-sign-in-email'));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(signInViaWebMock).toHaveBeenCalled();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('keeps the plain cancellation copy when the Google flow is dismissed', async () => {
    // Chrome's consent dialog has no failure state to explain, so a
    // dismissal there really is a dismissal.
    signInMock.mockRejectedValue(
      new ExtensionApiError({ code: 'consent_dismissed', message: 'user did not approve' }),
    );
    render(<SignedOutPanel />);

    await userEvent.click(screen.getByTestId('sba-sign-in'));

    const alert = await screen.findByTestId('sba-sign-in-error');
    expect(alert).toHaveTextContent('Sign-in cancelled. Click again to retry.');
  });

  it('does not claim a cancellation when the email flow ends without completing', async () => {
    // A closed window and a redirect_uri the SPA refused arrive as the
    // same bare lastError, so this copy cannot assert either one. The
    // SPA's refusal card says retrying is pointless and is gone by the
    // time this renders — copy that ordered a retry would overwrite it.
    signInViaWebMock.mockRejectedValue(
      new ExtensionApiError({ code: 'consent_dismissed', message: 'window closed' }),
    );
    render(<SignedOutPanel />);

    await userEvent.click(screen.getByTestId('sba-sign-in-email'));

    const alert = await screen.findByTestId('sba-sign-in-error');
    expect(alert).not.toHaveTextContent('Sign-in cancelled');
    expect(alert).toHaveTextContent('Sign-in didn’t finish');
    // The escape hatch out of a retry loop is the load-bearing half.
    expect(alert).toHaveTextContent('retrying won’t help');
    // "configuration error" is shared wording, not a phrasing choice:
    // this copy points the manager back at the SPA's refusal card, and
    // the card names the same phrase (pinned by a mirrored test on the
    // web side). Reword the surrounding sentence freely; drop this
    // phrase and the pointer sends them hunting for words that are not
    // on the card they just read.
    expect(alert).toHaveTextContent('configuration error');
  });

  it('surfaces a hard failure from the email flow with its message', async () => {
    signInViaWebMock.mockRejectedValue(
      new ExtensionApiError({
        code: 'sign_in_failed',
        message: 'web sign-in failed (mint_failed)',
      }),
    );
    render(<SignedOutPanel />);

    await userEvent.click(screen.getByTestId('sba-sign-in-email'));

    const alert = await screen.findByTestId('sba-sign-in-error');
    expect(alert).toHaveTextContent('web sign-in failed (mint_failed)');
  });

  it('disables both buttons while either flow is in flight', async () => {
    let release: () => void = () => {};
    signInViaWebMock.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    render(<SignedOutPanel />);

    await userEvent.click(screen.getByTestId('sba-sign-in-email'));

    await waitFor(() => expect(screen.getByTestId('sba-sign-in')).toBeDisabled());
    expect(screen.getByTestId('sba-sign-in-email')).toBeDisabled();

    release();
    await waitFor(() => expect(screen.getByTestId('sba-sign-in')).not.toBeDisabled());
  });
});
