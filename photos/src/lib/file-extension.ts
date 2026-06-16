// TODO: Fully reconcile mime type with file extension
// and determine file types properly.
// After which this file should be removed.
//
// Extract the lowercase file extension from a filename, or `undefined` when the
// name has no extension. Inlined here (rather than imported from @starkeep/protocol-primitives)
// for the same reason as `dataRecordObjectKey` in the route files: to keep this
// client-adjacent lib from dragging the core package into the browser build.
//
// Extension extraction is generic across all file types; there is nothing
// image-specific about it. It's still used to derive filenames and (via
// starkeepTypeFromFilename below) the record `type`, which is now a Starkeep
// type id derived from — not equal to — the extension.
export function extensionFromFilename(
  fileName: string | null | undefined,
): string | undefined {
  if (!fileName) return undefined;
  const base = fileName.slice(fileName.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined; // no dot, or a leading-dot dotfile
  const ext = base.slice(dot + 1).toLowerCase();
  return ext === "" ? undefined : ext;
}

// Advisory ext → Starkeep type id, for the image formats photos handles.
// Mirrors @starkeep/protocol-primitives EXTENSIONS (inlined to keep core out of
// the browser bundle — same rationale as extensionFromFilename / dataRecordObjectKey).
const IMAGE_TYPE_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", heic: "image/heic", heif: "image/heif", avif: "image/avif",
  bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
};

/** Starkeep type id for an uploaded filename; falls back to image/jpeg. */
export function starkeepTypeFromFilename(fileName: string | null | undefined): string {
  const ext = extensionFromFilename(fileName);
  return (ext && IMAGE_TYPE_BY_EXT[ext]) ?? "image/jpeg";
}
