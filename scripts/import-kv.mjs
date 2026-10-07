import { readFile, writeFile } from 'node:fs/promises';

// Accept a Wrangler KV key-list export (metadata) or a bulk export (values).
const [input, output] = process.argv.slice(2);
if (!input || !output) {
    console.error('Usage: pnpm db:import:kv kv-export.json kv-import.sql');
    process.exit(1);
}
const records = JSON.parse(await readFile(input, 'utf8'));
if (!Array.isArray(records)) throw new Error('Expected a JSON array of KV keys.');
const timestamps = new Map();
for (const record of records) {
    const key = record.name ?? record.key;
    if (typeof key !== 'string' || !/^image:[a-z]{32}$/.test(key)) continue;
    const value = record.metadata?.lastAccessedAt ?? record.value;
    const time = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)) ? Number(value) : NaN;
    if (!Number.isSafeInteger(time) || time < 0) throw new Error(`Missing or invalid timestamp for ${key}; export its KV value before importing.`);
    const id = key.slice(6);
    timestamps.set(id, Math.max(time, timestamps.get(id) ?? 0));
}
if (!timestamps.size) throw new Error('No valid image access records found.');
const sql = [...timestamps].map(([id, time]) => `INSERT INTO image_access (image_id, last_accessed_at) VALUES ('${id}', ${time}) ON CONFLICT(image_id) DO UPDATE SET last_accessed_at = MAX(image_access.last_accessed_at, excluded.last_accessed_at);`).join('\n');
await writeFile(output, sql + '\n', { flag: 'wx', mode: 0o600 });
console.log(`Prepared ${timestamps.size} records in ${output}; apply this file to D1 before deployment.`);
