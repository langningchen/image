import { DEFAULT_UPLOAD_LIMITS } from '../uploadLimits.ts';

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
