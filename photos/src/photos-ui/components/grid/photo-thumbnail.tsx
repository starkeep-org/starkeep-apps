import type { AppImage } from "@/photos-lib";
import { usePhotoUrls } from "../../context/photo-url-context";
import { useInView } from "../../hooks/use-in-view";

interface PhotoThumbnailProps {
  image: AppImage;
  onSelect: (id: string) => void;
}

export function PhotoThumbnail({ image, onSelect }: PhotoThumbnailProps) {
  const { getFullSizeSrc } = usePhotoUrls();
  // Only ask for a signed URL once the tile is near the viewport, so a large
  // gallery doesn't fan out into a URL request per photo on load.
  const [containerRef, inView] = useInView<HTMLDivElement>();

  // Only thumbnails have a small image to display. This reads Photos' own
  // `thumbnail-of` label rather than `parentId !== null`, which was the bug:
  // crops set parentId too, so every crop rendered here as if it were its
  // source's thumbnail. The parent edge needed a type.
  //
  // An unlabelled record is treated as "not a thumbnail" and shows the
  // placeholder — which is also the right transient answer for a thumbnail
  // whose label hasn't landed yet, since the record and its labels share a
  // request but not a transaction.
  const isThumbnail = image.derivedKind === "thumbnail";
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
            // Let the browser apply EXIF orientation (the default; set
            // explicitly so a global reset can't leave a rotated image
            // sideways). Never also rotate via CSS transform — that would
            // double-apply the rotation. Normalized thumbnails carry no
            // orientation anyway, so this is a defensive no-op for them.
            imageOrientation: "from-image",
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
