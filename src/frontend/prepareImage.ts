export async function prepareImage(dataUrl: string, size: number, quality = 0.8): Promise<string> {
  if (size <= 1024 * 1024 || dataUrl.startsWith('data:image/png;')) return dataUrl;
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) { reject(new Error('Image processing unavailable')); return; }
    const img = new Image();

    img.onload = () => {
      // Calculate new dimensions (max 1920px width)
      let { width, height } = img;
      const maxWidth = 1920;
      if (width > maxWidth) {
        height = (height * maxWidth) / width;
        width = maxWidth;
      }

      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);

      // Compress and return
      resolve(canvas.toDataURL(dataUrl.startsWith('data:image/webp;') ? 'image/webp' : 'image/jpeg', quality));
    };

    img.onerror = () => reject(new Error('Invalid image data'));
    img.src = dataUrl;
  });
}
