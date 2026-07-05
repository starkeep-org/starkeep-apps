import type { AppImage } from "@/photos-lib";
import { usePhotoUrls } from "../../context/photo-url-context";
import { useInView } from "../../hooks/use-in-view";

const ORIENTATION_TRANSFORMS: Record<number, string> = {
  3: "rotate(180deg)",
  6: "rotate(90deg)",
  8: "rotate(270deg)",
};

interface PhotoThumbnailProps {
  image: AppImage;
  onSelect: (id: string) => void;
}

export function PhotoThumbnail({ image, onSelect }: PhotoThumbnailProps) {
  const { getFullSizeSrc } = usePhotoUrls();
  // Only ask for a signed URL once the tile is near the viewport, so a large
  // gallery doesn't fan out into a URL request per photo on load.
  const [containerRef, inView] = useInView<HTMLDivElement>();

  // Only thumbnail records (parentId !== null) have a small image to display.
  // Originals with parentId === null are placeholders — their thumbnail is being generated.
  const isThumbnail = image.parentId !== null;
  const transform =
    image.exif.orientation
      ? (ORIENTATION_TRANSFORMS[image.exif.orientation] ?? "none")
      : "none";
  const src = isThumbnail && inView ? getFullSizeSrc(image.id) : null;

  return (
    <div
      ref={containerRef}
      onClick={() => { if (isThumbnail) onSelect(image.id); }}
      style={{
        width: 180,
        height: 120,
        overflow: "hidden",
        cursor: isThumbnail ? "pointer" : "default",
        borderRadius: 4,
        background: "#222",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {src ? (
        <img
          src={src}
          alt={image.originalFilename}
          loading="lazy"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform,
            transition: "transform 0.1s ease",
          }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: "repeating-linear-gradient(45deg, #1a1a1a, #1a1a1a 4px, #222 4px, #222 8px)",
          }}
        />
      )}
    </div>
  );
}
