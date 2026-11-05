import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { imageDimensions, imageDimensionsFromBase64 } from '../src/worker/services/image-metadata.ts';

test('image metadata reads dimensions from PNG, JPEG and WebP', () => {
    const landscapePng = readFileSync(new URL('./fixtures/moderation/landscape.png', import.meta.url));
    assert.deepEqual(imageDimensions(landscapePng, 'image/png'), { width: 512, height: 384 });

    assert.deepEqual(imageDimensions(jpegHeader(321, 123), 'image/jpeg'), { width: 321, height: 123 });

    const webp = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJQBOgCHwAP7+4AAAAA==';
    assert.deepEqual(imageDimensionsFromBase64('image/webp', webp), { width: 1, height: 1 });
    assert.equal(imageDimensionsFromBase64('image/png', webp), null);
    assert.equal(imageDimensionsFromBase64('image/jpeg', 'not-base64'), null);
});

function jpegHeader(width: number, height: number): Uint8Array {
    return Uint8Array.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xc0, 0x00, 0x11, 0x08,
        height >>> 8, height & 255, width >>> 8, width & 255,
        0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
        0xff, 0xd9,
    ]);
}
