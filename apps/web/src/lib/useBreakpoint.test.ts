// Unit tests for `useBreakpoint`. We stub `window.matchMedia` with a
// minimal MediaQueryList substitute that exposes `matches` and a
// listener registry, so we can simulate breakpoint crossings without
// actually resizing jsdom (which doesn't honor `(min-width: ...)`).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBreakpoint } from './useBreakpoint';

interface FakeMql {
  query: string;
  matches: boolean;
  listeners: Array<(ev: { matches: boolean }) => void>;
  addEventListener: (type: 'change', cb: (ev: { matches: boolean }) => void) => void;
  removeEventListener: (type: 'change', cb: (ev: { matches: boolean }) => void) => void;
}

const QUERY_DESKTOP = '(min-width: 1024px)';
const QUERY_TABLET = '(min-width: 640px)';

let queries: Map<string, FakeMql>;

function setMatches(query: string, matches: boolean): void {
  const mql = queries.get(query);
  if (!mql) return;
  mql.matches = matches;
}

function fire(query: string): void {
  const mql = queries.get(query);
  if (!mql) return;
  for (const cb of mql.listeners) cb({ matches: mql.matches });
}

beforeEach(() => {
  queries = new Map();
  for (const q of [QUERY_DESKTOP, QUERY_TABLET]) {
    queries.set(q, {
      query: q,
      matches: q === QUERY_DESKTOP, // desktop by default
      listeners: [],
      addEventListener(type, cb) {
        if (type === 'change') this.listeners.push(cb);
      },
      removeEventListener(type, cb) {
        if (type === 'change') this.listeners = this.listeners.filter((l) => l !== cb);
      },
    });
  }
  window.matchMedia = ((query: string) => {
    const existing = queries.get(query);
    if (existing) return existing as unknown as MediaQueryList;
    // Defensive default for unrelated queries.
    const empty: FakeMql = {
      query,
      matches: false,
      listeners: [],
      addEventListener() {},
      removeEventListener() {},
    };
    return empty as unknown as MediaQueryList;
  }) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  // jsdom restores cleanly between tests.
});

describe('useBreakpoint', () => {
  it('starts at desktop when the desktop media query matches', () => {
    setMatches(QUERY_DESKTOP, true);
    setMatches(QUERY_TABLET, true);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe('desktop');
  });

  it('starts at tablet when only the tablet query matches', () => {
    setMatches(QUERY_DESKTOP, false);
    setMatches(QUERY_TABLET, true);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe('tablet');
  });

  it('starts at phone when neither query matches', () => {
    setMatches(QUERY_DESKTOP, false);
    setMatches(QUERY_TABLET, false);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe('phone');
  });

  it('updates when crossing from desktop down to tablet', () => {
    setMatches(QUERY_DESKTOP, true);
    setMatches(QUERY_TABLET, true);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe('desktop');

    act(() => {
      setMatches(QUERY_DESKTOP, false);
      setMatches(QUERY_TABLET, true);
      fire(QUERY_DESKTOP);
    });
    expect(result.current).toBe('tablet');
  });

  it('updates when crossing from tablet down to phone', () => {
    setMatches(QUERY_DESKTOP, false);
    setMatches(QUERY_TABLET, true);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe('tablet');

    act(() => {
      setMatches(QUERY_DESKTOP, false);
      setMatches(QUERY_TABLET, false);
      fire(QUERY_TABLET);
    });
    expect(result.current).toBe('phone');
  });

  it('does not change when both queries fire but neither boundary actually crossed', () => {
    setMatches(QUERY_DESKTOP, true);
    setMatches(QUERY_TABLET, true);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe('desktop');

    // Simulate noisy resize events that don't actually change the
    // matched state — `matchMedia` listeners normally don't fire in
    // this case, but if they did, `useBreakpoint` should re-read and
    // remain stable.
    act(() => {
      fire(QUERY_DESKTOP);
      fire(QUERY_TABLET);
    });
    expect(result.current).toBe('desktop');
  });

  it('crossing from phone up to desktop reports desktop', () => {
    setMatches(QUERY_DESKTOP, false);
    setMatches(QUERY_TABLET, false);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe('phone');

    act(() => {
      setMatches(QUERY_DESKTOP, true);
      setMatches(QUERY_TABLET, true);
      fire(QUERY_DESKTOP);
      fire(QUERY_TABLET);
    });
    expect(result.current).toBe('desktop');
  });
});
