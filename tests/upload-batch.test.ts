import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadBatch } from '../src/frontend/uploadBatch.ts';

test('large file selections decode and upload only one image at a time', async () => {
  let active = 0, peak = 0;
  const completed: string[] = [];
  const progress: number[] = [];
  const files = Array.from({ length: 200 }, (_, index) => index);
  const result = await uploadBatch(files, async file => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return String(file);
  }, id => completed.push(id), value => progress.push(value));
  assert.equal(peak, 1);
  assert.equal(result.uploaded, 200);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(completed, files.map(String));
  assert.equal(progress.at(-1), 100);
  assert.ok(progress.every((value, index) => !index || value > progress[index - 1]));
});

test('a failed upload does not finish the batch early or abandon remaining files', async () => {
  const uploaded: string[] = [];
  const progress: number[] = [];
  const result = await uploadBatch([1, 2, 3], async file => {
    if (file === 2) throw new Error('Storage unavailable');
    return String(file);
  }, id => uploaded.push(id), value => progress.push(value));
  assert.deepEqual(uploaded, ['1', '3']);
  assert.deepEqual(result, { uploaded: 2, errors: ['Storage unavailable'] });
  assert.equal(progress.length, 3);
  assert.equal(progress.at(-1), 100);
});

test('empty upload batches complete without work', async () => {
  const result = await uploadBatch([], async () => { throw new Error('Unexpected upload'); }, () => {}, () => {});
  assert.deepEqual(result, { uploaded: 0, errors: [] });
});
