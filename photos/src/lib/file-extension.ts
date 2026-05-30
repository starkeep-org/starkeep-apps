// TODO: Fully reconcile mime type with file extension
// and determine file types properly.
// After which this file should be removed.
//
// Extract the lowercase file extension from a filename, or `undefined` when the
// name has no extension. Inlined here (rather than imported from @starkeep/core)
// for the same reason as `dataRecordObjectKey` in the route files: to keep this
// client-adjacent lib from dragging the core package into the browser build.
//
// Extension extraction is generic across all file types; there is nothing
// image-specific about it. Callers record the file's *true* extension as the
// record `type` and never substitute a different one — the data-server validates
// it against the app's grants on write (see system-design.md, "Apps record the
// true extension").
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
