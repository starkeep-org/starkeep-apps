import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * One-shot viewport visibility: flips to true the first time the element
 * intersects the viewport (within rootMargin) and stays true — thumbnails
 * never un-load. Environments without IntersectionObserver are treated as
 * always visible so nothing is withheld there.
 */
export function useInView<T extends Element>(
  rootMargin = "200px",
): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin, inView]);

  return [ref, inView];
}
