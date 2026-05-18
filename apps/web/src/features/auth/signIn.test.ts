// Unit tests for the email magic link helpers in `signIn.ts`. The
// Firebase SDK is mocked at the module boundary so we exercise:
//   - `sendMagicLink` calls `sendSignInLinkToEmail` with the right
//     `actionCodeSettings` (origin-derived URL + handleCodeInApp: true).
//   - `sendMagicLink` stashes the typed email in localStorage on
//     success; does NOT stash on rejection.
//   - `isSignInWithEmailLink` is a passthrough to the SDK.
//   - `readAndClearStashedEmail` / `peekStashedEmail` / `clearStashedEmail`
//     interact with localStorage correctly.
//   - `completeSignInWithEmailLink` calls `signInWithEmailLink`,
//     force-refreshes the token, and runs the bounded-poll
//     claim-refresh from the legacy Google flow (B-4 mitigation).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendSignInLinkToEmailMock = vi.fn();
const signInWithEmailLinkMock = vi.fn();
const isSignInWithEmailLinkMock = vi.fn();
const getIdTokenMock = vi.fn();
const getIdTokenResultMock = vi.fn();

vi.mock('firebase/auth', async () => {
  const actual = await vi.importActual<typeof import('firebase/auth')>('firebase/auth');
  return {
    ...actual,
    sendSignInLinkToEmail: (...args: unknown[]) => sendSignInLinkToEmailMock(...args),
    signInWithEmailLink: (...args: unknown[]) => signInWithEmailLinkMock(...args),
    isSignInWithEmailLink: (...args: unknown[]) => isSignInWithEmailLinkMock(...args),
  };
});

vi.mock('../../lib/firebase', () => ({
  auth: { __mockAuth: true },
}));

import {
  EMAIL_FOR_LINK_STORAGE_KEY,
  EMAIL_LINK_ACTION_PATH,
  buildActionCodeSettings,
  clearStashedEmail,
  completeSignInWithEmailLink,
  isSignInWithEmailLink,
  peekStashedEmail,
  readAndClearStashedEmail,
  sendMagicLink,
} from './signIn';

beforeEach(() => {
  sendSignInLinkToEmailMock.mockReset();
  signInWithEmailLinkMock.mockReset();
  isSignInWithEmailLinkMock.mockReset();
  getIdTokenMock.mockReset();
  getIdTokenResultMock.mockReset();
  getIdTokenMock.mockResolvedValue('id-token');
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeUser() {
  return {
    uid: 'u1',
    email: 'zach.q.mortensen@gmail.com',
    getIdToken: getIdTokenMock,
    getIdTokenResult: getIdTokenResultMock,
  };
}

describe('buildActionCodeSettings', () => {
  it('uses window.location.origin + the action-handler path with handleCodeInApp: true', () => {
    const settings = buildActionCodeSettings();
    expect(settings.handleCodeInApp).toBe(true);
    expect(settings.url).toBe(`${window.location.origin}${EMAIL_LINK_ACTION_PATH}`);
  });
});

describe('sendMagicLink', () => {
  it('calls sendSignInLinkToEmail with the auth singleton, the email, and the action-code settings', async () => {
    sendSignInLinkToEmailMock.mockResolvedValueOnce(undefined);
    await sendMagicLink('zach@example.com');
    expect(sendSignInLinkToEmailMock).toHaveBeenCalledTimes(1);
    const [authArg, emailArg, settingsArg] = sendSignInLinkToEmailMock.mock.calls[0]!;
    expect(authArg).toEqual({ __mockAuth: true });
    expect(emailArg).toBe('zach@example.com');
    expect(settingsArg).toEqual({
      url: `${window.location.origin}${EMAIL_LINK_ACTION_PATH}`,
      handleCodeInApp: true,
    });
  });

  it('stashes the typed email in localStorage on success', async () => {
    sendSignInLinkToEmailMock.mockResolvedValueOnce(undefined);
    await sendMagicLink('zach@example.com');
    expect(window.localStorage.getItem(EMAIL_FOR_LINK_STORAGE_KEY)).toBe('zach@example.com');
  });

  it('does not stash the email when sendSignInLinkToEmail rejects', async () => {
    sendSignInLinkToEmailMock.mockRejectedValueOnce(new Error('auth/invalid-email'));
    await expect(sendMagicLink('not-an-email')).rejects.toThrow(/invalid-email/);
    expect(window.localStorage.getItem(EMAIL_FOR_LINK_STORAGE_KEY)).toBeNull();
  });

  it('still resolves when localStorage throws (private mode / quota)', async () => {
    sendSignInLinkToEmailMock.mockResolvedValueOnce(undefined);
    const setItemSpy = vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      await expect(sendMagicLink('zach@example.com')).resolves.toBeUndefined();
    } finally {
      setItemSpy.mockRestore();
    }
  });

  // Regression — PR #140 reviewer Fix 9. Every typed-email input must
  // pass through `canonicalEmail()` before any boundary use (spec §2 /
  // root CLAUDE.md). For Gmail-class addresses, variant entries
  // (`Zach.Mortensen+Stake@Gmail.com`, `zachmortensen@gmail.com`)
  // collapse to one canonical form; without this normalisation the SDK
  // would mint two Firebase UIDs that both resolve via
  // `onAuthUserCreate` to the same `userIndex/{canonical}` doc and
  // overwrite each other's UID mapping.
  it('canonicalises a Gmail address before calling sendSignInLinkToEmail', async () => {
    sendSignInLinkToEmailMock.mockResolvedValueOnce(undefined);
    await sendMagicLink('Zach.Mortensen+Stake@Gmail.com');
    const [, emailArg] = sendSignInLinkToEmailMock.mock.calls[0]!;
    expect(emailArg).toBe('zachmortensen@gmail.com');
  });

  it('stashes the canonicalised form (not the typed form)', async () => {
    sendSignInLinkToEmailMock.mockResolvedValueOnce(undefined);
    await sendMagicLink('Zach.Mortensen+Stake@Gmail.com');
    expect(window.localStorage.getItem(EMAIL_FOR_LINK_STORAGE_KEY)).toBe('zachmortensen@gmail.com');
  });

  it('canonicalises a googlemail.com address (case + host collapse)', async () => {
    sendSignInLinkToEmailMock.mockResolvedValueOnce(undefined);
    await sendMagicLink('Alice@GoogleMail.com');
    const [, emailArg] = sendSignInLinkToEmailMock.mock.calls[0]!;
    expect(emailArg).toBe('alice@gmail.com');
  });

  it('lowercases a non-Gmail address (no dot/+suffix stripping)', async () => {
    sendSignInLinkToEmailMock.mockResolvedValueOnce(undefined);
    await sendMagicLink('Bob.Smith@Example.com');
    const [, emailArg] = sendSignInLinkToEmailMock.mock.calls[0]!;
    expect(emailArg).toBe('bob.smith@example.com');
  });
});

describe('isSignInWithEmailLink', () => {
  it('delegates to the SDK with the auth singleton and the href', () => {
    isSignInWithEmailLinkMock.mockReturnValueOnce(true);
    const result = isSignInWithEmailLink('https://example.com/auth/email-link?apiKey=…');
    expect(result).toBe(true);
    expect(isSignInWithEmailLinkMock).toHaveBeenCalledWith(
      { __mockAuth: true },
      'https://example.com/auth/email-link?apiKey=…',
    );
  });
});

describe('localStorage helpers', () => {
  it('readAndClearStashedEmail returns the value and clears the key', () => {
    window.localStorage.setItem(EMAIL_FOR_LINK_STORAGE_KEY, 'zach@example.com');
    const value = readAndClearStashedEmail();
    expect(value).toBe('zach@example.com');
    expect(window.localStorage.getItem(EMAIL_FOR_LINK_STORAGE_KEY)).toBeNull();
  });

  it('readAndClearStashedEmail returns null when the key is absent', () => {
    expect(readAndClearStashedEmail()).toBeNull();
  });

  it('peekStashedEmail returns the value without clearing the key', () => {
    window.localStorage.setItem(EMAIL_FOR_LINK_STORAGE_KEY, 'zach@example.com');
    expect(peekStashedEmail()).toBe('zach@example.com');
    expect(window.localStorage.getItem(EMAIL_FOR_LINK_STORAGE_KEY)).toBe('zach@example.com');
  });

  it('clearStashedEmail removes the key', () => {
    window.localStorage.setItem(EMAIL_FOR_LINK_STORAGE_KEY, 'zach@example.com');
    clearStashedEmail();
    expect(window.localStorage.getItem(EMAIL_FOR_LINK_STORAGE_KEY)).toBeNull();
  });
});

describe('completeSignInWithEmailLink — bounded poll for canonical claim (B-4)', () => {
  it('calls signInWithEmailLink with the auth singleton, email, and href', async () => {
    const user = makeUser();
    signInWithEmailLinkMock.mockResolvedValueOnce({ user });
    getIdTokenResultMock.mockResolvedValueOnce({ claims: { canonical: 'z@example.com' } });

    const returned = await completeSignInWithEmailLink('zach@example.com', 'https://e.com/x');
    expect(returned).toBe(user);
    expect(signInWithEmailLinkMock).toHaveBeenCalledWith(
      { __mockAuth: true },
      'zach@example.com',
      'https://e.com/x',
    );
  });

  // Regression — PR #140 reviewer Fix 9. The cross-device prompt
  // hands a freshly-typed email through. That value must be
  // canonicalised before the SDK call so the user identity matches
  // the one Firebase minted from the same-device `sendMagicLink`
  // (also canonicalised).
  it('canonicalises a Gmail variant before calling signInWithEmailLink', async () => {
    const user = makeUser();
    signInWithEmailLinkMock.mockResolvedValueOnce({ user });
    getIdTokenResultMock.mockResolvedValueOnce({ claims: { canonical: 'z@example.com' } });

    await completeSignInWithEmailLink(
      'Zach.Mortensen+Stake@Gmail.com',
      'https://example.com/auth/email-link?apiKey=abc&oobCode=xyz',
    );
    expect(signInWithEmailLinkMock).toHaveBeenCalledWith(
      { __mockAuth: true },
      'zachmortensen@gmail.com',
      'https://example.com/auth/email-link?apiKey=abc&oobCode=xyz',
    );
  });

  it('returns immediately after the first refresh when claims are already present', async () => {
    const user = makeUser();
    signInWithEmailLinkMock.mockResolvedValueOnce({ user });
    getIdTokenResultMock.mockResolvedValueOnce({
      claims: { canonical: 'zachqmortensen@gmail.com' },
    });

    const returned = await completeSignInWithEmailLink('z@example.com', 'https://e.com/x');

    expect(returned).toBe(user);
    expect(getIdTokenMock).toHaveBeenCalledTimes(1);
    expect(getIdTokenMock).toHaveBeenCalledWith(true);
    expect(getIdTokenResultMock).toHaveBeenCalledTimes(1);
  });

  it('polls until the canonical claim arrives and stops at the first iteration that sees it', async () => {
    vi.useFakeTimers();
    const user = makeUser();
    signInWithEmailLinkMock.mockResolvedValueOnce({ user });
    getIdTokenResultMock
      .mockResolvedValueOnce({ claims: {} })
      .mockResolvedValueOnce({ claims: {} })
      .mockResolvedValueOnce({ claims: {} })
      .mockResolvedValueOnce({ claims: { canonical: 'zachqmortensen@gmail.com' } });

    const promise = completeSignInWithEmailLink('z@example.com', 'https://e.com/x');
    await vi.runAllTimersAsync();
    const returned = await promise;

    expect(returned).toBe(user);
    expect(getIdTokenMock).toHaveBeenCalledTimes(4);
    expect(getIdTokenResultMock).toHaveBeenCalledTimes(4);
  });

  it('resolves without throwing when claims never arrive within the 10-iteration ceiling', async () => {
    vi.useFakeTimers();
    const user = makeUser();
    signInWithEmailLinkMock.mockResolvedValueOnce({ user });
    getIdTokenResultMock.mockResolvedValue({ claims: {} });

    const promise = completeSignInWithEmailLink('z@example.com', 'https://e.com/x');
    await vi.runAllTimersAsync();
    const returned = await promise;

    expect(returned).toBe(user);
    expect(getIdTokenResultMock).toHaveBeenCalledTimes(10);
    expect(getIdTokenMock).toHaveBeenCalledTimes(11);
  });

  it('waits 500ms between polling iterations', async () => {
    vi.useFakeTimers();
    const user = makeUser();
    signInWithEmailLinkMock.mockResolvedValueOnce({ user });
    getIdTokenResultMock
      .mockResolvedValueOnce({ claims: {} })
      .mockResolvedValueOnce({ claims: { canonical: 'zachqmortensen@gmail.com' } });

    const promise = completeSignInWithEmailLink('z@example.com', 'https://e.com/x');

    await vi.advanceTimersByTimeAsync(0);
    expect(getIdTokenResultMock).toHaveBeenCalledTimes(1);
    expect(getIdTokenMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(getIdTokenResultMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(getIdTokenMock).toHaveBeenCalledTimes(2);
    expect(getIdTokenResultMock).toHaveBeenCalledTimes(2);
  });

  it('propagates a rejection from signInWithEmailLink', async () => {
    signInWithEmailLinkMock.mockRejectedValueOnce(new Error('auth/invalid-action-code'));
    await expect(completeSignInWithEmailLink('z@example.com', 'https://e.com/x')).rejects.toThrow(
      /invalid-action-code/,
    );
    expect(getIdTokenMock).not.toHaveBeenCalled();
    expect(getIdTokenResultMock).not.toHaveBeenCalled();
  });
});
