import type { ResizeResult } from "../metadata/thumbnail-generator";

export async function resizeForThumbnail(
  imageBytes: Uint8Array,
  maxWidth: number,
): Promise<ResizeResult & { contentType: string }> {
  const { default: sharp } = await import("sharp") as { default: typeof import("sharp") };
  const inputBuffer = Buffer.from(imageBytes);
  const meta = await sharp(inputBuffer).metadata();
  const hasAlpha = meta.hasAlpha ?? false;

  const resized = await sharp(inputBuffer)
    .rotate()
    .resize(maxWidth, maxWidth, {
      fit: "inside",
      kernel: "cubic",
      withoutEnlargement: true,
    })
    [hasAlpha ? "webp" : "jpeg"](hasAlpha ? { quality: 76 } : { quality: 85 })
    .toBuffer();

  const outputMeta = await sharp(resized).metadata();
  return {
    data: new Uint8Array(resized),
    width: outputMeta.width ?? 0,
    height: outputMeta.height ?? 0,
    contentType: hasAlpha ? "image/webp" : "image/jpeg",
  };
}
