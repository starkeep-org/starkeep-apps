/**
 * Landscape, and what it hides.
 *
 * In landscape the app shows a photograph or the grid of photographs and
 * nothing else: no app bar, no viewer bars, no status bar and no navigation
 * bar. One test decides it everywhere, so the grid and the viewer never
 * disagree about which orientation the phone is in.
 */

import { useEffect } from "react";
import { StatusBar, useWindowDimensions } from "react-native";
import { NavigationBar } from "expo-navigation-bar";

/** Whether the window is wider than it is tall. Re-renders on rotation. */
export function useIsLandscape(): boolean {
  const window = useWindowDimensions();
  return window.width > window.height;
}

/**
 * Hide the status bar and the navigation bar while `hidden` holds, and bring
 * them back when it stops holding.
 *
 * The navigation bar comes back on a swipe from the edge while hidden, which is
 * Android's own immersive behaviour, so the back gesture stays reachable.
 * Failures are logged rather than thrown: a bar that will not hide costs some
 * pixels, not the app.
 */
export function useSystemBarsHidden(hidden: boolean): void {
  useEffect(() => {
    StatusBar.setHidden(hidden, "fade");
    try {
      NavigationBar.setHidden(hidden);
    } catch (err) {
      console.warn(`[orientation] navigation bar: ${String(err)}`);
    }
  }, [hidden]);
}
