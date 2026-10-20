/**
 * The rows a photo's info panel shows, in the order it shows them.
 *
 * Shared by the Photos web app's `PhotoInfoPanel` and the phone's info sheet, so
 * the two list the same facts the same way. Only the rows are shared: each
 * surface gathers the facts from its own source, hands them over as
 * {@link PhotoInfoFields}, and draws the rows with its own components.
 */

/** What an info panel knows about one photo. Null means unknown. */
export interface PhotoInfoFields {
  readonly originalFilename: string | null;
  readonly title?: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  /** An ISO 8601 timestamp. */
  readonly dateTaken: string | null;
  readonly cameraMake?: string | null;
  readonly cameraModel?: string | null;
  readonly fNumber?: number | null;
  readonly exposureTime?: string | null;
  readonly iso?: number | null;
  readonly lensModel?: string | null;
  readonly orientation?: number | null;
  readonly gpsLat?: number | null;
  readonly gpsLon?: number | null;
}

export interface PhotoInfoRow {
  readonly label: string;
  readonly value: string;
}

export interface PhotoInfoRowsOptions {
  /**
   * Keep the five rows every photo has — filename, dimensions, MIME type, file
   * size and date taken — with a blank value when one is unknown, instead of
   * leaving them out. The web app's panel keeps them; the phone's sheet does
   * not.
   */
  readonly keepCoreRows?: boolean;
}

/**
 * The labelled rows for one photo.
 *
 * A row whose value is unknown is left out rather than shown empty, because the
 * phone knows far fewer of these facts than the web app for a photo it took
 * itself. {@link PhotoInfoRowsOptions.keepCoreRows} keeps the core rows anyway.
 */
export function photoInfoRows(
  fields: PhotoInfoFields,
  { keepCoreRows = false }: PhotoInfoRowsOptions = {},
): PhotoInfoRow[] {
  const rows: PhotoInfoRow[] = [];
  const add = (label: string, value: string | number | null | undefined): void => {
    if (value === null || value === undefined || value === "") return;
    rows.push({ label, value: String(value) });
  };
  const addCore = (label: string, value: string | null): void => {
    if (keepCoreRows) rows.push({ label, value: value ?? "" });
    else add(label, value);
  };
  const { width, height } = fields;
  const sized = width != null && height != null;

  addCore("Filename", fields.originalFilename);
  add("Title", fields.title);
  addCore("Dimensions", sized ? `${width} × ${height}px` : null);
  if (sized) add("Megapixels", formatMegapixels(width, height));
  addCore("MIME type", fields.mimeType);
  addCore("File size", fields.sizeBytes != null ? formatBytes(fields.sizeBytes) : null);
  addCore("Date taken", fields.dateTaken ? formatDateTaken(fields.dateTaken) : null);
  if (fields.cameraMake) {
    add("Camera", `${fields.cameraMake} ${fields.cameraModel ?? ""}`.trim());
  }
  if (fields.fNumber != null) add("Aperture", `f/${fields.fNumber}`);
  add("Exposure", fields.exposureTime);
  add("ISO", fields.iso);
  add("Lens", fields.lensModel);
  if (fields.orientation != null) add("Orientation", formatOrientation(fields.orientation));
  if (fields.gpsLat != null && fields.gpsLon != null) {
    add("Location", `${fields.gpsLat.toFixed(5)}, ${fields.gpsLon.toFixed(5)}`);
  }
  return rows;
}

/** An ISO timestamp as the panel prints it: date and time, to the second. */
export function formatDateTaken(iso: string): string {
  return iso.replace("T", " ").slice(0, 19);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMegapixels(width: number, height: number): string | null {
  if (width <= 0 || height <= 0) return null;
  return `${((width * height) / 1_000_000).toFixed(1)} MP`;
}

const ORIENTATION_LABELS: Record<number, string> = {
  1: "Normal",
  2: "Mirrored",
  3: "Rotated 180°",
  4: "Mirrored, 180°",
  5: "Mirrored, 90° CCW",
  6: "Rotated 90° CW",
  7: "Mirrored, 90° CW",
  8: "Rotated 90° CCW",
};

export function formatOrientation(orientation: number): string {
  return ORIENTATION_LABELS[orientation] ?? `Unknown (${orientation})`;
}
