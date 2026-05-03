// Pure-helper tests. The browser-specific helpers (`pushSupportStatus`,
// `currentPermission`) are exercised under jsdom; the localStorage and
// crypto.randomUUID paths are covered by `getDeviceId`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentPermission, getDeviceId, getVapidPublicKey, pushSupportStatus } from '../lib';

describe('getDeviceId', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns the same id across calls in the same browser', () => {
    const a = getDeviceId();
    const b = getDeviceId();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generates a fresh id when localStorage is empty', () => {
    const a = getDeviceId();
    localStorage.clear();
    const b = getDeviceId();
    expect(a).not.toBe(b);
  });
});

describe('pushSupportStatus', () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;
  const originalSwDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

  afterEach(() => {
    if (originalNotification === undefined) {
      delete (globalThis as { Notification?: unknown }).Notification;
    } else {
      (globalThis as { Notification?: unknown }).Notification = originalNotification;
    }
    if (originalSwDescriptor) {
      Object.defineProperty(navigator, 'serviceWorker', originalSwDescriptor);
    } else {
      delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    }
  });

  it('returns "unsupported" when the Notification API is missing', () => {
    delete (globalThis as { Notification?: unknown }).Notification;
    expect(pushSupportStatus()).toBe('unsupported');
  });

  it('returns "supported" on a non-iOS UA when Notification + ServiceWorker are present', () => {
    (globalThis as { Notification?: unknown }).Notification = { permission: 'default' };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register: () => Promise.resolve({}) },
    });
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () => 'Mozilla/5.0 (X11; Linux x86_64)',
    });
    expect(pushSupportStatus()).toBe('supported');
  });

  it('returns "requires-install" on iOS Safari outside standalone mode', () => {
    (globalThis as { Notification?: unknown }).Notification = { permission: 'default' };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register: () => Promise.resolve({}) },
    });
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari',
    });
    // Default jsdom matchMedia returns matches=false; navigator.standalone is undefined.
    expect(pushSupportStatus()).toBe('requires-install');
  });
});

describe('currentPermission', () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;

  afterEach(() => {
    if (originalNotification === undefined) {
      delete (globalThis as { Notification?: unknown }).Notification;
    } else {
      (globalThis as { Notification?: unknown }).Notification = originalNotification;
    }
  });

  it('returns "unsupported" when the API is missing', () => {
    delete (globalThis as { Notification?: unknown }).Notification;
    expect(currentPermission()).toBe('unsupported');
  });

  it('mirrors Notification.permission when present', () => {
    (globalThis as { Notification?: unknown }).Notification = { permission: 'granted' };
    expect(currentPermission()).toBe('granted');
  });
});

describe('getVapidPublicKey', () => {
  it('returns null when the env var is empty', () => {
    vi.stubEnv('VITE_FCM_VAPID_PUBLIC_KEY', '');
    expect(getVapidPublicKey()).toBeNull();
    vi.unstubAllEnvs();
  });

  it('returns the value when the env var is set', () => {
    vi.stubEnv('VITE_FCM_VAPID_PUBLIC_KEY', 'BTestKey123');
    expect(getVapidPublicKey()).toBe('BTestKey123');
    vi.unstubAllEnvs();
  });
});
