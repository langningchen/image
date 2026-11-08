import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyFilters, type Api } from '../src/frontend/admin/model.ts';
import { loadWorkspaceSection, type Section } from '../src/frontend/admin/workspace.ts';

test('admin navigation requests only the visible section data', async () => {
  const expected: Record<Section, string[]> = {
    overview: ['/stats?days=7&sort=traffic', '/moderation-settings'],
    images: ['/images?', '/moderation-settings'],
    settings: ['/moderation-settings', '/upload-settings'],
    ips: ['/ips'],
    audit: ['/assessment-audit'],
  };
  for (const section of Object.keys(expected) as Section[]) {
    const calls: string[] = [];
    const api: Api = async <T>(path: string) => { calls.push(path); return {} as T; };
    await loadWorkspaceSection(api, section, emptyFilters, 7, 'traffic');
    assert.deepEqual(calls, expected[section]);
  }
});

test('image section loading retains filters without fetching traffic, IP history or audit data', async () => {
  const calls: string[] = [];
  const api: Api = async <T>(path: string) => { calls.push(path); return {} as T; };
  await loadWorkspaceSection(api, 'images', { ...emptyFilters, status: 'error', search: '192.0.2.1', expiry: 'due' }, 30, 'uploads');
  const query = new URLSearchParams(calls[0].split('?')[1]);
  assert.equal(query.get('status'), 'error');
  assert.equal(query.get('search'), '192.0.2.1');
  assert.equal(query.get('retention'), 'unlocked');
  assert.equal(query.get('maxDays'), '0');
  assert.equal(calls.length, 2);
});

test('navigation cancellation is passed to every section request', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const api: Api = async <T>(_path: string, init?: RequestInit) => {
    calls++;
    assert.equal(init?.signal, controller.signal);
    init?.signal?.throwIfAborted();
    return {} as T;
  };
  await assert.rejects(loadWorkspaceSection(api, 'overview', emptyFilters, 7, 'traffic', controller.signal), { name: 'AbortError' });
  assert.equal(calls, 2);
});
