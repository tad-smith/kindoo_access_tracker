// Pointer-events long-press hook. Fires `onLongPress` when the user
// holds for `thresholdMs` without moving more than ~10px (the standard
// hold-vs-scroll discriminator). Pointer types other than `'touch'` are
// ignored — long-press is a touch-only path; mouse goes through the
// drag-handle. iOS Safari's own context-menu gesture is suppressed by
// `event.preventDefault()` in `pointerdown` plus
// `-webkit-touch-callout: none` on the row in CSS.
//
// Returns props the caller spreads onto the row element. The hook owns
// the timer + movement-cancel logic; callers only react to
// `onLongPress`.

import { useCallback, useEffect, useRef } from 'react';

export interface UseLongPressOpts {
  /** Hold duration before `onLongPress` fires. Default 500ms. */
  thresholdMs?: number;
  /** Movement (px, any axis) that cancels the hold. Default 10. */
  movementThresholdPx?: number;
  /** Fired once when the threshold is reached. */
  onLongPress: () => void;
}

export interface UseLongPressBindings {
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onPointerCancel: (event: React.PointerEvent) => void;
  onPointerLeave: (event: React.PointerEvent) => void;
}

export function useLongPress({
  thresholdMs = 500,
  movementThresholdPx = 10,
  onLongPress,
}: UseLongPressOpts): UseLongPressBindings {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }, []);

  // Always release any pending timer if the host unmounts.
  useEffect(() => cancel, [cancel]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      // Suppress iOS Safari's context-menu gesture.
      event.preventDefault();
      startRef.current = { x: event.clientX, y: event.clientY };
      cancel();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        onLongPress();
      }, thresholdMs);
    },
    [cancel, onLongPress, thresholdMs],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const start = startRef.current;
      if (!start || timerRef.current === null) return;
      const dx = Math.abs(event.clientX - start.x);
      const dy = Math.abs(event.clientY - start.y);
      if (dx > movementThresholdPx || dy > movementThresholdPx) cancel();
    },
    [cancel, movementThresholdPx],
  );

  const onPointerUp = cancel;
  const onPointerCancel = cancel;
  const onPointerLeave = cancel;

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave };
}
