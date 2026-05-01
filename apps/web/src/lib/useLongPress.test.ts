// Unit tests for the long-press hook. Pointer-event simulation goes
// through React's synthetic-event types; we cast minimally where the
// type system needs help.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLongPress } from './useLongPress';

function pointerEvent(
  pointerType: 'touch' | 'mouse',
  clientX = 0,
  clientY = 0,
): React.PointerEvent {
  const preventDefault = vi.fn();
  return {
    pointerType,
    clientX,
    clientY,
    preventDefault,
  } as unknown as React.PointerEvent;
}

describe('useLongPress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onLongPress after the threshold for a touch hold', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, thresholdMs: 500 }));
    act(() => {
      result.current.onPointerDown(pointerEvent('touch', 10, 10));
    });
    expect(onLongPress).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('does not fire when the user releases before the threshold', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, thresholdMs: 500 }));
    act(() => {
      result.current.onPointerDown(pointerEvent('touch', 0, 0));
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.onPointerUp(pointerEvent('touch', 0, 0));
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels the hold when movement exceeds the scroll-discriminator threshold', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useLongPress({ onLongPress, thresholdMs: 500, movementThresholdPx: 10 }),
    );
    act(() => {
      result.current.onPointerDown(pointerEvent('touch', 0, 0));
    });
    act(() => {
      result.current.onPointerMove(pointerEvent('touch', 20, 0));
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('ignores mouse-pointer events (mouse goes through the drag handle)', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, thresholdMs: 500 }));
    act(() => {
      result.current.onPointerDown(pointerEvent('mouse', 0, 0));
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels the hold on pointercancel', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, thresholdMs: 500 }));
    act(() => {
      result.current.onPointerDown(pointerEvent('touch', 0, 0));
    });
    act(() => {
      result.current.onPointerCancel(pointerEvent('touch', 0, 0));
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
