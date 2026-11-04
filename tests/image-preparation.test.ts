import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareImage } from '../src/frontend/prepareImage.ts';

test('disabling the dimension limit preserves the original data URL', async () => {
    const image = 'data:image/png;base64,' + 'AAAA'.repeat(400_000);
    assert.equal(await prepareImage(image, null), image);
});

test('images within the dimension limit retain their original bytes', async t => {
    const canvas = mockBrowserImage(800, 600);
    t.after(canvas.restore);
    for (const type of ['jpeg', 'png', 'webp']) {
        const image = `data:image/${type};base64,aGVsbG8=`;
        assert.equal(await prepareImage(image, 1920), image);
    }
    assert.equal(canvas.drawCalls, 0);
});

test('the configured dimension scales the longest edge and preserves the image format', async t => {
    const canvas = mockBrowserImage(4000, 3000, 'data:image/png;base64,prepared');
    t.after(canvas.restore);
    assert.equal(await prepareImage('data:image/png;base64,aGVsbG8=', 1920), 'data:image/png;base64,prepared');
    assert.deepEqual(canvas.size, { width: 1920, height: 1440 });
    assert.deepEqual(canvas.drawCalls, 1);
    assert.deepEqual(canvas.output, { type: 'image/png', quality: 0.8 });
});

function mockBrowserImage(width: number, height: number, output = 'data:image/jpeg;base64,prepared') {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
    const size = { width: 0, height: 0 };
    let drawCalls = 0;
    let outputData = { type: '', quality: 0 };
    const canvas = {
        get width() { return size.width; },
        set width(value: number) { size.width = value; },
        get height() { return size.height; },
        set height(value: number) { size.height = value; },
        getContext: () => ({ drawImage: () => { drawCalls++; } }),
        toDataURL: (type: string, quality: number) => { outputData = { type, quality }; return output; },
    };
    class TestImage {
        width = width;
        height = height;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => canvas } });
    Object.defineProperty(globalThis, 'Image', { configurable: true, value: TestImage });
    return {
        size,
        get drawCalls() { return drawCalls; },
        get output() { return outputData; },
        restore: () => {
            restoreProperty('document', originalDocument);
            restoreProperty('Image', originalImage);
        },
    };
}

function restoreProperty(name: string, descriptor: PropertyDescriptor | undefined) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
}
