import type { AppImage } from "@/photos-lib/client";
import type { VideoDecision } from "@/lib/rendition-resolution-client";

/**
 * Playback for a video record (item 28).
 *
 * A plain `<video>` element, deliberately. Below the length where adaptive
 * streaming earns its keep, a progressive MP4 with the moov atom at the front
 * plays and seeks correctly over ordinary range requests — which S3 and
 * CloudFront both serve natively and the local server now serves too. HLS would
 * add a manifest, a segmenter, and a JS player to achieve the same thing for
 * clips this short.
 *
 * `preload="metadata"` rather than `auto`: a viewer opened on a clip should
 * fetch the few kilobytes that make the scrub bar work, not begin pulling the
 * whole file. Under Intelligent-Tiering a read also promotes an object back to
 * Frequent Access for 30 days, so speculative full-file reads quietly undo the
 * tiering that makes storage cheap.
 */
export function VideoPlayer({
  image,
  targetLongEdge,
  decision,
  onToggleInfo,
}: {
  image: AppImage;
  targetLongEdge: number;
  decision?: VideoDecision;
  onToggleInfo: () => void;
}) {
  const playback = decision?.playback?.url ? decision.playback : undefined;
  const poster = decision?.poster?.url ? decision.poster : undefined;

  // A clip whose transcode has not been derived yet is not broken — it is not
  // ready. Showing the poster with a clear reason beats offering a play button
  // that does nothing, and beats falling back to the original, which is the
  // large file the transcode exists to avoid streaming.
  if (!playback) {
    return (
      <div style={{ position: "absolute", inset: 0 }}>
        {poster && (
          <img
            src={poster.url}
            alt={image.originalFilename}
            onClick={onToggleInfo}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "contain",
              cursor: "pointer",
            }}
          />
        )}
        <div
          data-testid="video-not-ready"
          style={{
            position: "absolute",
            bottom: 16,
            left: 0,
            right: 0,
            textAlign: "center",
            color: "#ddd",
            fontSize: 14,
            textShadow: "0 1px 3px rgba(0,0,0,0.8)",
          }}
        >
          Preparing this video for playback…
        </div>
      </div>
    );
  }

  return (
    <video
      data-testid="video-player"
      data-target-long-edge={targetLongEdge}
      src={playback.url}
      poster={poster?.url}
      controls
      playsInline
      preload="metadata"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "contain",
        background: "#000",
      }}
    />
  );
}
