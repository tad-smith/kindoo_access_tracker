// Unit tests for `sweepFirestore`'s retry (T-97). No emulator: the point
// is the transient-contention path, which a healthy emulator never takes.
// `fetch` is stubbed so the 409 the emulator returns for
// "Transaction lock timeout" can be produced on demand.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetSweepLatch, sweepFirestore } from './emulator.js';

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

/**
 * undici's shape for a transport failure. The `cause.message` values are
 * the ones actually observed on Node 22.22.2 — an earlier version of this
 * helper invented them, which is how a code set undici never emits passed
 * its own tests.
 */
const UNDICI_CAUSE_MESSAGES: Record<string, string> = {
  ECONNREFUSED: 'connect ECONNREFUSED 127.0.0.1:8080',
  ECONNRESET: 'read ECONNRESET',
  UND_ERR_SOCKET: 'other side closed',
};
function transportError(code: string) {
  const cause = Object.assign(new Error(UNDICI_CAUSE_MESSAGES[code] ?? code), { code });
  return new TypeError('fetch failed', { cause });
}

/**
 * Answers 409 once, then hangs until the deadline aborts — the slow-
 * contention shape, which terminates on the DEADLINE rather than the
 * attempt ceiling. The only stub that reaches the latch's guarded branch.
 */
function stubAnsweredThenHanging() {
  const calls: string[] = [];
  const impl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
    calls.push('DELETE');
    if (calls.length === 1) return Promise.resolve(aborted());
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      );
    });
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

/** Rejects `rejections` times with `err()`, then serves `then`. */
function stubRejectingFetch(rejections: number, err: () => Error, then: () => Response) {
  const calls: string[] = [];
  const impl = vi.fn(async () => {
    calls.push('DELETE');
    if (calls.length <= rejections) throw err();
    return then();
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

describe('sweepFirestore (T-97 retry)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // The give-up latch is module state; a case that exhausts the budget
    // would otherwise short-circuit every case after it.
    _resetSweepLatch();
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

  it('retries a dropped connection instead of throwing it raw', async () => {
    // A socket reset rejects rather than returning a status, so it used to
    // bypass the retry entirely and escape as a bare TypeError.
    const calls = stubRejectingFetch(2, () => transportError('ECONNRESET'), ok);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sweepFirestore(URL_UNDER_TEST);

    expect(calls).toHaveLength(3);
  });

  it('retries UND_ERR_SOCKET — the shape a pooled connection actually produces', async () => {
    // A graceful FIN mid-request: realistic for ~500 sequential DELETEs to
    // an emulator with its own idle timeout, and not a Node socket errno,
    // so the first version of the classifier fell through to fail-fast.
    const calls = stubRejectingFetch(1, () => transportError('UND_ERR_SOCKET'), ok);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sweepFirestore(URL_UNDER_TEST);

    expect(calls).toHaveLength(2);
  });

  it('fails fast when nothing is listening, and still reports the address', async () => {
    // The Firestore emulator gone while Auth is still up. Retrying costs
    // ~700ms per call across ~500 `clearEmulators` calls — ~6 minutes added
    // to a run that is already red. It must cost one attempt.
    const calls = stubRejectingFetch(99, () => transportError('ECONNREFUSED'), ok);

    const err = await sweepFirestore(URL_UNDER_TEST).catch((e: Error) => e);

    expect(String(err)).toMatch(/failed after 1 attempt\(s\): TypeError: fetch failed/);
    // `fetch failed` alone is less than the raw throw used to print. The
    // errno and address must survive, in the message and as a cause.
    expect(String(err)).toContain('connect ECONNREFUSED 127.0.0.1:8080');
    expect(((err as Error).cause as { cause?: { code?: string } })?.cause?.code).toBe(
      'ECONNREFUSED',
    );
    // One request IS the fail-fast assertion; a wall-clock bound here would
    // add the tightest timing check in the suite for no extra coverage.
    expect(calls).toHaveLength(1);
  });

  it('fails fast on a programming error, not four times', async () => {
    // The example the docs used to give for the fail-fast branch was "a 400
    // from a malformed URL" — but a malformed URL does not produce a 400,
    // it throws, and before this it was retried four times.
    const calls = stubRejectingFetch(99, () => new TypeError('Failed to parse URL'), ok);

    await expect(sweepFirestore('not-a-url')).rejects.toThrow(
      /failed after 1 attempt\(s\): TypeError: Failed to parse URL/,
    );
    expect(calls).toHaveLength(1);
  });

  it('does not retry a non-transient status', async () => {
    const calls = stubFetch(() => new Response('nope', { status: 400 }));

    await expect(sweepFirestore(URL_UNDER_TEST)).rejects.toThrow(
      'failed after 1 attempt(s): 400 nope',
    );
    expect(calls).toHaveLength(1);
  });

  it('short-circuits only after TWO consecutive silent sweeps', async () => {
    // Every hook in the file paying the full budget against a hung
    // emulator is the runaway this guards. But one silent sweep is not
    // evidence: a single contended DELETE slower than the budget looks
    // identical from inside one call, and arming on it would red the file
    // with a wrong cause.
    stubHangingFetch();
    await expect(sweepFirestore(URL_UNDER_TEST, { deadlineMs: 120 })).rejects.toThrow(
      /failed after 1 attempt/,
    );

    // Strike one only — this must still make a real request.
    const second = stubHangingFetch();
    await expect(sweepFirestore(URL_UNDER_TEST, { deadlineMs: 120 })).rejects.toThrow(
      /failed after 1 attempt/,
    );
    expect(second).toHaveLength(1);

    // Strike two reached: now it short-circuits.
    const third = stubHangingFetch();
    await expect(sweepFirestore(URL_UNDER_TEST, { deadlineMs: 120 })).rejects.toThrow(
      /skipped: 2 consecutive sweeps exhausted their budget with no response/,
    );
    expect(third).toHaveLength(0);
  });

  it('resets the strike count when a sweep succeeds', async () => {
    // Needs FOUR calls to discriminate. An earlier version of this test
    // stopped at three and so passed identically with and without the
    // reset — the assertion only bites once the counter would have hit 2.
    stubHangingFetch();
    await expect(sweepFirestore(URL_UNDER_TEST, { deadlineMs: 120 })).rejects.toThrow(/failed/);

    stubFetch(ok);
    await sweepFirestore(URL_UNDER_TEST);

    stubHangingFetch();
    await expect(sweepFirestore(URL_UNDER_TEST, { deadlineMs: 120 })).rejects.toThrow(/failed/);

    // Two strikes have now occurred, but NOT consecutively, so this must
    // still make a real request rather than short-circuit.
    const fourth = stubHangingFetch();
    await expect(sweepFirestore(URL_UNDER_TEST, { deadlineMs: 120 })).rejects.toThrow(
      /failed after 1 attempt/,
    );
    expect(fourth).toHaveLength(1);
  });

  it('reports the errno when the cause message is empty (localhost)', async () => {
    // Resolving through `localhost` makes undici's cause an AggregateError
    // whose `message` is '' while `code` still says ECONNREFUSED. Preferring
    // the blank message drops the errno and reports `fetch failed` alone.
    const emptyCause = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    stubRejectingFetch(99, () => new TypeError('fetch failed', { cause: emptyCause }), ok);

    const err = await sweepFirestore(URL_UNDER_TEST).catch((e: Error) => e);

    expect(String(err)).toContain('ECONNREFUSED');
  });

  it('never latches while the emulator keeps answering, however slowly', async () => {
    // The guard that matters most, and the only test that reaches it.
    // Every other case here terminates on the ATTEMPT CEILING, where
    // `outOfTime` is false and the latch branch is skipped entirely — so
    // deleting both guards leaves the rest of the suite green.
    //
    // This is the T-97 scenario at its worst: a contended DELETE answers
    // 409 and the retry then runs out of budget. Repeated, it must never
    // short-circuit — otherwise one slow file reds wholesale, every hook
    // claiming the emulator is not answering while it demonstrably is.
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (let sweep = 1; sweep <= 2; sweep++) {
      stubAnsweredThenHanging();
      await expect(sweepFirestore(URL_UNDER_TEST, { deadlineMs: 250 })).rejects.toThrow(
        /deadline\): TimeoutError.*last response: 409/s,
      );
    }

    const third = stubAnsweredThenHanging();
    await expect(sweepFirestore(URL_UNDER_TEST, { deadlineMs: 250 })).rejects.toThrow(
      /last response: 409 .*Transaction lock timeout/,
    );
    // Still talking to the emulator, not short-circuiting on a stale latch.
    expect(third.length).toBeGreaterThan(0);
  });

  it('counts a response as contact even when its body read aborts', async () => {
    // `res.text()` streams under the same signal, so a 409 whose body lands
    // near the deadline aborts mid-read. If contact were recorded after the
    // read, an emulator that demonstrably answered would count as silence
    // and two such sweeps would arm the latch.
    const answerThenStallBody = () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_input: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(
                  new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
                ),
              );
              // Headers arrive; the body never does. The stream errors on
              // abort, which is how a real fetch body behaves — a
              // hand-built Response is not wired to the signal otherwise,
              // and `res.text()` would simply hang forever.
              resolve(
                new Response(
                  new ReadableStream({
                    start(controller) {
                      init?.signal?.addEventListener('abort', () =>
                        controller.error(
                          new DOMException(
                            'The operation was aborted due to timeout',
                            'TimeoutError',
                          ),
                        ),
                      );
                    },
                  }),
                  { status: 409 },
                ),
              );
            }),
        ),
      );
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (let sweep = 1; sweep <= 3; sweep++) {
      answerThenStallBody();
      const err = await sweepFirestore(URL_UNDER_TEST, { deadlineMs: 200 }).catch((e: Error) => e);
      // Never the latch message: the emulator answered every time.
      expect(String(err)).not.toMatch(/consecutive sweeps/);
      expect(String(err)).toMatch(/last response: 409/);
    }
  });

  it('does NOT latch on transport drops that eat the budget — flappy is not hung', async () => {
    // Must be SLOW drops. Quick ones finish inside the budget, so
    // `outOfTime` is false and the latch branch is never entered at all —
    // an earlier version of this test used those and therefore could not
    // fail however the guards were written.
    // Signal-aware, and that matters: once the remaining budget is shorter
    // than the drop delay the ABORT wins the race, so later attempts
    // terminate as `TimeoutError` rather than `ECONNRESET`. A stub that
    // ignored `init.signal` would model a race that cannot happen and hide
    // whether the guard works at all.
    const slowDrop = () => {
      const calls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_input: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              calls.push('DELETE');
              const timer = setTimeout(() => reject(transportError('ECONNRESET')), 160);
              init?.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(
                  new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
                );
              });
            }),
        ),
      );
      return calls;
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (let sweep = 1; sweep <= 2; sweep++) {
      slowDrop();
      await expect(sweepFirestore(URL_UNDER_TEST, { deadlineMs: 300 })).rejects.toThrow(/failed/);
    }

    // Two budget-eating sweeps, but a connection existed and broke each
    // time — evidence of life, so no strike however the sweep terminated.
    const third = slowDrop();
    await expect(sweepFirestore(URL_UNDER_TEST, { deadlineMs: 300 })).rejects.toThrow(/failed/);
    expect(third.length).toBeGreaterThan(0);
  });

  it('does NOT latch when the emulator answered — the T-97 case itself', async () => {
    // A slow contended DELETE answers 409 and can still run out of budget.
    // Latching there would turn one failed test into a failed file, every
    // one of them claiming "the emulator is not answering" when it was.
    stubFetch(aborted);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(sweepFirestore(URL_UNDER_TEST)).rejects.toThrow(/failed after 4 attempt/);

    // The next sweep must still make a real request and be able to succeed.
    const calls = stubFetch(ok);
    await sweepFirestore(URL_UNDER_TEST);
    expect(calls).toHaveLength(1);
  });
});
