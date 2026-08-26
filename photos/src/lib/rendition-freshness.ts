import type { AppImage } from "@/photos-lib/client";

/** Whether child-only writes require full library refreshes to become visible. */
export function hasAwaitingRenditions(images: readonly AppImage[]): boolean {
  return images.some((image) =>
    Object.values(image.renditions ?? {}).some(
      (choice) => !choice.ideal.available && choice.ideal.state === "pending",
    ),
  );
}
