import { useCallback, useEffect, useRef } from "react";

/** How long a touch must rest on a tile to start a selection. */
export const LONG_PRESS_MS = 500;
/** How far a touch may drift before it counts as a scroll instead. */
const MOVE_TOLERANCE_PX = 10;

/**
 * A long press on touch, for starting a selection on a phone.
 *
 * Touch only: a mouse has the hover checkbox, and a held mouse button is how
 * a person drags. A touch that moves past the tolerance is a scroll, and one
 * that lifts early is a tap. When the press fires, the click the browser sends
 * on release is swallowed (`consumeClick`), so the same touch does not also
 * open the photo or toggle it back off.
 */
export function useLongPress(onLongPress: (() => void) | null) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!onLongPress || e.pointerType !== "touch") return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    [onLongPress],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const origin = start.current;
      if (!origin || !timer.current) return;
      if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > MOVE_TOLERANCE_PX) cancel();
    },
    [cancel],
  );

  /** True once, for the click that ends a press that already fired. */
  const consumeClick = useCallback(() => {
    if (!fired.current) return false;
    fired.current = false;
    return true;
  }, []);

  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp: cancel, onPointerCancel: cancel },
    consumeClick,
  };
}
