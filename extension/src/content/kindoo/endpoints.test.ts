// Endpoint-wrapper tests. We mock the captured response shapes from
// `extension/docs/v2-kindoo-api-capture.md` (gitignored) as inline JSON
// literals here so other engineers see the shape contract without
// needing the capture file.

import { describe, expect, it, vi } from 'vitest';
import { KindooApiError } from './client';
import { getEnvironments, getEnvironmentRules } from './endpoints';

const SESSION = { token: 'sess-123', eid: 27994 };

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('getEnvironments', () => {
  it('parses a list of environments and narrows EID + Name', async () => {
    const fetchImpl = vi.fn(async () =>
      ok([
        {
          EID: 27994,
          Name: 'Colorado Springs North Stake',
          Description: 'whatever',
        },
        {
          EID: 28000,
          Name: 'Some Other Site',
        },
      ]),
    );
    const result = await getEnvironments(SESSION, fetchImpl);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ EID: 27994, Name: 'Colorado Springs North Stake' });
    expect(result[1]).toMatchObject({ EID: 28000, Name: 'Some Other Site' });
  });

  it('throws unexpected-shape when an entry is missing EID/Name', async () => {
    const fetchImpl = vi.fn(async () => ok([{ Name: 'No EID' }]));
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
  it('parses a list of rules and narrows RID + Name', async () => {
    const fetchImpl = vi.fn(async () =>
      ok([
        { RID: 6248, Name: 'Cordera Doors', SomeOtherField: 1 },
        { RID: 6249, Name: 'Pine Creek Doors' },
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

  it('throws unexpected-shape when an entry is missing RID/Name', async () => {
    const fetchImpl = vi.fn(async () => ok([{ Name: 'No RID' }]));
    await expect(getEnvironmentRules(SESSION, 27994, fetchImpl)).rejects.toMatchObject({
      code: 'unexpected-shape',
    });
  });
});
