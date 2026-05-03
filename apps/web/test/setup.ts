// Vitest setup. Loaded once before tests run; pulls in jest-dom matchers
// (toBeInTheDocument, toHaveTextContent, etc.) so RTL tests across the
// app can use them without re-importing.

import '@testing-library/jest-dom/vitest';

// jsdom does not implement `ResizeObserver`. Several Radix primitives
// (`@radix-ui/react-switch` via `react-use-size`, etc.) construct one
// during their layout effect. Stub a no-op so component tests that
// mount Switch / Popover / Tooltip do not blow up. Production code is
// unaffected.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
