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

test('history cleanup selects old root-level alphanumeric images without touching unrelated paths', t => {
    const directory = mkdtempSync(join(tmpdir(), 'image-history-test-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const selected = [`${'a1'.repeat(16)}.jpeg`, `${'0'.repeat(32)}.png`, `${'b2'.repeat(16)}.webp`];
    const logPath = join(directory, 'deletions.txt');
    const argsPath = join(directory, 'filter-args.json');
    writeFileSync(logPath, [
        '@@DELETE_COMMIT:1900000', `${'d1'.repeat(16)}.png`,
        '@@DELETE_COMMIT:1000000', ...selected,
        `nested/${selected[0]}`, `${'A'.repeat(32)}.png`, `${'a'.repeat(31)}.jpeg`, 'README.md',
    ].join('\n'));
    // Fake git records the selected filter-repo arguments. No Git repository or
    // real history rewrite is used by this test.
    writeFileSync(join(directory, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'log') process.stdout.write(fs.readFileSync(process.env.IMAGE_TEST_GIT_LOG));
else if (args[0] === 'cat-file') process.exit(1);
else if (args[0] === 'filter-repo') fs.writeFileSync(process.env.IMAGE_TEST_GIT_ARGS, JSON.stringify(args));
else process.exit(99);
`, { mode: 0o755 });
    execFileSync('bash', [fileURLToPath(new URL('../target-repository/scripts/purge-deleted-image-history.sh', import.meta.url))], {
        cwd: directory,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, NOW_EPOCH: '2000000', RETENTION_DAYS: '7', IMAGE_TEST_GIT_LOG: logPath, IMAGE_TEST_GIT_ARGS: argsPath },
    });
    const args = JSON.parse(readFileSync(argsPath, 'utf8'));
    assert.deepEqual(args, ['filter-repo', '--force', '--invert-paths', ...selected.sort().flatMap(path => ['--path', path])]);
});
