import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyFilters, filterError, filterTags, imageQuery, removeFilter } from '../src/frontend/admin/model.ts';

test('custom image range combines review, source and search and survives pagination', () => {
  const filters = { ...emptyFilters, status: 'approved', source: 'safe', search: '192.0.2.1', expiry: 'custom', minDays: '7', maxDays: '30' };
  const query = new URLSearchParams(imageQuery(filters, 'a'.repeat(32)));
  assert.deepEqual(Object.fromEntries(query), { search: '192.0.2.1', status: 'approved', source: 'safe', retention: 'unlocked', minDays: '7', maxDays: '30', cursor: 'a'.repeat(32) });
  assert.equal(filters.retention, '', 'Query generation must not modify the applied filter snapshot');
});

test('expiry shortcuts agree with overview groups, including exact day and due boundaries', () => {
  for (const [expiry, min, max] of [['due', null, '0'], ['1', '1', '1'], ['7-14', '7', '14'], ['15-21', '15', '21'], ['22-30', '22', '30'], ['over30', '31', null]]) {
    const query = new URLSearchParams(imageQuery({ ...emptyFilters, expiry: expiry! }));
    assert.equal(query.get('minDays'), min); assert.equal(query.get('maxDays'), max);
    assert.equal(query.get('retention'), 'unlocked');
  }
});

test('removing an expiry chip clears its implicit storage policy while preserving other fields', () => {
  const filters = { ...emptyFilters, retention: 'unlocked' as const, expiry: 'custom', minDays: '2', maxDays: '6', status: 'error', source: 'safe' };
  assert.equal(filterTags(filters).filter(tag => tag.field === 'retention').length, 0);
  const next = removeFilter(filters, 'expiry');
  assert.equal(imageQuery(next), 'status=error&source=safe');
  assert.deepEqual(filterTags(next).map(tag => tag.label), ['Needs review', 'AI approved']);
});

test('range validation accepts a zero boundary and rejects empty, reversed and fractional ranges', () => {
  for (const range of [{ minDays: '0', maxDays: '0' }, { minDays: '', maxDays: '7' }, { minDays: '31', maxDays: '' }]) {
    assert.equal(filterError({ ...emptyFilters, expiry: 'custom', ...range }), '');
  }
  for (const range of [{ minDays: '', maxDays: '' }, { minDays: '8', maxDays: '7' }, { minDays: '1.5', maxDays: '' }, { minDays: '-1', maxDays: '7' }]) {
    assert.notEqual(filterError({ ...emptyFilters, expiry: 'custom', ...range }), '');
  }
});

test('every retention chart segment opens a valid filter with a renderable label', async () => {
  const { retentionBucketFilters } = await import('../src/frontend/admin/model.ts');
  for (const bucket of ['due', '1', '2', '3', '4', '5', '6', '7-14', '15-21', '22-30', 'over30', 'locked', 'deleting']) {
    const filters = retentionBucketFilters(bucket);
    assert.equal(filterError(filters), '', bucket);
    assert.ok(filterTags(filters).length > 0, bucket);
    if (/^[2-6]$/.test(bucket)) {
      assert.equal(filters.expiry, 'custom');
      const query = new URLSearchParams(imageQuery(filters));
      assert.equal(query.get('minDays'), bucket);
      assert.equal(query.get('maxDays'), bucket);
    }
  }
});

test('unexpected filter values cannot crash label rendering and fail validation', () => {
  const filters = { ...emptyFilters, expiry: 'unexpected' };
  assert.notEqual(filterError(filters), '');
  assert.doesNotThrow(() => filterTags(filters));
});
