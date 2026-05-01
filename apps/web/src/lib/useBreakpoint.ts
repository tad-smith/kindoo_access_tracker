// Breakpoint hook backed by `matchMedia`. Three modes — `phone`
// (<640px), `tablet` (640–1023px), `desktop` (>=1024px) — matching
// Tailwind's `sm` and `lg` cutoffs (see `docs/navigation-redesign.md`
// §3). The hook fires once per breakpoint crossing, never on
// resizes-within-a-breakpoint, so callers can wire side-effects
// (closing a panel, dismissing a drawer) to crossings only.

import { useEffect, useState } from 'react';

export type Breakpoint = 'phone' | 'tablet' | 'desktop';

const QUERY_DESKTOP = '(min-width: 1024px)';
const QUERY_TABLET = '(min-width: 640px)';

function readBreakpoint(): Breakpoint {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'desktop';
  }
  if (window.matchMedia(QUERY_DESKTOP).matches) return 'desktop';
  if (window.matchMedia(QUERY_TABLET).matches) return 'tablet';
  return 'phone';
}

/**
 * Reactive breakpoint. Re-renders only on breakpoint crossings, not on
 * intra-breakpoint resizes — `matchMedia` change events fire exactly
 * once per query boundary cross.
 */
export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(() => readBreakpoint());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const desktop = window.matchMedia(QUERY_DESKTOP);
    const tablet = window.matchMedia(QUERY_TABLET);
    const handler = () => {
      setBp(readBreakpoint());
    };
    desktop.addEventListener('change', handler);
    tablet.addEventListener('change', handler);
    // Sync once on mount in case SSR / hydration disagrees.
    handler();
    return () => {
      desktop.removeEventListener('change', handler);
      tablet.removeEventListener('change', handler);
    };
  }, []);

  return bp;
}
