// Unit tests for the toast queue store. Covers the enqueue / dismiss /
// auto-dismiss contract that the Apps Script `toast(msg, kind)` helper
// established (`ClientUtils.html#toast`).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore, toast } from './toast';

beforeEach(() => {
  useToastStore.getState().clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('toast store', () => {
  it('enqueues a toast with the default info kind', () => {
    toast('Hello');
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ kind: 'info', message: 'Hello' });
  });

  it('returns a stable id from push so callers can dismiss directly', () => {
    const id = toast('A');
    const toasts = useToastStore.getState().toasts;
    expect(toasts[0]?.id).toBe(id);
  });

  it('dismisses a toast by id', () => {
    const id = toast('A');
    toast('B');
    useToastStore.getState().dismiss(id);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.message).toBe('B');
  });

  it('auto-dismisses an info toast after 3500ms', () => {
    toast('Hello', 'info');
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(3499);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('auto-dismisses a success toast after 3500ms', () => {
    toast('Done', 'success');
    vi.advanceTimersByTime(3500);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('keeps warn / error toasts visible for the longer 6500ms', () => {
    toast('Warning', 'warn');
    toast('Error', 'error');
    vi.advanceTimersByTime(3500);
    // Still up — warn/error use the longer ttl.
    expect(useToastStore.getState().toasts).toHaveLength(2);
    vi.advanceTimersByTime(3000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('clear() removes all toasts and cancels pending timers', () => {
    toast('A');
    toast('B');
    useToastStore.getState().clear();
    expect(useToastStore.getState().toasts).toHaveLength(0);
    // Advancing past the original ttl should not re-add or affect anything.
    vi.advanceTimersByTime(10_000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
