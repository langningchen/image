import { imageSize } from 'image-size';

export interface ImageDimensions {
    width: number;
    height: number;
}

const MIME_TYPES = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
} as const;

export function imageDimensions(bytes: Uint8Array, mimeType: string): ImageDimensions | null {
    const expectedType = MIME_TYPES[mimeType as keyof typeof MIME_TYPES];
    if (!expectedType) return null;
    try {
        const size = imageSize(bytes);
        if (size.type !== expectedType || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)
            || size.width <= 0 || size.height <= 0) return null;
        return { width: size.width, height: size.height };
    } catch {
        return null;
    }
}

export function imageDimensionsFromBase64(mimeType: string, base64: string): ImageDimensions | null {
    try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        return imageDimensions(bytes, mimeType);
    } catch {
        return null;
    }
}
