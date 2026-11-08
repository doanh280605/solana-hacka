import { canonicalJson } from '@holdfast/chain';
import { hashBytes } from './commitments';
import type { Manifest } from './types';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Verify the service's bounded ZIP32 store format before offering bytes for download. */
export async function verifyBundle(buffer: ArrayBuffer, manifest: Manifest, resultHash: string): Promise<void> {
  const fail = () => { throw new Error('The downloaded ZIP does not match the committed artifact manifest. Nothing was saved.'); };
  if (buffer.byteLength < 22 || buffer.byteLength > 100 * 1024 * 1024) fail();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const end = buffer.byteLength - 22;
  if (view.getUint32(end, true) !== 0x06054b50 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 || view.getUint16(end + 8, true) !== 7 || view.getUint16(end + 10, true) !== 7 || view.getUint16(end + 20, true) !== 0) fail();
  const directoryLength = view.getUint32(end + 12, true);
  const directoryStart = view.getUint32(end + 16, true);
  if (directoryStart + directoryLength !== end) fail();
  const expected = new Set([...manifest.artifacts.map((entry) => entry.path), 'manifest.json']);
  if (expected.size !== 7) fail();
  const files = new Map<string, { data: Uint8Array; crc: number; offset: number }>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let position = 0;
  while (position < directoryStart) {
    const offset = position;
    if (position + 30 > directoryStart || view.getUint32(position, true) !== 0x04034b50 || view.getUint16(position + 4, true) !== 20 || view.getUint16(position + 6, true) !== 0x800 || view.getUint16(position + 8, true) !== 0) fail();
    const crc = view.getUint32(position + 14, true);
    const size = view.getUint32(position + 22, true);
    const nameLength = view.getUint16(position + 26, true);
    if (size > 25 * 1024 * 1024 || view.getUint32(position + 18, true) !== size || view.getUint16(position + 28, true) !== 0 || nameLength < 1 || nameLength > 40 || position + 30 + nameLength + size > directoryStart) fail();
    const name = decoder.decode(bytes.subarray(position + 30, position + 30 + nameLength));
    if (!expected.has(name) || files.has(name)) fail();
    position += 30 + nameLength;
    const data = bytes.subarray(position, position + size);
    if (crc32(data) !== crc) fail();
    files.set(name, { data, crc, offset });
    position += size;
  }
  if (position !== directoryStart || files.size !== 7) fail();
  const listed = new Set<string>();
  while (position < end) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50 || view.getUint16(position + 8, true) !== 0x800 || view.getUint16(position + 10, true) !== 0) fail();
    const nameLength = view.getUint16(position + 28, true);
    if (view.getUint16(position + 30, true) !== 0 || view.getUint16(position + 32, true) !== 0 || view.getUint16(position + 34, true) !== 0 || nameLength < 1 || nameLength > 40 || position + 46 + nameLength > end) fail();
    const name = decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength));
    const local = files.get(name);
    if (!local || listed.has(name) || view.getUint32(position + 16, true) !== local.crc || view.getUint32(position + 20, true) !== local.data.byteLength || view.getUint32(position + 24, true) !== local.data.byteLength || view.getUint32(position + 42, true) !== local.offset) fail();
    listed.add(name);
    position += 46 + nameLength;
  }
  if (position !== end || listed.size !== 7) fail();
  const manifestBytes = files.get('manifest.json')!.data;
  if (decoder.decode(manifestBytes) !== canonicalJson(manifest) || await hashBytes(manifestBytes.slice().buffer) !== resultHash) fail();
  for (const entry of manifest.artifacts) {
    const data = files.get(entry.path)?.data;
    if (!data || data.byteLength !== entry.size || await hashBytes(data.slice().buffer) !== entry.sha256) fail();
  }
}
