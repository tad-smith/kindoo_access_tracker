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

  // Regression — PR #140 reviewer Fix 11. The Firebase Auth API
  // boundary is NOT a Firestore-keyed input; root CLAUDE.md's
  // "canonicalise every email" rule applies to userIndex / access /
  // kindooManagers (Firestore-keyed) but not here. Firebase Auth
  // treats stored emails as case-insensitive opaque strings and only
  // auto-links byte-equal stored values under "one account per email
  // address." Canonicalising would mint a fresh UID for any user
  // whose existing Google sign-in stored a dot/+suffix variant,
  // breaking AC #8 (existing Google users keep their UID under a
  // magic-link sign-in to the same address).
  //
  // The typed email (post form-level trim + zod) is passed through
  // verbatim. Spec §4.1 step 2 also explicitly says the *typed* email
  // is what's stashed.
  it('passes the typed Gmail variant through verbatim to sendSignInLinkToEmail', async () => {
    sendSignInLinkToEmailMock.mockResolvedValueOnce(undefined);
    await sendMagicLink('Tad.E.Smith@Gmail.com');
    const [, emailArg] = sendSignInLinkToEmailMock.mock.calls[0]!;
    // Dots and case preserved — Firebase needs the same byte string
    // it stored under the operator's existing Google UID.
    expect(emailArg).toBe('Tad.E.Smith@Gmail.com');
    // NOT canonicalised to `tadesmith@gmail.com`.
    expect(emailArg).not.toBe('tadesmith@gmail.com');
  });

  it('stashes the typed form (not a canonicalised form)', async () => {
    sendSignInLinkToEmailMock.mockResolvedValueOnce(undefined);
    await sendMagicLink('Tad.E.Smith+Stake@Gmail.com');
    expect(window.localStorage.getItem(EMAIL_FOR_LINK_STORAGE_KEY)).toBe(
      'Tad.E.Smith+Stake@Gmail.com',
    );
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

  // Regression — PR #140 reviewer Fix 11. The Firebase Auth API
  // boundary is NOT canonicalised (see sendMagicLink test above).
  // The typed email — same-device stash or cross-device prompt — is
  // passed verbatim to signInWithEmailLink. Firebase needs the same
  // byte string it received at sendSignInLinkToEmail time.
  it('passes the typed email through verbatim to signInWithEmailLink', async () => {
    const user = makeUser();
    signInWithEmailLinkMock.mockResolvedValueOnce({ user });
    getIdTokenResultMock.mockResolvedValueOnce({ claims: { canonical: 'z@example.com' } });

    await completeSignInWithEmailLink(
      'Tad.E.Smith@Gmail.com',
      'https://example.com/auth/email-link?apiKey=abc&oobCode=xyz',
    );
    expect(signInWithEmailLinkMock).toHaveBeenCalledWith(
      { __mockAuth: true },
      'Tad.E.Smith@Gmail.com',
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
