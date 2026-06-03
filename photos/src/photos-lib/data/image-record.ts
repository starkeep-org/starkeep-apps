import { IMAGE_RECORD_TYPE } from "../manifest";
import type { ExifFields } from "../metadata/exif-generator";

export { IMAGE_RECORD_TYPE };

/**
 * Per-type metadata row for an image. Maps 1:1 to columns on
 * shared_record_image_metadata (see @starkeep/protocol-primitives's CORE_TYPES). Every
 * field is deterministically derivable from the image bytes.
 *
 * `recordId` is supplied by the SDK at write time; callers don't set it.
 */
export interface ImageMetadataRow {
  width: number;
  height: number;
  captured_at: string | null;
  camera_make: string | null;
  camera_model: string | null;
  f_number: number | null;
  exposure_time: string | null;
  iso: number | null;
  lens_model: string | null;
  gps_lat: number | null;
  gps_lon: number | null;
  orientation: number | null;
}

export function buildImageMetadataRow(
  dimensions: { width: number; height: number },
  exif: ExifFields,
): ImageMetadataRow {
  return {
    width: dimensions.width,
    height: dimensions.height,
    captured_at: exif.dateTakenRaw,
    camera_make: exif.cameraMake,
    camera_model: exif.cameraModel,
    f_number: exif.fNumber,
    exposure_time: exif.exposureTime,
    iso: exif.iso,
    lens_model: exif.lensModel,
    gps_lat: exif.gpsLat,
    gps_lon: exif.gpsLon,
    orientation: exif.orientation,
  };
}
