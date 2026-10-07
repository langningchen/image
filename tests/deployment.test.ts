import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareDeployment } from '../scripts/deployment.mjs';

test('deployment creates missing databases and migrates before publishing', async () => {
    const calls: string[][] = [];
    await prepareDeployment({ binding: 'DB', database_name: 'image-access' }, (args: string[]) => {
        calls.push(args);
        return '[]';
    });
    assert.deepEqual(calls, [
        ['d1', 'list', '--json'],
        ['d1', 'create', 'image-access', '--no-update-config'],
        ['d1', 'migrations', 'apply', 'DB', '--remote'],
    ]);
});

test('deployment reuses existing databases and stops on discovery failure', async () => {
    const calls: string[][] = [];
    await prepareDeployment({ binding: 'DB', database_name: 'image-access' }, (args: string[]) => {
        calls.push(args);
        return JSON.stringify([{ name: 'image-access', uuid: 'existing' }]);
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1][1], 'migrations');
    await assert.rejects(prepareDeployment({ binding: 'DB', database_name: 'image-access' }, () => { throw new Error('Access denied'); }), /Access denied/);
});
