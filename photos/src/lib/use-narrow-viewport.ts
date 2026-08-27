import { useEffect, useState } from "react";

/**
 * The width below which the app is laid out for a phone rather than a desktop.
 */
export const MOBILE_BREAKPOINT_PX = 768;

/**
 * Track a media query.
 *
 * Reported false until after mount, so the first paint is the same markup
 * everywhere and the narrow layout arrives as a correction rather than as a
 * hydration mismatch.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    setMatches(media.matches);
    const update = (event: MediaQueryListEvent) => setMatches(event.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/** Whether the viewport is phone-width. */
export function useNarrowViewport(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
}

/**
 * Whether the viewer has asked for less motion. The header still hides and
 * shows for them; it just stops sliding to do it.
 */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
