/**
 * Efficiently convert a Uint8Array to a base64-encoded data URI.
 *
 * The naïve `String.fromCharCode(...bytes)` approach is O(n²) due to
 * string concatenation and can freeze the renderer for images >1 MB.
 * This implementation processes the bytes in 8 KB chunks, keeping
 * per-iteration work small and avoiding call-stack limits on
 * `String.fromCharCode.apply`.
 */

const CHUNK_SIZE = 8192; // 8 KB — well within the safe call-stack limit

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Build a complete `data:` URI from raw bytes and a file extension.
 */
const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
};

export function bytesToDataUri(bytes: Uint8Array, ext: string): string {
  const mime = MIME_MAP[ext.toLowerCase()] || 'image/png';
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}
