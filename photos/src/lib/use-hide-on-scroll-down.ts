import { useEffect, useRef, useState } from "react";

/**
 * Scrolling down past this much of the page keeps the header out of the way;
 * above it the header is always shown, so the top of the library never opens
 * with a hidden header.
 */
const ALWAYS_SHOWN_ABOVE_PX = 64;

/**
 * Ignore scrolls smaller than this. Without it the header flickers on the
 * one-pixel jitter of a trackpad, a rubber-band bounce, or the browser's own
 * scroll restoration.
 */
const MOVEMENT_THRESHOLD_PX = 6;

/**
 * Whether a header should currently be slid out of view.
 *
 * Hidden while the viewer scrolls down and shown again the moment they scroll
 * up, which is the phone convention: reading gets the whole screen, and getting
 * the controls back costs one upward flick rather than a trip to the top.
 *
 * Always false when disabled, so a caller can turn the behaviour off by
 * viewport without breaking the rules of hooks — and so the header cannot be
 * left stuck off-screen by a resize that happened mid-scroll.
 */
export function useHideOnScrollDown(enabled: boolean): boolean {
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setHidden(false);
      return;
    }
    lastY.current = window.scrollY;

    const onScroll = () => {
      const y = window.scrollY;
      const delta = y - lastY.current;
      if (Math.abs(delta) < MOVEMENT_THRESHOLD_PX) return;
      lastY.current = y;
      setHidden(y > ALWAYS_SHOWN_ABOVE_PX && delta > 0);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [enabled]);

  return hidden;
}
