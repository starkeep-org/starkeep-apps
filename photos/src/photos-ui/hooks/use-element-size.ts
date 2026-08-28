import { useCallback, useEffect, useState } from "react";
import type { Dimensions } from "@/photos-lib/render-geometry";

/**
 * Track an element's content width alone.
 *
 * The row layout measures a container that has no height until the rows it is
 * measuring for exist: requiring a positive height there deadlocks, since the
 * element stays empty while it waits to be measured and stays unmeasured while
 * it is empty. Width is what the layout needs and width is available
 * immediately, so this asks for only that.
 *
 * This is the one surface that genuinely has to measure. A grid container's
 * width comes from the page around it, so nothing but the DOM knows it. The
 * viewer's stage, by contrast, is sized from the viewport and the photo's own
 * aspect ratio, so it computes its box rather than observing one.
 */
export function useElementWidth<T extends Element>(): [
  (element: T | null) => void,
  number | null,
] {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const ref = useCallback((next: T | null) => setElement(next), []);

  useEffect(() => {
    if (!element) return;
    const update = (next: number) => {
      if (next > 0) setWidth(next);
    };
    update(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return [ref, width];
}

export function useDevicePixelRatio(): number {
  const read = () => typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const [ratio, setRatio] = useState(read);
  useEffect(() => {
    const update = () => setRatio(read());
    window.addEventListener("resize", update);
    const media = window.matchMedia?.(`(resolution: ${ratio}dppx)`);
    media?.addEventListener?.("change", update, { once: true });
    return () => {
      window.removeEventListener("resize", update);
      media?.removeEventListener?.("change", update);
    };
  }, [ratio]);
  return ratio;
}

/**
 * The viewport, read synchronously and kept current on resize.
 *
 * Same shape as {@link useDevicePixelRatio}, and for the same reason: a value
 * the window already knows needs no observation, and reading it during the
 * first render lets a caller act on it before layout runs rather than a frame
 * later.
 *
 * An unchanged size returns the previous object, so a resize event that does
 * not move the numbers does not re-render.
 */
export function useViewportSize(): Dimensions | null {
  const [size, setSize] = useState<Dimensions | null>(() =>
    typeof window === "undefined" ? null : { width: window.innerWidth, height: window.innerHeight },
  );
  useEffect(() => {
    const update = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      setSize((previous) =>
        previous && previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    // A server-rendered first pass starts at null, so read once on mount.
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return size;
}
