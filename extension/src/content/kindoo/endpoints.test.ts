// Endpoint-wrapper tests. We mock the captured response shapes from
// `extension/docs/v2-kindoo-api-capture.md` (gitignored) as inline JSON
// literals here so other engineers see the shape contract without
// needing the capture file.

import { describe, expect, it, vi } from 'vitest';
import { KindooApiError } from './client';
import {
  checkUserType,
  getEnvironments,
  getEnvironmentRules,
  inviteUser,
  lookupUserByEmail,
  revokeUser,
  saveAccessRule,
  type KindooInviteUserPayload,
} from './endpoints';

const SESSION = { token: 'sess-123', eid: 27994 };

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

async function formFromLastCall(spy: ReturnType<typeof vi.fn>): Promise<FormData> {
  const calls = spy.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>;
  const init = calls[calls.length - 1]![1];
  return new Request('https://test.invalid/', init!).formData();
}

describe('getEnvironments', () => {
  it('parses a list of environments and narrows EID + Name from the wire shape', async () => {
    const fetchImpl = vi.fn(async () =>
      ok([
        {
          EnvironmentID: 27994,
          EnvironmentName: 'Colorado Springs North Stake',
          Description: 'whatever',
        },
        {
          EnvironmentID: 28000,
          EnvironmentName: 'Some Other Site',
        },
      ]),
    );
    const result = await getEnvironments(SESSION, fetchImpl);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ EID: 27994, Name: 'Colorado Springs North Stake' });
    expect(result[1]).toMatchObject({ EID: 28000, Name: 'Some Other Site' });
  });

  it('throws unexpected-shape when an entry is missing EnvironmentID/EnvironmentName', async () => {
    const fetchImpl = vi.fn(async () => ok([{ EnvironmentName: 'No ID' }]));
    await expect(getEnvironments(SESSION, fetchImpl)).rejects.toBeInstanceOf(KindooApiError);
    await expect(getEnvironments(SESSION, fetchImpl)).rejects.toMatchObject({
      code: 'unexpected-shape',
    });
  });

  it('returns [] when the body is not an array', async () => {
    const fetchImpl = vi.fn(async () => ok({ d: 'unexpected wrapper' }));
    const result = await getEnvironments(SESSION, fetchImpl);
    expect(result).toEqual([]);
  });
});

describe('getEnvironmentRules', () => {
  it('parses a list of rules and narrows ID + Name from the wire shape', async () => {
    const fetchImpl = vi.fn(async () =>
      ok([
        { ID: 6248, Name: 'Cordera Doors', SomeOtherField: 1 },
        { ID: 6249, Name: 'Pine Creek Doors' },
      ]),
    );
    const result = await getEnvironmentRules(SESSION, 27994, fetchImpl);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ RID: 6248, Name: 'Cordera Doors' });
    expect(result[1]).toMatchObject({ RID: 6249, Name: 'Pine Creek Doors' });
  });

  it('passes the eid argument (not session.eid) in the form envelope', async () => {
    const fetchImpl = vi.fn(async () => ok([]));
    await getEnvironmentRules(SESSION, 99999, fetchImpl);
    const calls = fetchImpl.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>;
    const init = calls[0]![1];
    expect(init).toBeDefined();
    const form = await new Request('https://test.invalid/', init!).formData();
    expect(form.get('EID')).toBe('99999');
  });

  it('throws unexpected-shape when an entry is missing ID/Name', async () => {
    const fetchImpl = vi.fn(async () => ok([{ Name: 'No ID' }]));
    await expect(getEnvironmentRules(SESSION, 27994, fetchImpl)).rejects.toMatchObject({
      code: 'unexpected-shape',
    });
  });
});

describe('checkUserType', () => {
  it('sends UsersEmail as a JSON array containing the single email', async () => {
    const fetchImpl = vi.fn(async () => ok([]));
    await checkUserType(SESSION, 'tad.e.smith@gmail.com', fetchImpl);
    const form = await formFromLastCall(fetchImpl);
    expect(form.get('UsersEmail')).toBe(JSON.stringify(['tad.e.smith@gmail.com']));
  });

  it('returns exists=false when the response is an empty array', async () => {
    const fetchImpl = vi.fn(async () => ok([]));
    const result = await checkUserType(SESSION, 'nobody@example.com', fetchImpl);
    expect(result).toEqual({ exists: false, uid: null });
  });

  it('returns exists=true with the UID when the response carries one', async () => {
    const fetchImpl = vi.fn(async () =>
      ok([{ UID: '85bea3c7-1c18-40f0-b514-c828e48bd983', UserEmail: 'someone@example.com' }]),
    );
    const result = await checkUserType(SESSION, 'someone@example.com', fetchImpl);
    expect(result).toEqual({ exists: true, uid: '85bea3c7-1c18-40f0-b514-c828e48bd983' });
  });

  it('unwraps an ASP.NET-style `{ d: ... }` envelope around the payload', async () => {
    const fetchImpl = vi.fn(async () => ok({ d: [{ UserID: 'wrapped-uid' }] }));
    const result = await checkUserType(SESSION, 'wrap@example.com', fetchImpl);
    expect(result).toEqual({ exists: true, uid: 'wrapped-uid' });
  });

  it('treats a non-empty response with no UID as not-found rather than throwing', async () => {
    const fetchImpl = vi.fn(async () => ok([{ Foo: 'Bar' }]));
    const result = await checkUserType(SESSION, 'nothing@example.com', fetchImpl);
    expect(result).toEqual({ exists: false, uid: null });
  });
});

describe('inviteUser', () => {
  const payload: KindooInviteUserPayload = {
    UserEmail: 'tad.e.smith@gmail.com',
    UserRole: 2,
    Description: 'Pine Creek Ward (Sunday School Teacher)',
    CCInEmail: false,
    IsTempUser: false,
    StartAccessDoorsDate: null,
    ExpiryDate: null,
    ExpiryTimeZone: 'Mountain Standard Time',
  };

  it('JSON-encodes the single-user payload into the UsersEmail form field', async () => {
    const fetchImpl = vi.fn(async () => ok({ UID: 'fresh-uid' }));
    await inviteUser(SESSION, payload, fetchImpl);
    const form = await formFromLastCall(fetchImpl);
    expect(form.get('UsersEmail')).toBe(JSON.stringify([payload]));
  });

  it('returns the UID from the response when present', async () => {
    const fetchImpl = vi.fn(async () => ok({ UID: 'fresh-uid' }));
    const result = await inviteUser(SESSION, payload, fetchImpl);
    expect(result).toEqual({ uid: 'fresh-uid' });
  });

  it('falls back to checkUserType when the invite response has no UID', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      // First call: invite response with no UID.
      if (call === 1) return ok({ Success: true });
      // Second call: checkUserType resolves it.
      return ok([{ UID: 'resolved-via-fallback' }]);
    });
    const result = await inviteUser(SESSION, payload, fetchImpl);
    expect(result).toEqual({ uid: 'resolved-via-fallback' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws unexpected-shape when neither the invite response nor the fallback yields a UID', async () => {
    const fetchImpl = vi.fn(async () => ok([]));
    await expect(inviteUser(SESSION, payload, fetchImpl)).rejects.toBeInstanceOf(KindooApiError);
    await expect(inviteUser(SESSION, payload, fetchImpl)).rejects.toMatchObject({
      code: 'unexpected-shape',
    });
  });
});

describe('saveAccessRule', () => {
  it('sends UID, JSON-array RIDs, and an empty username', async () => {
    const fetchImpl = vi.fn(async () => ok({}));
    await saveAccessRule(SESSION, 'user-uid', [6248, 6249, 6250], fetchImpl);
    const form = await formFromLastCall(fetchImpl);
    expect(form.get('UID')).toBe('user-uid');
    expect(form.get('RIDs')).toBe(JSON.stringify([6248, 6249, 6250]));
    expect(form.get('username')).toBe('');
  });

  it('returns ok=true on a 200 response regardless of body content', async () => {
    const fetchImpl = vi.fn(async () => ok({ AnythingAtAll: true }));
    const result = await saveAccessRule(SESSION, 'user-uid', [6248], fetchImpl);
    expect(result).toEqual({ ok: true });
  });

  it('bubbles up HTTP errors from the underlying postKindoo', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    await expect(saveAccessRule(SESSION, 'user-uid', [6248], fetchImpl)).rejects.toMatchObject({
      code: 'http-error',
      status: 500,
    });
  });
});

describe('lookupUserByEmail', () => {
  it('sends the Kindoo-default pagination + the keyword + the invited-data flag', async () => {
    const fetchImpl = vi.fn(async () => ok([]));
    await lookupUserByEmail(SESSION, 'tad.e.smith@gmail.com', fetchImpl);
    const form = await formFromLastCall(fetchImpl);
    expect(form.get('start')).toBe('0');
    expect(form.get('end')).toBe('50');
    expect(form.get('keyWord')).toBe('tad.e.smith@gmail.com');
    expect(form.get('FetchInvitedOnInvitedByData')).toBe('true');
  });

  it('parses a bare-array response into { users: [{ uid, email }] }', async () => {
    const fetchImpl = vi.fn(async () =>
      ok([
        { UID: 'one', Email: 'a@example.com', SomethingElse: 1 },
        { UID: 'two', Email: 'b@example.com' },
      ]),
    );
    const result = await lookupUserByEmail(SESSION, 'a@example.com', fetchImpl);
    expect(result.users).toEqual([
      { uid: 'one', email: 'a@example.com' },
      { uid: 'two', email: 'b@example.com' },
    ]);
  });

  it('parses a wrapped `{ Users: [...] }` response', async () => {
    const fetchImpl = vi.fn(async () =>
      ok({
        Users: [{ UID: 'x', UserEmail: 'x@example.com' }],
        TotalNumberOfRecords: 1,
      }),
    );
    const result = await lookupUserByEmail(SESSION, 'x@example.com', fetchImpl);
    expect(result.users).toEqual([{ uid: 'x', email: 'x@example.com' }]);
  });

  it('returns an empty users[] when no entries carry both a UID and email', async () => {
    const fetchImpl = vi.fn(async () => ok([{ Foo: 'Bar' }]));
    const result = await lookupUserByEmail(SESSION, 'nothing@example.com', fetchImpl);
    expect(result.users).toEqual([]);
  });

  it('returns an empty users[] when the response is empty', async () => {
    const fetchImpl = vi.fn(async () => ok([]));
    const result = await lookupUserByEmail(SESSION, 'nothing@example.com', fetchImpl);
    expect(result.users).toEqual([]);
  });
});

describe('revokeUser', () => {
  it('sends UID and an empty username', async () => {
    const fetchImpl = vi.fn(async () => ok({}));
    await revokeUser(SESSION, '85bea3c7-1c18-40f0-b514-c828e48bd983', fetchImpl);
    const form = await formFromLastCall(fetchImpl);
    expect(form.get('UID')).toBe('85bea3c7-1c18-40f0-b514-c828e48bd983');
    expect(form.get('username')).toBe('');
  });

  it('returns ok=true on a 200 response', async () => {
    const fetchImpl = vi.fn(async () => ok({ Success: true }));
    const result = await revokeUser(SESSION, 'user-uid', fetchImpl);
    expect(result).toEqual({ ok: true });
  });

  it('bubbles up HTTP errors from the underlying postKindoo', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    await expect(revokeUser(SESSION, 'user-uid', fetchImpl)).rejects.toMatchObject({
      code: 'http-error',
      status: 500,
    });
  });
});
