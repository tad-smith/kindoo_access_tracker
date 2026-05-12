// Vitest setup. Loaded once before tests run.
//
// Pulls in jest-dom matchers (toBeInTheDocument, toHaveTextContent, etc.)
// and installs a minimal `chrome.*` global so any module that touches
// the Chrome API surface during import does not blow up under jsdom.
// Tests that exercise the Chrome boundary override these stubs via
// vi.spyOn / vi.fn().

import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// The `chrome` global is declared by `@types/chrome`. Under jsdom it
// is undefined at runtime; install a minimal stub so any import-time
// access to e.g. `chrome.runtime.lastError` does not throw. Tests
// that exercise the Chrome boundary override these via vi.spyOn /
// vi.fn().
(globalThis as unknown as { chrome: unknown }).chrome = {
  identity: {
    getAuthToken: vi.fn(),
    removeCachedAuthToken: vi.fn(),
  },
  runtime: {
    lastError: undefined,
    onInstalled: { addListener: vi.fn() },
  },
  sidePanel: {
    setPanelBehavior: vi.fn(),
  },
  storage: {
    local: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
    },
  },
};
