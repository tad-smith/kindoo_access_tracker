// Unit tests for the SW → SPA notification-click bridge. Mocks
// `navigator.serviceWorker` with a minimal EventTarget so we can
// dispatch synthetic `message` events and assert the router was
// called with the expected target path.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerNotificationClickRouter, type RouterLike } from '../serviceWorkerMessenger';

interface FakeServiceWorkerContainer extends EventTarget {
  // No additional surface needed — registerNotificationClickRouter
  // only uses addEventListener / removeEventListener.
}

const originalServiceWorker = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(navigator) as object,
  'serviceWorker',
);

function installFakeServiceWorker(): FakeServiceWorkerContainer {
  const container = new EventTarget() as FakeServiceWorkerContainer;
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: container,
  });
  return container;
}

function uninstallServiceWorker() {
  if (originalServiceWorker) {
    Object.defineProperty(
      Object.getPrototypeOf(navigator) as object,
      'serviceWorker',
      originalServiceWorker,
    );
  }
  // Clean up the instance-level override we set in installFakeServiceWorker.
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
}

function makeRouter(): RouterLike & { pushed: string[] } {
  const pushed: string[] = [];
  return {
    history: {
      push: (path: string) => {
        pushed.push(path);
      },
    },
    pushed,
  };
}

function fireMessage(container: FakeServiceWorkerContainer, data: unknown) {
  const event = new MessageEvent('message', { data });
  container.dispatchEvent(event);
}

describe('registerNotificationClickRouter', () => {
  let container: FakeServiceWorkerContainer;

  beforeEach(() => {
    container = installFakeServiceWorker();
  });

  afterEach(() => {
    uninstallServiceWorker();
  });

  it('routes to the target when a valid notification-click message arrives', () => {
    const router = makeRouter();
    registerNotificationClickRouter(router);
    fireMessage(container, {
      type: 'kindoo:notification-click',
      target: '/manager/queue?focus=req-123',
    });
    expect(router.pushed).toEqual(['/manager/queue?focus=req-123']);
  });

  it('ignores messages with an unrecognised type', () => {
    const router = makeRouter();
    registerNotificationClickRouter(router);
    fireMessage(container, { type: 'workbox-update', target: '/manager/queue' });
    expect(router.pushed).toEqual([]);
  });

  it('ignores messages whose target is not a string', () => {
    const router = makeRouter();
    registerNotificationClickRouter(router);
    fireMessage(container, { type: 'kindoo:notification-click', target: 42 });
    expect(router.pushed).toEqual([]);
  });

  it('ignores messages whose target is empty or lacks the leading slash', () => {
    const router = makeRouter();
    registerNotificationClickRouter(router);
    fireMessage(container, { type: 'kindoo:notification-click', target: '' });
    fireMessage(container, { type: 'kindoo:notification-click', target: 'manager/queue' });
    fireMessage(container, { type: 'kindoo:notification-click', target: 'https://evil.example/' });
    expect(router.pushed).toEqual([]);
  });

  it('ignores messages with a non-object payload', () => {
    const router = makeRouter();
    registerNotificationClickRouter(router);
    fireMessage(container, null);
    fireMessage(container, undefined);
    fireMessage(container, 'kindoo:notification-click');
    expect(router.pushed).toEqual([]);
  });

  it('routes consecutive valid messages without re-registering', () => {
    const router = makeRouter();
    registerNotificationClickRouter(router);
    fireMessage(container, { type: 'kindoo:notification-click', target: '/manager/queue' });
    fireMessage(container, {
      type: 'kindoo:notification-click',
      target: '/manager/queue?focus=abc',
    });
    expect(router.pushed).toEqual(['/manager/queue', '/manager/queue?focus=abc']);
  });

  it('returns a teardown function that detaches the listener', () => {
    const router = makeRouter();
    const teardown = registerNotificationClickRouter(router);
    teardown();
    fireMessage(container, {
      type: 'kindoo:notification-click',
      target: '/manager/queue',
    });
    expect(router.pushed).toEqual([]);
  });

  it('is a no-op when navigator.serviceWorker is unavailable', () => {
    uninstallServiceWorker();
    const router = makeRouter();
    // Should not throw, returns a teardown that's also a no-op.
    const teardown = registerNotificationClickRouter(router);
    expect(typeof teardown).toBe('function');
    expect(() => teardown()).not.toThrow();
    expect(router.pushed).toEqual([]);
  });
});
