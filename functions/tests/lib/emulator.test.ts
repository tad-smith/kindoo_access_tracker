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

  it('does not retry a non-transient status', async () => {
    const calls = stubFetch(() => new Response('nope', { status: 400 }));

    await expect(sweepFirestore(URL_UNDER_TEST)).rejects.toThrow(
      'failed after 1 attempt(s): 400 nope',
    );
    expect(calls).toHaveLength(1);
  });
});
