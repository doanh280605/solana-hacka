import sharp from 'sharp';
import { HttpError } from './errors.js';
import { sha256 } from './security.js';
import { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS, MAX_UPLOAD_BYTES, type ImageManifest } from './types.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export async function validatePng(bytes: Buffer): Promise<ImageManifest> {
  if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, 'Upload one PNG of at most 5 MB');
  }
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new HttpError(415, 'Only PNG images are accepted');
  try {
    const metadata = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' }).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1 || width < 1 || height < 1
      || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
      throw new HttpError(415, 'Use a single-frame PNG up to 4096 by 4096 pixels');
    }
    // Full decode rejects truncated/corrupt files; metadata alone does not.
    await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' }).raw().toBuffer();
    return { sha256: sha256(bytes), size: bytes.length, width, height };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(415, 'PNG is invalid, truncated, or exceeds image limits');
  }
}

export interface ConvertedImages {
  output: Buffer;
  outputManifest: ImageManifest;
  preview: Buffer;
  previewManifest: ImageManifest;
}

export async function convertPng(bytes: Buffer): Promise<ConvertedImages> {
  const { data: output, info: outputInfo } = await sharp(bytes, {
    limitInputPixels: MAX_IMAGE_PIXELS,
    failOn: 'warning',
  }).webp({ quality: 90, effort: 4 }).toBuffer({ resolveWithObject: true });
  const { data: thumbnail, info: thumbnailInfo } = await sharp(output)
    .resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true })
    .png().toBuffer({ resolveWithObject: true });
  const width = Math.max(360, thumbnailInfo.width);
  const height = Math.max(240, thumbnailInfo.height + 44);
  const watermark = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs><pattern id="stripes" width="60" height="60" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)">
      <rect width="13" height="60" fill="#091827" fill-opacity="0.15"/>
    </pattern></defs>
    <rect width="100%" height="100%" fill="url(#stripes)"/>
    <g transform="translate(${width / 2},${(height - 44) / 2}) rotate(-20)">
      <text text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="${Math.max(40, Math.floor(width / 5))}" font-weight="900" fill="white" stroke="#132737" stroke-width="2" paint-order="stroke" opacity="0.86">PREVIEW</text>
    </g>
    <rect y="${height - 44}" width="${width}" height="44" fill="#132737"/>
    <text x="${width / 2}" y="${height - 17}" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="700" fill="white">HOLDFAST — APPROVE TO UNLOCK</text>
  </svg>`);
  const preview = await sharp({ create: { width, height, channels: 4, background: '#e5edf0' } })
    .composite([
      { input: thumbnail, left: Math.floor((width - thumbnailInfo.width) / 2), top: Math.floor((height - 44 - thumbnailInfo.height) / 2) },
      { input: watermark, left: 0, top: 0 },
    ]).webp({ quality: 78 }).toBuffer();
  return {
    output,
    outputManifest: { sha256: sha256(output), size: output.length, width: outputInfo.width, height: outputInfo.height },
    preview,
    previewManifest: { sha256: sha256(preview), size: preview.length, width, height },
  };
}
