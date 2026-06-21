/**
 * Minimal JPEG with EXIF IFD0 Make/Model, generated in-process via sharp — no
 * binary files in the repo, mirroring tiff-fixture.ts. JPEG (not TIFF) is the
 * format real cameras and phones emit, so this exercises the app's actual EXIF
 * path: exifr reads the camera fields out of an APP1/IFD0 block the same way it
 * would for a phone photo. sharp writes the EXIF and encodes a solid-color
 * image whose dimensions decode deterministically (createImageBitmap on upload).
 */

import sharp from "sharp";

export interface JpegOptions {
  make?: string;
  model?: string;
  /** Square edge length in pixels. */
  size?: number;
  /** Solid fill color. */
  rgb?: [number, number, number];
}

export async function jpegWithExif(options: JpegOptions = {}): Promise<Buffer> {
  const make = options.make ?? "TestMake";
  const model = options.model ?? "TestModel 3000";
  const size = options.size ?? 8;
  const [r, g, b] = options.rgb ?? [240, 170, 60];

  return sharp({ create: { width: size, height: size, channels: 3, background: { r, g, b } } })
    .withExif({ IFD0: { Make: make, Model: model } })
    .jpeg()
    .toBuffer();
}
