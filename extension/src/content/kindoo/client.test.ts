// Unit tests for the Kindoo multipart POST helper. We mock `fetch` at
// the function-arg boundary (the helper takes a fetchImpl) so we can
// inspect the constructed Request without touching the network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { postKindoo, KindooApiError, KINDOO_REQUEST_TIMEOUT_MS } from './client';

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

/** A fetch that never answers, and rejects the way the platform does
 * when the passed signal aborts. */
function hangingFetch() {
  return vi.fn(
    (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      }),
  ) as unknown as typeof fetch;
}

describe('postKindoo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
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

  // ---- Timeout --------------------------------------------------------
  //
  // `fetch` waits forever by default, and a hung Kindoo call is not a
  // local stall: the remote-apply tick is serialised, so an outstanding
  // call means no heartbeat, no stranded sweep, and — for a manager with
  // one Kindoo tab — a claimed job left `running` with nothing alive to
  // finalise it. That is the one hole the sweep cannot close.

  it('gives up on a call Kindoo never answers, as a clearly-worded network-error', async () => {
    vi.useFakeTimers();
    const fetchImpl = hangingFetch();
    const promise = postKindoo('KindooInviteUser', SESSION, {}, fetchImpl);
    // Attach the rejection handler before the clock moves.
    const assertion = expect(promise).rejects.toMatchObject({
      code: 'network-error',
      // The code is shared with a dropped connection deliberately — both
      // leave "did this reach Kindoo?" unanswerable — so the message is
      // what has to distinguish them for the operator.
      message: expect.stringContaining('timed out'),
    });
    await vi.advanceTimersByTimeAsync(KINDOO_REQUEST_TIMEOUT_MS);
    await assertion;
    await expect(promise).rejects.toBeInstanceOf(KindooApiError);
  });

  it('leaves a call that answers inside the bound untouched', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, KINDOO_REQUEST_TIMEOUT_MS - 1));
      return okResponse([{ EID: 27994 }]);
    });
    const promise = postKindoo('KindooGetEnvironments', SESSION, {}, fetchImpl);
    await vi.advanceTimersByTimeAsync(KINDOO_REQUEST_TIMEOUT_MS);
    await expect(promise).resolves.toEqual([{ EID: 27994 }]);
  });

  it('bounds the body read too, not just the response headers', async () => {
    // A response whose stream stalls mid-body hangs the caller exactly as
    // hard as one whose headers never arrive.
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        ({
          ok: true,
          status: 200,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(new DOMException('The operation was aborted.', 'AbortError')),
              );
            }),
        }) as unknown as Response,
    ) as unknown as typeof fetch;
    const promise = postKindoo('KindooGetEnvironments', SESSION, {}, fetchImpl);
    const assertion = expect(promise).rejects.toMatchObject({
      code: 'network-error',
      message: expect.stringContaining('timed out'),
    });
    await vi.advanceTimersByTimeAsync(KINDOO_REQUEST_TIMEOUT_MS);
    await assertion;
  });
});
