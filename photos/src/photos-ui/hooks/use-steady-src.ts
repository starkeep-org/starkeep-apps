import { useCallback, useEffect, useState } from "react";

/**
 * The `src` for one `<img>` that moves between URLs without a blank frame.
 *
 * ## Why one element and an in-place `src` is enough
 *
 * A browser keeps drawing a fully loaded image while a new `src` loads, and
 * switches when the new one is ready — the HTML spec's "pending request". So an
 * `<img>` that React never remounts swaps pictures with nothing between them.
 * The viewer and the tiles used to defeat this themselves: the viewer unmounted
 * the old `<img>` and faded a new one in over black, and a tile hid its own
 * `<img>` behind its ThumbHash until the new bytes landed.
 *
 * ## Why a new URL is preloaded first
 *
 * The spec's one exception is a new `src` that fails: the element drops the old
 * picture and shows a broken image. So once a picture is on screen, a new URL
 * loads and decodes in an off-screen `Image`, and the visible `src` moves only
 * once that succeeded. The swap then comes from the browser's cache, already
 * decoded, and a failure never touches what is on screen — it goes to
 * `onFailure`, which hands it to the resolution cache to ask again.
 *
 * Before anything has drawn there is nothing to protect, so the `src` moves at
 * once and the element's own load does the work. After, a withdrawn URL leaves
 * the picture where it is.
 */
export function useSteadySrc(
  desired: string | null,
  onFailure: (url: string) => void,
): {
  /** What the `<img>` should point at. */
  src: string | null;
  /** Whether a picture has drawn, so the element may be shown. */
  shown: boolean;
  onLoad: () => void;
  onError: () => void;
} {
  const [src, setSrc] = useState<string | null>(desired);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (desired === src) return;
    // Nothing on screen yet: follow the URL, including to none when the cache
    // withdraws one that failed, so a failed URL never lingers on the element.
    if (!shown) {
      setSrc(desired);
      return;
    }
    // A picture is on screen and no URL replaces it: keep the picture.
    if (!desired) return;
    let cancelled = false;
    const probe = new Image();
    probe.src = desired;
    // `decode` waits for the bytes and the decode; the fallback, for a browser
    // or a test environment without it, waits for the bytes alone.
    const ready =
      typeof probe.decode === "function"
        ? probe.decode()
        : new Promise<void>((resolve, reject) => {
            probe.onload = () => resolve();
            probe.onerror = () => reject(new Error("load failed"));
          });
    ready.then(
      () => {
        if (!cancelled) setSrc(desired);
      },
      () => {
        if (!cancelled) onFailure(desired);
      },
    );
    return () => {
      cancelled = true;
    };
    // `onFailure` is read when a probe settles, not a reason to start another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desired, src, shown]);

  const onLoad = useCallback(() => setShown(true), []);
  const onError = useCallback(() => {
    if (src) onFailure(src);
  }, [src, onFailure]);

  return { src, shown, onLoad, onError };
}
