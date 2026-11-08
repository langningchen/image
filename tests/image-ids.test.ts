import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

test('KV import retains mixed and numeric IDs, ignores invalid keys and preserves newer timestamps', t => {
    const directory = mkdtempSync(join(tmpdir(), 'image-kv-import-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const mixed = 'a1'.repeat(16);
    const digits = '0'.repeat(32);
    const input = join(directory, 'export.json');
    const output = join(directory, 'import.sql');
    writeFileSync(input, JSON.stringify([
        { name: `image:${mixed}`, metadata: { lastAccessedAt: 200 } },
        { name: `image:${mixed}`, metadata: { lastAccessedAt: 100 } },
        { key: `image:${digits}`, value: '300' },
        { key: `image:${'A'.repeat(32)}`, value: '1' },
        { key: `image:${mixed.slice(1)}`, value: '1' },
        { key: `image:${'_'.repeat(32)}`, value: '1' },
    ]));
    execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/import-kv.mjs', import.meta.url)), input, output]);
    const sqlite = new DatabaseSync(':memory:');
    t.after(() => sqlite.close());
    const migrations = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
        sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
    }
    sqlite.prepare('INSERT INTO image_access (image_id, last_accessed_at) VALUES (?, ?)').run(mixed, 250);
    sqlite.exec(readFileSync(output, 'utf8'));
    const rows = sqlite.prepare('SELECT image_id, last_accessed_at FROM image_access ORDER BY image_id').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].image_id, digits);
    assert.equal(rows[0].last_accessed_at, 300);
    assert.equal(rows[1].image_id, mixed);
    assert.equal(rows[1].last_accessed_at, 250);
});

test('daily history cleanup selects deleted root-level images and preserves re-added images and unrelated paths', t => {
    const directory = mkdtempSync(join(tmpdir(), 'image-history-test-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const selected = [`${'d1'.repeat(16)}.png`, `${'a1'.repeat(16)}.jpeg`, `${'0'.repeat(32)}.png`, `${'b2'.repeat(16)}.webp`];
    selected.push(...Array.from({ length: 2500 }, (_, index) => `${(index + 1).toString(36).padStart(32, '0')}.png`));
    const kept = `${'e1'.repeat(16)}.png`;
    const logPath = join(directory, 'deletions.txt');
    const argsPath = join(directory, 'filter-args.json');
    const callsPath = join(directory, 'git-calls.json');
    writeFileSync(logPath, [
        ...selected, selected[0], kept,
        `nested/${selected[0]}`, `${'A'.repeat(32)}.png`, `${'a'.repeat(31)}.jpeg`, 'README.md',
    ].join('\n'));
    // Fake git records the selected filter-repo arguments. No Git repository or
    // real history rewrite is used by this test.
    writeFileSync(join(directory, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const calls = fs.existsSync(process.env.IMAGE_TEST_GIT_CALLS) ? JSON.parse(fs.readFileSync(process.env.IMAGE_TEST_GIT_CALLS)) : [];
calls.push(args[0]);
fs.writeFileSync(process.env.IMAGE_TEST_GIT_CALLS, JSON.stringify(calls));
if (args[0] === 'log') process.stdout.write(fs.readFileSync(process.env.IMAGE_TEST_GIT_LOG));
else if (args[0] === 'ls-tree') process.stdout.write(process.env.IMAGE_TEST_KEPT_PATH + String.fromCharCode(10));
else if (args[0] === 'filter-repo') fs.writeFileSync(process.env.IMAGE_TEST_GIT_ARGS, JSON.stringify({ args, paths: fs.readFileSync(args[args.indexOf('--paths-from-file') + 1], 'utf8') }));
else process.exit(99);
`, { mode: 0o755 });
    execFileSync('bash', [fileURLToPath(new URL('../target-repository/scripts/purge-deleted-image-history.sh', import.meta.url))], {
        cwd: directory,
        timeout: 10000,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, IMAGE_TEST_KEPT_PATH: kept, IMAGE_TEST_GIT_LOG: logPath, IMAGE_TEST_GIT_ARGS: argsPath, IMAGE_TEST_GIT_CALLS: callsPath },
    });
    const result = JSON.parse(readFileSync(argsPath, 'utf8'));
    assert.deepEqual(result.args.slice(0, 4), ['filter-repo', '--force', '--invert-paths', '--paths-from-file']);
    assert.equal(result.args.length, 5);
    assert.deepEqual(result.paths.trim().split('\n'), selected.sort());
    assert.deepEqual(JSON.parse(readFileSync(callsPath, 'utf8')), ['log', 'ls-tree', 'filter-repo']);
});
