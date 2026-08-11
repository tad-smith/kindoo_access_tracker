// Integration tests for the `mintExtensionToken` callable — the SPA →
// extension sign-in handoff (spec §4.1). Invoked via `.run({ data, auth })`,
// the test hook firebase-functions v2 exposes on `CallableFunction`.
//
// Against the Auth emulator the Admin SDK swaps in `EmulatedSigner`
// (alg `none`, empty signature), so the minted JWT is well-formed and
// its payload is decodable without a key. That is exactly what these
// tests inspect — the payload's `uid`, and the ABSENCE of the nested
// `claims` field that `developerClaims` would populate.
//
// Coverage:
//   - Happy path: signed-in caller → custom token for their own uid.
//   - Unauthenticated caller → `HttpsError('unauthenticated')`.
//   - No `developerClaims`: minted token carries no `claims` field, and
//     the caller's `setCustomUserClaims` block is left untouched — the
//     `stakes` claim keeps flowing from the user record.
//   - Repeat calls: stateless, so a retry mints another usable token
//     rather than failing or mutating anything.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mintExtensionToken } from '../src/callable/mintExtensionToken.js';
import { clearEmulators, hasEmulators, requireEmulators } from './lib/emulator.js';

const UID = 'uid-manager-1';
const EMAIL = 'mgr@gmail.com';

/** Decode a JWT payload. Emulator tokens are unsigned, so no verify step. */
function decodePayload(token: string): Record<string, unknown> {
  const segment = token.split('.')[1];
  if (!segment) throw new Error(`not a JWT: ${token}`);
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Build a v2 CallableRequest stub with the fields our handler reads. */
function callableReq(opts: { auth?: { uid: string; email: string } | null }): never {
  return {
    data: undefined,
    auth: opts.auth ? { uid: opts.auth.uid, token: { email: opts.auth.email } } : undefined,
    rawRequest: {} as unknown,
    acceptsStreaming: false,
  } as unknown as never;
}

describe.skipIf(!hasEmulators())('mintExtensionToken callable', () => {
  beforeAll(async () => {
    await clearEmulators();
  });
  afterEach(async () => {
    await clearEmulators();
  });
  afterAll(async () => {
    await clearEmulators();
  });

  it('mints a custom token for the calling uid', async () => {
    const result = await mintExtensionToken.run(callableReq({ auth: { uid: UID, email: EMAIL } }));

    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBeGreaterThan(0);
    expect(decodePayload(result.token)['uid']).toBe(UID);
  });

  it('rejects an unauthenticated caller with HttpsError(unauthenticated)', async () => {
    await expect(mintExtensionToken.run(callableReq({ auth: null }))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('omits developerClaims and leaves the user record claims untouched', async () => {
    const { auth } = requireEmulators();
    await auth.createUser({ uid: UID, email: EMAIL });
    const stakeClaims = {
      canonical: EMAIL,
      stakes: { csnorth: { manager: true, stake: false, wards: [] } },
    };
    await auth.setCustomUserClaims(UID, stakeClaims);

    const result = await mintExtensionToken.run(callableReq({ auth: { uid: UID, email: EMAIL } }));

    // `developerClaims` would land here, nested and separate from the
    // user record. Its absence is what keeps `claims.stakes[...]` reads
    // in rules / `usePrincipal()` sourced from one place.
    expect(decodePayload(result.token)).not.toHaveProperty('claims');

    // The user record — the actual source of the `stakes` block that
    // rides through `signInWithCustomToken` — is unchanged.
    expect((await auth.getUser(UID)).customClaims).toEqual(stakeClaims);
  });

  it('mints an independent token on each call', async () => {
    const first = await mintExtensionToken.run(callableReq({ auth: { uid: UID, email: EMAIL } }));
    const second = await mintExtensionToken.run(callableReq({ auth: { uid: UID, email: EMAIL } }));

    expect(decodePayload(first.token)['uid']).toBe(UID);
    expect(decodePayload(second.token)['uid']).toBe(UID);
  });
});
