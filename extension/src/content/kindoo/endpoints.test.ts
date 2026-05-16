// Endpoint-wrapper tests. We mock the captured response shapes from
// `extension/docs/v2-kindoo-api-capture.md` (gitignored) as inline JSON
// literals here so other engineers see the shape contract without
// needing the capture file.

import { describe, expect, it, vi } from 'vitest';
import { KindooApiError } from './client';
import {
  checkUserType,
  editUser,
  getEnvironmentRuleWithEntryPoints,
  getEnvironments,
  getEnvironmentRules,
  getUserAccessRulesWithEntryPoints,
  inviteUser,
  listAllEnvironmentUsers,
  lookupUserByEmail,
  revokeUser,
  revokeUserFromAccessSchedule,
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

/** Rich-user shape from `KindooGetEnvironmentUsersLightWithTotalNumberOfRecords`,
 * matching `extension/docs/v2-kindoo-api-capture.md`. */
function richUser(overrides: Record<string, unknown> = {}) {
  return {
    EUID: 'fcf38b4c-1111-1111-1111-111111111111',
    UserID: '85bea3c7-1c18-40f0-b514-c828e48bd983',
    Username: 'tad.e.smith@gmail.com',
    DisplayName: 'Tad Smith',
    Description: 'Cordera Ward (Sunday School Teacher)',
    IsTempUser: false,
    StartAccessDoorsDate: '2026-05-13T14:00:00Z',
    StartAccessDoorsDateAtTimeZone: '2026-05-13T08:00',
    ExpiryDate: '2026-05-15T04:00:00Z',
    ExpiryDateAtTimeZone: '2026-05-14T22:00',
    ExpiryTimeZone: 'Mountain Standard Time',
    AccessSchedules: [
      {
        EUID: 'fcf38b4c-1111-1111-1111-111111111111',
        RuleID: 6249,
        rules_sets: { ID: 6249, Name: 'Monument - Everyday' },
      },
    ],
    HasAcceptedInvitation: false,
    InvitedOn: '2026-05-13T16:17:59Z',
    ...overrides,
  };
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

describe('editUser', () => {
  const payload = {
    description: 'Cordera Ward (Sunday School Teacher)',
    isTemp: false,
    startAccessDoorsDateTime: '',
    expiryDate: '',
    timeZone: 'Mountain Standard Time',
  };

  it('sends euID + the lowercase payload fields with the T-separator date format', async () => {
    const fetchImpl = vi.fn(async () => ok({ Success: true }));
    await editUser(
      SESSION,
      'fcf38b4c-1111-1111-1111-111111111111',
      {
        description: 'Pine Creek Ward (Temp)',
        isTemp: true,
        startAccessDoorsDateTime: '2026-05-13T00:00',
        expiryDate: '2026-05-14T23:59',
        timeZone: 'Mountain Standard Time',
      },
      fetchImpl,
    );
    const form = await formFromLastCall(fetchImpl);
    expect(form.get('euID')).toBe('fcf38b4c-1111-1111-1111-111111111111');
    expect(form.get('description')).toBe('Pine Creek Ward (Temp)');
    expect(form.get('isTemp')).toBe('true');
    expect(form.get('startAccessDoorsDateTime')).toBe('2026-05-13T00:00');
    expect(form.get('expiryDate')).toBe('2026-05-14T23:59');
    expect(form.get('timeZone')).toBe('Mountain Standard Time');
  });

  it('returns ok=true on a 200 response regardless of body content', async () => {
    const fetchImpl = vi.fn(async () => ok({ AnythingAtAll: true }));
    const result = await editUser(SESSION, 'euid', payload, fetchImpl);
    expect(result).toEqual({ ok: true });
  });

  it('bubbles up HTTP errors from the underlying postKindoo', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    await expect(editUser(SESSION, 'euid', payload, fetchImpl)).rejects.toMatchObject({
      code: 'http-error',
      status: 500,
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
    const fetchImpl = vi.fn(async () => ok({ EUList: [] }));
    await lookupUserByEmail(SESSION, 'tad.e.smith@gmail.com', fetchImpl);
    const form = await formFromLastCall(fetchImpl);
    expect(form.get('start')).toBe('0');
    expect(form.get('end')).toBe('50');
    expect(form.get('keyWord')).toBe('tad.e.smith@gmail.com');
    expect(form.get('FetchInvitedOnInvitedByData')).toBe('true');
  });

  it('parses the rich EUList shape into a narrowed KindooEnvironmentUser', async () => {
    const fetchImpl = vi.fn(async () =>
      ok({
        CurrentNumberOfRows: 0,
        TotalRecordNumber: 1,
        EUList: [richUser()],
      }),
    );
    const user = await lookupUserByEmail(SESSION, 'tad.e.smith@gmail.com', fetchImpl);
    expect(user).not.toBeNull();
    expect(user).toMatchObject({
      euid: 'fcf38b4c-1111-1111-1111-111111111111',
      userId: '85bea3c7-1c18-40f0-b514-c828e48bd983',
      username: 'tad.e.smith@gmail.com',
      description: 'Cordera Ward (Sunday School Teacher)',
      isTempUser: false,
      startAccessDoorsDateAtTimeZone: '2026-05-13T08:00',
      expiryDateAtTimeZone: '2026-05-14T22:00',
      expiryTimeZone: 'Mountain Standard Time',
      accessSchedules: [{ ruleId: 6249 }],
    });
  });

  it('filters by exact username (case-insensitive) — substring keyword matches do not leak', async () => {
    // Kindoo's keyWord does substring; client must filter to avoid
    // operating on the wrong user.
    const fetchImpl = vi.fn(async () =>
      ok({
        EUList: [
          richUser({ Username: 'tad.e.smith.but.different@gmail.com', EUID: 'wrong-euid' }),
          richUser({ Username: 'TAD.E.SMITH@gmail.com' }),
        ],
      }),
    );
    const user = await lookupUserByEmail(SESSION, 'tad.e.smith@gmail.com', fetchImpl);
    expect(user).not.toBeNull();
    expect(user!.euid).toBe('fcf38b4c-1111-1111-1111-111111111111');
    expect(user!.username).toBe('TAD.E.SMITH@gmail.com');
  });

  it('returns null when no entry exact-matches the email', async () => {
    const fetchImpl = vi.fn(async () =>
      ok({
        EUList: [richUser({ Username: 'someone.else@example.com' })],
      }),
    );
    const user = await lookupUserByEmail(SESSION, 'nothing@example.com', fetchImpl);
    expect(user).toBeNull();
  });

  it('returns null when the EUList is empty', async () => {
    const fetchImpl = vi.fn(async () => ok({ EUList: [] }));
    const user = await lookupUserByEmail(SESSION, 'nothing@example.com', fetchImpl);
    expect(user).toBeNull();
  });

  it('returns null when the response carries no EUList (or any user list)', async () => {
    const fetchImpl = vi.fn(async () => ok({ Foo: 'Bar' }));
    const user = await lookupUserByEmail(SESSION, 'nothing@example.com', fetchImpl);
    expect(user).toBeNull();
  });

  it('falls back to a bare-array response shape', async () => {
    const fetchImpl = vi.fn(async () => ok([richUser()]));
    const user = await lookupUserByEmail(SESSION, 'tad.e.smith@gmail.com', fetchImpl);
    expect(user).not.toBeNull();
    expect(user!.euid).toBe('fcf38b4c-1111-1111-1111-111111111111');
  });

  it('defaults missing optional fields rather than throwing', async () => {
    const fetchImpl = vi.fn(async () =>
      ok({
        EUList: [
          {
            EUID: 'e1',
            UserID: 'u1',
            Username: 'min@example.com',
            // Description / IsTempUser / dates / AccessSchedules all missing.
          },
        ],
      }),
    );
    const user = await lookupUserByEmail(SESSION, 'min@example.com', fetchImpl);
    expect(user).not.toBeNull();
    expect(user).toMatchObject({
      euid: 'e1',
      userId: 'u1',
      username: 'min@example.com',
      description: '',
      isTempUser: false,
      startAccessDoorsDateAtTimeZone: null,
      expiryDateAtTimeZone: null,
      expiryTimeZone: '',
      accessSchedules: [],
    });
  });
});

describe('listAllEnvironmentUsers', () => {
  function page(users: ReturnType<typeof richUser>[], total: number) {
    return ok({
      CurrentNumberOfRows: users.length,
      TotalRecordNumber: total,
      EUList: users,
    });
  }

  it('loops until a short page (length < 50) terminates the read', async () => {
    // 2 pages: first 50 users, second 10 (< 50 → terminate).
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        const users = Array.from({ length: 50 }, (_, i) =>
          richUser({ EUID: `e${i}`, Username: `u${i}@example.com` }),
        );
        return page(users, 60);
      }
      const users = Array.from({ length: 10 }, (_, i) =>
        richUser({ EUID: `e${50 + i}`, Username: `u${50 + i}@example.com` }),
      );
      return page(users, 60);
    });
    const result = await listAllEnvironmentUsers(SESSION, fetchImpl);
    expect(result).toHaveLength(60);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('advances `start` by 50 each iteration', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call < 3) {
        const users = Array.from({ length: 50 }, (_, i) =>
          richUser({ EUID: `e${call}-${i}`, Username: `u${call}-${i}@example.com` }),
        );
        return page(users, 110);
      }
      return page([richUser({ EUID: 'last', Username: 'last@example.com' })], 110);
    });
    await listAllEnvironmentUsers(SESSION, fetchImpl);
    const starts = fetchImpl.mock.calls.map(async (call) => {
      const [, init] = call as unknown as [unknown, RequestInit];
      const form = await new Request('https://test.invalid/', init).formData();
      return form.get('start');
    });
    const resolved = await Promise.all(starts);
    expect(resolved).toEqual(['0', '50', '100']);
  });

  it('stops when start reaches TotalRecordNumber even on a full-size page', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        // Page-size=50, total=50 — only one full page is needed.
        const users = Array.from({ length: 50 }, (_, i) =>
          richUser({ EUID: `e${i}`, Username: `u${i}@example.com` }),
        );
        return page(users, 50);
      }
      // Defensive — shouldn't be reached.
      return page([], 50);
    });
    const result = await listAllEnvironmentUsers(SESSION, fetchImpl);
    expect(result).toHaveLength(50);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('handles 3 pages with truncation when TotalRecordNumber < pages × 50', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        const users = Array.from({ length: 50 }, (_, i) =>
          richUser({ EUID: `a${i}`, Username: `a${i}@x.com` }),
        );
        return page(users, 110);
      }
      if (call === 2) {
        const users = Array.from({ length: 50 }, (_, i) =>
          richUser({ EUID: `b${i}`, Username: `b${i}@x.com` }),
        );
        return page(users, 110);
      }
      // 10 leftover users.
      const users = Array.from({ length: 10 }, (_, i) =>
        richUser({ EUID: `c${i}`, Username: `c${i}@x.com` }),
      );
      return page(users, 110);
    });
    const result = await listAllEnvironmentUsers(SESSION, fetchImpl);
    expect(result).toHaveLength(110);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns an empty list when the first page is empty', async () => {
    const fetchImpl = vi.fn(async () => page([], 0));
    const result = await listAllEnvironmentUsers(SESSION, fetchImpl);
    expect(result).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to a bare-array response shape', async () => {
    const fetchImpl = vi.fn(async () => ok([richUser({ EUID: 'bare1', Username: 'bare1@x.com' })]));
    const result = await listAllEnvironmentUsers(SESSION, fetchImpl);
    expect(result).toHaveLength(1);
    expect(result[0]?.euid).toBe('bare1');
  });

  it('dedups single-page rows that share an EUID, merging accessSchedules', async () => {
    // Kindoo's no-keyword paginated listing emits one row per
    // access-schedule. Three rows for the same EUID with distinct
    // RuleIDs must collapse to one user carrying all three rules.
    const fetchImpl = vi.fn(async () =>
      page(
        [
          richUser({
            EUID: 'same-euid',
            Username: 'multi@example.com',
            AccessSchedules: [{ RuleID: 6248 }],
          }),
          richUser({
            EUID: 'same-euid',
            Username: 'multi@example.com',
            AccessSchedules: [{ RuleID: 6249 }],
          }),
          richUser({
            EUID: 'same-euid',
            Username: 'multi@example.com',
            AccessSchedules: [{ RuleID: 6250 }],
          }),
        ],
        3,
      ),
    );
    const result = await listAllEnvironmentUsers(SESSION, fetchImpl);
    expect(result).toHaveLength(1);
    expect(result[0]?.euid).toBe('same-euid');
    expect(result[0]?.accessSchedules.map((s) => s.ruleId).sort()).toEqual([6248, 6249, 6250]);
  });

  it('preserves distinct users in a single page when EUIDs differ', async () => {
    const fetchImpl = vi.fn(async () =>
      page(
        [
          richUser({
            EUID: 'euid-a',
            Username: 'a@example.com',
            AccessSchedules: [{ RuleID: 6248 }],
          }),
          richUser({
            EUID: 'euid-b',
            Username: 'b@example.com',
            AccessSchedules: [{ RuleID: 6249 }, { RuleID: 6250 }],
          }),
        ],
        2,
      ),
    );
    const result = await listAllEnvironmentUsers(SESSION, fetchImpl);
    expect(result).toHaveLength(2);
    const a = result.find((u) => u.euid === 'euid-a');
    const b = result.find((u) => u.euid === 'euid-b');
    expect(a?.accessSchedules.map((s) => s.ruleId)).toEqual([6248]);
    expect(b?.accessSchedules.map((s) => s.ruleId).sort()).toEqual([6249, 6250]);
  });

  it('dedups across pages — duplicates split across page boundaries collapse to one user', async () => {
    // Page 1: 50 rows, last row shares EUID 'cross' with first row on page 2.
    // Total of 52 wire rows → 51 unique users after dedup.
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        const users = Array.from({ length: 49 }, (_, i) =>
          richUser({
            EUID: `e${i}`,
            Username: `u${i}@x.com`,
            AccessSchedules: [{ RuleID: 6000 + i }],
          }),
        );
        users.push(
          richUser({
            EUID: 'cross',
            Username: 'cross@example.com',
            AccessSchedules: [{ RuleID: 7000 }],
          }),
        );
        return page(users, 52);
      }
      // Page 2: cross-EUID row + one new EUID = 2 rows, < 50 → terminate.
      return page(
        [
          richUser({
            EUID: 'cross',
            Username: 'cross@example.com',
            AccessSchedules: [{ RuleID: 7001 }],
          }),
          richUser({
            EUID: 'tail',
            Username: 'tail@example.com',
            AccessSchedules: [{ RuleID: 7002 }],
          }),
        ],
        52,
      );
    });
    const result = await listAllEnvironmentUsers(SESSION, fetchImpl);
    expect(result).toHaveLength(51);
    const cross = result.find((u) => u.euid === 'cross');
    expect(cross).toBeDefined();
    expect(cross?.accessSchedules.map((s) => s.ruleId).sort()).toEqual([7000, 7001]);
  });

  it('keeps first-occurrence metadata when EUIDs collide', async () => {
    // Two rows, same EUID, but different Description / IsTempUser /
    // dates. First-occurrence metadata must win; only accessSchedules
    // merge across collisions.
    const fetchImpl = vi.fn(async () =>
      page(
        [
          richUser({
            EUID: 'shared',
            Username: 'shared@example.com',
            Description: 'FIRST description',
            IsTempUser: false,
            ExpiryDateAtTimeZone: '2026-06-01T00:00',
            AccessSchedules: [{ RuleID: 6248 }],
          }),
          richUser({
            EUID: 'shared',
            Username: 'shared@example.com',
            Description: 'SECOND description (loses)',
            IsTempUser: true,
            ExpiryDateAtTimeZone: '2026-07-01T00:00',
            AccessSchedules: [{ RuleID: 6249 }],
          }),
        ],
        2,
      ),
    );
    const result = await listAllEnvironmentUsers(SESSION, fetchImpl);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      euid: 'shared',
      description: 'FIRST description',
      isTempUser: false,
      expiryDateAtTimeZone: '2026-06-01T00:00',
    });
    expect(result[0]?.accessSchedules.map((s) => s.ruleId).sort()).toEqual([6248, 6249]);
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

describe('getEnvironmentRuleWithEntryPoints', () => {
  function door(over: Record<string, unknown> = {}) {
    return {
      ID: 12345,
      Name: 'Cordera - North',
      Description: 'Meetinghouse - 6700 Cordera Crest Ave',
      IsSelected: true,
      ...over,
    };
  }

  it('sends RuleID + EID + isClone=false in the form envelope', async () => {
    const fetchImpl = vi.fn(async () => ok({ ID: 6250, Name: 'Jamboree - Everyday', doors: [] }));
    await getEnvironmentRuleWithEntryPoints(SESSION, 6250, 27994, fetchImpl);
    const form = await formFromLastCall(fetchImpl);
    expect(form.get('RuleID')).toBe('6250');
    expect(form.get('EID')).toBe('27994');
    expect(form.get('isClone')).toBe('false');
  });

  it('returns only the IsSelected doors as selectedDoorIds and the full list as allDoors', async () => {
    const fetchImpl = vi.fn(async () =>
      ok({
        ID: 6250,
        Name: 'Jamboree - Everyday',
        doors: [
          door({ ID: 1001, Name: 'Jamboree - North', IsSelected: true }),
          door({ ID: 1002, Name: 'Jamboree - South', IsSelected: true }),
          door({ ID: 1003, Name: 'Jamboree - Cultural', IsSelected: true }),
          door({ ID: 2001, Name: 'Cordera - North', IsSelected: false }),
          door({ ID: 2002, Name: 'Cordera - South', IsSelected: false }),
        ],
      }),
    );
    const result = await getEnvironmentRuleWithEntryPoints(SESSION, 6250, 27994, fetchImpl);
    expect(result.ruleId).toBe(6250);
    expect(result.ruleName).toBe('Jamboree - Everyday');
    expect(result.selectedDoorIds.sort()).toEqual([1001, 1002, 1003]);
    expect(result.allDoors).toHaveLength(5);
    expect(result.allDoors[0]).toMatchObject({ doorId: 1001, name: 'Jamboree - North' });
  });

  it('handles an empty doors array', async () => {
    const fetchImpl = vi.fn(async () => ok({ ID: 6250, Name: 'Empty', doors: [] }));
    const result = await getEnvironmentRuleWithEntryPoints(SESSION, 6250, 27994, fetchImpl);
    expect(result.selectedDoorIds).toEqual([]);
    expect(result.allDoors).toEqual([]);
  });

  it('throws unexpected-shape when ID/Name missing', async () => {
    const fetchImpl = vi.fn(async () => ok({ doors: [] }));
    await expect(
      getEnvironmentRuleWithEntryPoints(SESSION, 6250, 27994, fetchImpl),
    ).rejects.toMatchObject({ code: 'unexpected-shape' });
  });

  it('unwraps `{ d: ... }` ASP.NET-style envelope', async () => {
    const fetchImpl = vi.fn(async () =>
      ok({ d: { ID: 6250, Name: 'Wrapped', doors: [door({ ID: 7001 })] } }),
    );
    const result = await getEnvironmentRuleWithEntryPoints(SESSION, 6250, 27994, fetchImpl);
    expect(result.selectedDoorIds).toEqual([7001]);
  });
});

describe('getUserAccessRulesWithEntryPoints', () => {
  function row(over: Record<string, unknown> = {}) {
    return {
      DoorID: 1001,
      AccessScheduleID: 0,
      EUID: 'eu1',
      UserID: 'u1',
      ...over,
    };
  }

  function page(rows: ReturnType<typeof row>[], total: number) {
    return ok({
      CurrentNumberOfRows: rows.length,
      TotalRecordNumber: total,
      RulesList: rows,
    });
  }

  it('sends UID/EID/pagination/source/fillEmptyWeeklyDaysWithOneRow/FetchGrantedByData', async () => {
    const fetchImpl = vi.fn(async () => page([], 0));
    await getUserAccessRulesWithEntryPoints(SESSION, 'user-1', 27994, fetchImpl);
    const form = await formFromLastCall(fetchImpl);
    expect(form.get('UID')).toBe('user-1');
    expect(form.get('EID')).toBe('27994');
    expect(form.get('start')).toBe('0');
    expect(form.get('end')).toBe('40');
    expect(form.get('keyword')).toBe('');
    expect(form.get('source')).toBe('SiteUserManage:useEffect:fetchUserRules');
    expect(form.get('fillEmptyWeeklyDaysWithOneRow')).toBe('true');
    expect(form.get('FetchGrantedByData')).toBe('true');
  });

  it('returns all unique DoorIDs from a single short page', async () => {
    const fetchImpl = vi.fn(async () =>
      page(
        [
          row({ DoorID: 1001, AccessScheduleID: 0 }),
          row({ DoorID: 1002, AccessScheduleID: 0 }),
          row({ DoorID: 2001, AccessScheduleID: 6248 }),
        ],
        3,
      ),
    );
    const result = await getUserAccessRulesWithEntryPoints(SESSION, 'user-1', 27994, fetchImpl);
    expect(result.map((r) => r.doorId).sort()).toEqual([1001, 1002, 2001]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('dedupes rows that share a DoorID across rules', async () => {
    // Same door granted by two rules → emits two rows in the response;
    // we want one row out, accessScheduleId = first occurrence.
    const fetchImpl = vi.fn(async () =>
      page(
        [
          row({ DoorID: 1001, AccessScheduleID: 6248 }),
          row({ DoorID: 1001, AccessScheduleID: 6250 }),
          row({ DoorID: 1002, AccessScheduleID: 0 }),
        ],
        3,
      ),
    );
    const result = await getUserAccessRulesWithEntryPoints(SESSION, 'user-1', 27994, fetchImpl);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.doorId).sort()).toEqual([1001, 1002]);
  });

  it('pages with start += 40 until a short page terminates', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        const rows = Array.from({ length: 40 }, (_, i) =>
          row({ DoorID: 1000 + i, AccessScheduleID: 0 }),
        );
        return page(rows, 50);
      }
      // Short page → terminate.
      const rows = Array.from({ length: 10 }, (_, i) =>
        row({ DoorID: 1100 + i, AccessScheduleID: 0 }),
      );
      return page(rows, 50);
    });
    const result = await getUserAccessRulesWithEntryPoints(SESSION, 'user-1', 27994, fetchImpl);
    expect(result).toHaveLength(50);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calls = fetchImpl.mock.calls as unknown as Array<[unknown, RequestInit]>;
    const starts = await Promise.all(
      calls.map(async ([, init]) => {
        const form = await new Request('https://test.invalid/', init).formData();
        return form.get('start');
      }),
    );
    expect(starts).toEqual(['0', '40']);
  });

  it('stops when start reaches TotalRecordNumber even on a full-size page', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      const rows = Array.from({ length: 40 }, (_, i) =>
        row({ DoorID: 1000 + i, AccessScheduleID: 0 }),
      );
      return page(rows, 40);
    });
    const result = await getUserAccessRulesWithEntryPoints(SESSION, 'user-1', 27994, fetchImpl);
    expect(result).toHaveLength(40);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to a bare-array response shape', async () => {
    const fetchImpl = vi.fn(async () => ok([row({ DoorID: 9999 })]));
    const result = await getUserAccessRulesWithEntryPoints(SESSION, 'user-1', 27994, fetchImpl);
    expect(result).toHaveLength(1);
    expect(result[0]?.doorId).toBe(9999);
  });

  it('returns empty when first page is empty', async () => {
    const fetchImpl = vi.fn(async () => page([], 0));
    const result = await getUserAccessRulesWithEntryPoints(SESSION, 'user-1', 27994, fetchImpl);
    expect(result).toEqual([]);
  });
});

describe('revokeUserFromAccessSchedule', () => {
  it('sends EUID + ID (the rule RID) in the form envelope', async () => {
    // Body `1` parses as the number 1 — captured live shape.
    const fetchImpl = vi.fn(async () => new Response('1', { status: 200 }));
    await revokeUserFromAccessSchedule(
      SESSION,
      'fcf38b4c-1111-1111-1111-111111111111',
      6250,
      fetchImpl,
    );
    const form = await formFromLastCall(fetchImpl);
    expect(form.get('EUID')).toBe('fcf38b4c-1111-1111-1111-111111111111');
    expect(form.get('ID')).toBe('6250');
    // Standard envelope still present.
    expect(form.get('SessionTokenID')).toBe('sess-123');
    expect(form.get('EID')).toBe('27994');
    expect(form.get('AppVersion')).toBe('6.1.0');
    expect(form.get('PlatformOS')).toBe('web');
  });

  it('returns ok=true on a plain "1" success response', async () => {
    const fetchImpl = vi.fn(async () => new Response('1', { status: 200 }));
    const result = await revokeUserFromAccessSchedule(SESSION, 'euid', 6250, fetchImpl);
    expect(result).toEqual({ ok: true });
  });

  it('throws unexpected-shape on any non-"1" response body', async () => {
    // `"0"` body — parses as the number 0 → treated as error.
    const fetchImpl = vi.fn(async () => new Response('0', { status: 200 }));
    await expect(
      revokeUserFromAccessSchedule(SESSION, 'euid', 6250, fetchImpl),
    ).rejects.toMatchObject({ code: 'unexpected-shape' });
  });

  it('bubbles up HTTP errors from the underlying postKindoo', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    await expect(
      revokeUserFromAccessSchedule(SESSION, 'euid', 6250, fetchImpl),
    ).rejects.toMatchObject({ code: 'http-error', status: 500 });
  });
});
