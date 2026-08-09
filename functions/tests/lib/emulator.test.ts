// Unit tests for `sweepFirestore`'s retry (T-97). No emulator: the point
// is the transient-contention path, which a healthy emulator never takes.
// `fetch` is stubbed so the 409 the emulator returns for
// "Transaction lock timeout" can be produced on demand.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { sweepFirestore } from './emulator.js';

const URL_UNDER_TEST = 'http://127.0.0.1:8080/emulator/v1/projects/p/databases/(default)/documents';

const ok = () => new Response('', { status: 200 });
const aborted = () =>
  new Response('{"error":{"code":409,"message":"Transaction lock timeout.","status":"ABORTED"}}', {
    status: 409,
  });

/** Returns the queued responses in order; the last one repeats. */
function stubFetch(...responses: Array<() => Response>) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(init?.method));
    return (responses[Math.min(calls.length - 1, responses.length - 1)] ?? ok)();
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

/** Like {@link stubFetch}, but each response takes `delayMs` to arrive. */
function stubSlowFetch(delayMs: number, response: () => Response) {
  const calls: string[] = [];
  const impl = vi.fn(async () => {
    calls.push('DELETE');
    await new Promise((r) => setTimeout(r, delayMs));
    return response();
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

/**
 * A request that never answers until its abort signal fires — the emulator
 * holding the lock open, which is the case an attempt-count bound misses.
 */
function stubHangingFetch() {
  const calls: string[] = [];
  const impl = vi.fn(
    (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        calls.push('DELETE');
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
        );
      }),
  );
  vi.stubGlobal('fetch', impl);
  return calls;
}

/** Rejects like a transport failure (socket reset), then serves `then`. */
function stubRejectingFetch(rejections: number, then: () => Response) {
  const calls: string[] = [];
  const impl = vi.fn(async () => {
    calls.push('DELETE');
    if (calls.length <= rejections) throw new TypeError('fetch failed');
    return then();
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

describe('sweepFirestore (T-97 retry)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not retry when the sweep succeeds first time', async () => {
    const calls = stubFetch(ok);
    await sweepFirestore(URL_UNDER_TEST);
    expect(calls).toEqual(['DELETE']);
  });

  it('retries a 409 ABORTED and resolves once the lock clears', async () => {
    const calls = stubFetch(aborted, aborted, ok);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sweepFirestore(URL_UNDER_TEST);

    expect(calls).toHaveLength(3);
    // Every retry is announced, plus the "swept on attempt N" line — a
    // retry that held the lock must not be invisible.
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.map(String).join('\n')).toContain('swept on attempt 3');
  });

  it('gives up after a bounded number of attempts, reporting the count and body', async () => {
    const calls = stubFetch(aborted);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(sweepFirestore(URL_UNDER_TEST)).rejects.toThrow(
      /failed after 4 attempt\(s\): 409 .*Transaction lock timeout/,
    );
    // Bounded: it must not spin forever against a lock that never clears.
    expect(calls).toHaveLength(4);
  });

  it('gives up on the wall-clock deadline when contended DELETEs are slow', async () => {
    // The retried condition is itself a *timeout*, so a failing attempt is
    // not necessarily fast. `clearEmulators` runs in `afterEach` under
    // vitest's 10s default `hookTimeout`; without a wall-clock bound, four
    // slow attempts would blow it and report `Hook timed out` against an
    // unrelated test — losing the attempt count and body entirely.
    const calls = stubSlowFetch(120, aborted);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const started = Date.now();
    await expect(sweepFirestore(URL_UNDER_TEST, { deadlineMs: 300 })).rejects.toThrow(
      /failed after \d+ attempt\(s\) \(300ms deadline\): 409/,
    );

    // Stopped early on time, not on the attempt ceiling.
    expect(calls.length).toBeLessThan(4);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('aborts a single attempt that outlives the deadline', async () => {
    // The case an attempt-count bound cannot catch: ONE request the
    // emulator never answers. Without bounding the fetch itself, this
    // would hang past vitest's 10s `hookTimeout` and surface as
    // `Hook timed out` against an unrelated test, with no attempt count.
    const calls = stubHangingFetch();

    const started = Date.now();
    await expect(sweepFirestore(URL_UNDER_TEST, { deadlineMs: 200 })).rejects.toThrow(
      /failed after 1 attempt\(s\) \(200ms deadline\): TimeoutError/,
    );

    expect(calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('keeps the 409 body when the terminal attempt is an abort', async () => {
    // An abort is always terminal, so without carrying the last real
    // response the final error would read as a bare `TimeoutError` and the
    // `Transaction lock timeout` body — the reason the sweep was slow —
    // would be lost. That is the diagnostic this whole change is for.
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        calls.push('DELETE');
        // First answers 409; afterwards hangs until the deadline aborts.
        if (calls.length === 1) return Promise.resolve(aborted());
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
          );
        });
      }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const err = await sweepFirestore(URL_UNDER_TEST, { deadlineMs: 300 }).catch((e: Error) => e);

    expect(String(err)).toMatch(/TimeoutError/);
    expect(String(err)).toMatch(/last response: 409 .*Transaction lock timeout/);
  });

  it('retries a transport failure instead of throwing it raw', async () => {
    // A socket reset rejects rather than returning a status, so it used to
    // bypass the retry entirely and escape as a bare TypeError.
    const calls = stubRejectingFetch(2, ok);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sweepFirestore(URL_UNDER_TEST);

    expect(calls).toHaveLength(3);
  });

  it('does not retry a non-transient status', async () => {
    const calls = stubFetch(() => new Response('nope', { status: 400 }));

    await expect(sweepFirestore(URL_UNDER_TEST)).rejects.toThrow(
      'failed after 1 attempt(s): 400 nope',
    );
    expect(calls).toHaveLength(1);
  });
});
