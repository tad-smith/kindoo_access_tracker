// Unit tests for the pure completion-note resolver that backs
// `useCompleteRemoveRequest`. The full mutation runs inside a Firestore
// transaction and is covered end-to-end by the E2E suite; the resolver
// is the load-bearing piece worth a fast, isolated test.

import { describe, expect, it } from 'vitest';
import { R1_AUTO_NOTE, resolveRemoveCompletionNote } from './hooks';

describe('resolveRemoveCompletionNote', () => {
  it('returns undefined when the seat still exists and the manager left no note', () => {
    expect(resolveRemoveCompletionNote(true, undefined)).toBeUndefined();
    expect(resolveRemoveCompletionNote(true, '')).toBeUndefined();
    expect(resolveRemoveCompletionNote(true, '   ')).toBeUndefined();
  });

  it('returns the trimmed manager note when the seat still exists', () => {
    expect(resolveRemoveCompletionNote(true, '  Removed manually.  ')).toBe('Removed manually.');
  });

  it('returns the R-1 auto-note alone when the seat is gone and no manager note is supplied', () => {
    expect(resolveRemoveCompletionNote(false, undefined)).toBe(R1_AUTO_NOTE);
    expect(resolveRemoveCompletionNote(false, '')).toBe(R1_AUTO_NOTE);
    expect(resolveRemoveCompletionNote(false, '   ')).toBe(R1_AUTO_NOTE);
  });

  it('preserves the manager note alongside the R-1 system tag on the race case', () => {
    const merged = resolveRemoveCompletionNote(false, '  Already cleared in LCR.  ');
    expect(merged).toBe(`Already cleared in LCR.\n\n[System: ${R1_AUTO_NOTE}]`);
  });
});
