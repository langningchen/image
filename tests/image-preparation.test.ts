import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareImage } from '../src/frontend/prepareImage.ts';

test('large PNG uploads bypass canvas encoding and retain their original bytes', async () => {
    const image = 'data:image/png;base64,' + 'AAAA'.repeat(400_000);
    assert.equal(await prepareImage(image, 1_200_000), image);
});

test('small JPEG and WebP uploads retain their original bytes', async () => {
    for (const type of ['jpeg', 'webp']) {
        const image = `data:image/${type};base64,aGVsbG8=`;
        assert.equal(await prepareImage(image, 5), image);
    }
});
