// Unit tests for the Kindoo multipart POST helper. We mock `fetch` at
// the function-arg boundary (the helper takes a fetchImpl) so we can
// inspect the constructed Request without touching the network.

import { describe, expect, it, vi } from 'vitest';
import { postKindoo, KindooApiError } from './client';

const SESSION = { token: 'sess-123', eid: 27994 };

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

async function captureBody(init: RequestInit): Promise<FormData> {
  // FormData round-trips faithfully through the test-side Request.
  return new Request('https://test.invalid/', init).formData();
}

function lastCall(
  spy: ReturnType<typeof vi.fn>,
): [string | URL | Request, RequestInit | undefined] {
  const calls = spy.mock.calls as Array<[string | URL | Request, RequestInit | undefined]>;
  return calls[calls.length - 1]!;
}

describe('postKindoo', () => {
  it('builds the standard envelope with SessionTokenID + EID + AppVersion + PlatformOS', async () => {
    const fetchImpl = vi.fn(async () => okResponse([]));
    await postKindoo('KindooGetEnvironments', SESSION, {}, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = lastCall(fetchImpl);
    expect(url).toBe('https://service89.kindoo.tech/WebService.asmx/KindooGetEnvironments');
    expect(init).toBeDefined();
    expect(init!.method).toBe('POST');

    const form = await captureBody(init!);
    expect(form.get('SessionTokenID')).toBe('sess-123');
    expect(form.get('EID')).toBe('27994');
    expect(form.get('AppVersion')).toBe('6.1.0');
    expect(form.get('PlatformOS')).toBe('web');
  });

  it('inserts extra fields between EID and the trailing AppVersion / PlatformOS', async () => {
    const fetchImpl = vi.fn(async () => okResponse([]));
    await postKindoo(
      'KindooCheckUserTypeInKindoo',
      SESSION,
      { UsersEmail: '["tad.e.smith@gmail.com"]' },
      fetchImpl,
    );
    const [, init] = lastCall(fetchImpl);
    const form = await captureBody(init!);
    expect(form.get('UsersEmail')).toBe('["tad.e.smith@gmail.com"]');
  });

  it('returns the parsed JSON body on a 200 response', async () => {
    const fetchImpl = vi.fn(async () => okResponse([{ EID: 27994, Name: 'X' }]));
    const result = await postKindoo('KindooGetEnvironments', SESSION, {}, fetchImpl);
    expect(result).toEqual([{ EID: 27994, Name: 'X' }]);
  });

  it('throws KindooApiError("http-error") on non-2xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    await expect(postKindoo('KindooGetEnvironments', SESSION, {}, fetchImpl)).rejects.toMatchObject(
      { code: 'http-error', status: 500 },
    );
  });

  it('throws KindooApiError("bad-json") on a 200 body that is not JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>...</html>', { status: 200 }));
    await expect(postKindoo('KindooGetEnvironments', SESSION, {}, fetchImpl)).rejects.toMatchObject(
      { code: 'bad-json' },
    );
  });

  it('throws KindooApiError("network-error") when fetch itself rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      postKindoo('KindooGetEnvironments', SESSION, {}, fetchImpl),
    ).rejects.toBeInstanceOf(KindooApiError);
    await expect(postKindoo('KindooGetEnvironments', SESSION, {}, fetchImpl)).rejects.toMatchObject(
      { code: 'network-error' },
    );
  });
});
