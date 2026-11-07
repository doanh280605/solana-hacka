import { hashBytes } from './bytes';
import type { Manifest, Order, PreviewCommitment } from './types';

const previewSources: Record<string, string> = { hero: 'hero.webp', portrait: 'social-portrait.webp', square: 'social-square.webp', story: 'social-story.webp' };
const expectedPaths = Object.keys(previewSources).map((name) => `preview-${name}.webp`);
const hashPattern = /^[a-f0-9]{64}$/;

export function committedPreviews(manifest: Manifest, displayed: Order['previews']): PreviewCommitment[] {
  if (!Array.isArray(manifest.previews) || manifest.previews.length !== 4 || manifest.previews.map((entry) => entry.path).join(',') !== expectedPaths.join(',') || !Array.isArray(displayed) || displayed.length !== 4) throw new Error('The result does not commit the complete four-image review set.');
  for (const entry of manifest.previews) {
    const name = entry.path.slice('preview-'.length, -'.webp'.length);
    const view = displayed.filter((preview) => preview.name === name);
    if (Object.keys(entry).sort().join(',') !== 'bytes,height,mimeType,path,sha256,sourcePath,width' || entry.sourcePath !== previewSources[name] || !hashPattern.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 5 * 1024 * 1024 || entry.mimeType !== 'image/webp' || !Number.isSafeInteger(entry.width) || entry.width < 1 || entry.width > 560 || !Number.isSafeInteger(entry.height) || entry.height < 1 || entry.height > 680 || view.length !== 1 || view[0].width !== entry.width || view[0].height !== entry.height) throw new Error('Private preview metadata differs from the committed result.');
  }
  return manifest.previews;
}

/** Read bounded, nonanimated WebP container dimensions before allocating a browser image. */
export function webpDimensions(buffer: ArrayBuffer): { width: number; height: number } {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const text = (start: number, length: number) => new TextDecoder().decode(bytes.subarray(start, start + length));
  const fail = (): never => { throw new Error('The private preview is not a supported single-frame WebP.'); };
  if (bytes.length < 20 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length) fail();
  let offset = 12;
  let canvas: { width: number; height: number } | null = null;
  let image: { width: number; height: number } | null = null;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail();
    const type = text(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const data = offset + 8;
    if (data + size + (size & 1) > bytes.length || type === 'ANIM' || type === 'ANMF') fail();
    if (type === 'VP8X') {
      if (size !== 10 || canvas || (bytes[data] & 0x02) !== 0) fail();
      const uint24 = (at: number) => bytes[at] + (bytes[at + 1] << 8) + (bytes[at + 2] << 16);
      canvas = { width: uint24(data + 4) + 1, height: uint24(data + 7) + 1 };
    } else if (type === 'VP8 ') {
      if (size < 10 || image || (bytes[data] & 1) !== 0 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) fail();
      image = { width: view.getUint16(data + 6, true) & 0x3fff, height: view.getUint16(data + 8, true) & 0x3fff };
    } else if (type === 'VP8L') {
      if (size < 5 || image || bytes[data] !== 0x2f || (bytes[data + 4] >> 5) !== 0) fail();
      image = { width: 1 + bytes[data + 1] + ((bytes[data + 2] & 0x3f) << 8), height: 1 + (bytes[data + 2] >> 6) + (bytes[data + 3] << 2) + ((bytes[data + 4] & 0x0f) << 10) };
    }
    offset = data + size + (size & 1);
  }
  if (offset !== bytes.length || !image || !image.width || !image.height || (canvas && (canvas.width !== image.width || canvas.height !== image.height))) fail();
  return image!;
}

export async function verifyPreviewBytes(buffer: ArrayBuffer, entry: PreviewCommitment, name: string, mimeType: string): Promise<void> {
  if (!previewSources[name] || entry.path !== `preview-${name}.webp` || entry.sourcePath !== previewSources[name] || mimeType !== entry.mimeType || buffer.byteLength !== entry.bytes || await hashBytes(buffer) !== entry.sha256) throw new Error('The private preview bytes differ from the submitted result. Approval is disabled.');
  const dimensions = webpDimensions(buffer);
  if (dimensions.width !== entry.width || dimensions.height !== entry.height) throw new Error('The private preview dimensions differ from the submitted result. Approval is disabled.');
}
