// Tests for the navigator.onLine wrapper hook. Verifies it tracks the
// `online` / `offline` window events that the SPA's offline indicator
// reacts to.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useOnlineStatus } from './useOnlineStatus';

const originalOnline = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

describe('useOnlineStatus', () => {
  beforeEach(() => {
    setNavigatorOnline(true);
  });

  afterEach(() => {
    if (originalOnline) {
      Object.defineProperty(window.navigator, 'onLine', originalOnline);
    }
  });

  it('initialises from navigator.onLine', () => {
    setNavigatorOnline(false);
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(false);
  });

  it('flips to false on offline event', () => {
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current).toBe(false);
  });

  it('flips back to true on online event', () => {
    setNavigatorOnline(false);
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(false);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current).toBe(true);
  });
});
