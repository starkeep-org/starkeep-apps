import { useCallback, useEffect, useState } from "react";
import type { Dimensions } from "@/photos-lib/render-geometry";

export function useElementSize<T extends Element>(): [
  (element: T | null) => void,
  Dimensions | null,
] {
  const [element, setElement] = useState<T | null>(null);
  const [size, setSize] = useState<Dimensions | null>(null);
  const ref = useCallback((next: T | null) => setElement(next), []);

  useEffect(() => {
    if (!element) return;
    const update = (width: number, height: number) => {
      if (width > 0 && height > 0) setSize({ width, height });
    };
    const rect = element.getBoundingClientRect();
    update(rect.width, rect.height);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return [ref, size];
}

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
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
