import { DEFAULT_UPLOAD_LIMITS } from '../uploadLimits.ts';

export function isAnimatedPngDataUrl(dataUrl: string): boolean {
  const match = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return false;
  let binary: string;
  try { binary = atob(match[1]); } catch { return false; }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (binary.length < signature.length || signature.some((byte, index) => binary.charCodeAt(index) !== byte)) return false;
  let offset = signature.length;
  while (offset + 12 <= binary.length) {
    const length = ((binary.charCodeAt(offset) << 24) | (binary.charCodeAt(offset + 1) << 16)
      | (binary.charCodeAt(offset + 2) << 8) | binary.charCodeAt(offset + 3)) >>> 0;
    if (offset + 12 + length > binary.length) return false;
    if (binary.slice(offset + 4, offset + 8) === 'acTL') return true;
    if (binary.slice(offset + 4, offset + 8) === 'IEND') return false;
    offset += 12 + length;
  }
  return false;
}

export async function prepareImage(
  dataUrl: string,
  maxImageDimension: number | null = DEFAULT_UPLOAD_LIMITS.maxImageDimension,
  quality = 0.8,
): Promise<string> {
  if (maxImageDimension === null) return dataUrl;
  if (!Number.isSafeInteger(maxImageDimension) || maxImageDimension <= 0) {
    throw new Error('Invalid image dimension limit');
  }
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) { reject(new Error('Image processing unavailable')); return; }
    const img = new Image();

    img.onload = () => {
      let { width, height } = img;
      const longestEdge = Math.max(width, height);
      if (!Number.isFinite(longestEdge) || longestEdge <= 0 || longestEdge <= maxImageDimension) {
        resolve(dataUrl);
        return;
      }
      if (dataUrl.startsWith('data:image/png;') && isAnimatedPngDataUrl(dataUrl)) {
        reject(new Error(`Animated PNG exceeds the ${maxImageDimension} px image dimension limit and cannot be resized without losing animation.`));
        return;
      }
      const scale = maxImageDimension / longestEdge;
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));

      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);

      const outputType = dataUrl.startsWith('data:image/png;')
        ? 'image/png'
        : dataUrl.startsWith('data:image/webp;') ? 'image/webp' : 'image/jpeg';
      resolve(canvas.toDataURL(outputType, quality));
    };

    img.onerror = () => reject(new Error('Invalid image data'));
    img.src = dataUrl;
  });
}
