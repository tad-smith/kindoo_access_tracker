// Unit tests for `activateAndReload` — the controllerchange-independent
// update path behind the "Update now" prompt. We stub a minimal
// ServiceWorkerRegistration whose `waiting` worker we can drive to
// `activated`, and assert: skip-waiting is posted, the page reloads once
// when the worker activates, the timeout fallback reloads if it never
// does, the no-waiting-worker path still reloads, and reload fires at most
// once even if both `activated` and the timeout occur.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { activateAndReload } from './useServiceWorker';

interface FakeWaiting {
  worker: ServiceWorker;
  /** Move the worker to a new state and fire `statechange`. */
  setState: (state: ServiceWorkerState) => void;
  postedMessages: unknown[];
}

function makeWaitingWorker(initialState: ServiceWorkerState = 'installed'): FakeWaiting {
  const listeners = new Map<string, Set<EventListener>>();
  const postedMessages: unknown[] = [];
  let state = initialState;

  const worker = {
    get state() {
      return state;
    },
    postMessage(message: unknown) {
      postedMessages.push(message);
    },
    addEventListener(type: string, listener: EventListener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as ServiceWorker;

  function setState(next: ServiceWorkerState) {
    state = next;
    for (const l of listeners.get('statechange') ?? []) {
      l(new Event('statechange'));
    }
  }

  return { worker, setState, postedMessages };
}

function makeRegistration(waiting: ServiceWorker | null): ServiceWorkerRegistration {
  return { waiting } as unknown as ServiceWorkerRegistration;
}

describe('activateAndReload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts SKIP_WAITING to the waiting worker and reloads when it activates', async () => {
    const fake = makeWaitingWorker();
    const reload = vi.fn();
    const promise = activateAndReload(makeRegistration(fake.worker), reload, 2000);

    // Skip-waiting message is posted synchronously.
    expect(fake.postedMessages).toEqual([{ type: 'SKIP_WAITING' }]);
    // No reload yet — still waiting for activation.
    expect(reload).not.toHaveBeenCalled();

    fake.setState('activated');
    await promise;

    expect(reload).toHaveBeenCalledOnce();
  });

  it('reloads via the timeout fallback if the worker never activates', async () => {
    const fake = makeWaitingWorker();
    const reload = vi.fn();
    const promise = activateAndReload(makeRegistration(fake.worker), reload, 2000);

    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(reload).toHaveBeenCalledOnce();
  });

  it('reloads exactly once when both activation and the timeout occur', async () => {
    const fake = makeWaitingWorker();
    const reload = vi.fn();
    const promise = activateAndReload(makeRegistration(fake.worker), reload, 2000);

    fake.setState('activated');
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(reload).toHaveBeenCalledOnce();
  });

  it('reloads immediately when there is no waiting worker', async () => {
    const reload = vi.fn();
    await activateAndReload(makeRegistration(null), reload, 2000);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('reloads immediately when the registration is undefined', async () => {
    const reload = vi.fn();
    await activateAndReload(undefined, reload, 2000);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not reload on an intermediate (non-activated) statechange', async () => {
    const fake = makeWaitingWorker();
    const reload = vi.fn();
    const promise = activateAndReload(makeRegistration(fake.worker), reload, 2000);

    fake.setState('activating');
    expect(reload).not.toHaveBeenCalled();

    fake.setState('activated');
    await promise;
    expect(reload).toHaveBeenCalledOnce();
  });
});
