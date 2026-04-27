// Vitest setup. Loaded once before tests run; pulls in jest-dom matchers
// (toBeInTheDocument, toHaveTextContent, etc.) so RTL tests across the
// app can use them without re-importing.

import '@testing-library/jest-dom/vitest';
