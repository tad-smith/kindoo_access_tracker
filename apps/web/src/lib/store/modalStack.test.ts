// Unit tests for the modal-stack store.

import { beforeEach, describe, expect, it } from 'vitest';
import { useModalStackStore } from './modalStack';

beforeEach(() => {
  // Reset state between tests.
  useModalStackStore.setState({ open: [] });
});

describe('modal stack store', () => {
  it('reports nothing open initially', () => {
    expect(useModalStackStore.getState().isOpen()).toBe(false);
    expect(useModalStackStore.getState().topId()).toBe(null);
  });

  it('pushes ids and reports the topmost', () => {
    useModalStackStore.getState().push('a');
    useModalStackStore.getState().push('b');
    expect(useModalStackStore.getState().topId()).toBe('b');
    expect(useModalStackStore.getState().isOpen()).toBe(true);
    expect(useModalStackStore.getState().isOpen('a')).toBe(true);
    expect(useModalStackStore.getState().isOpen('c')).toBe(false);
  });

  it('pops a specific id and preserves the rest of the stack', () => {
    useModalStackStore.getState().push('a');
    useModalStackStore.getState().push('b');
    useModalStackStore.getState().push('c');
    useModalStackStore.getState().pop('b');
    expect(useModalStackStore.getState().open).toEqual(['a', 'c']);
    expect(useModalStackStore.getState().topId()).toBe('c');
  });

  it('does not duplicate a re-pushed id; instead promotes it to the top', () => {
    useModalStackStore.getState().push('a');
    useModalStackStore.getState().push('b');
    useModalStackStore.getState().push('a');
    expect(useModalStackStore.getState().open).toEqual(['b', 'a']);
    expect(useModalStackStore.getState().topId()).toBe('a');
  });
});
