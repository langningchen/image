import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const id = process.env.D1_DATABASE_ID;
if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id)) {
    console.error('Set D1_DATABASE_ID to your real D1 database UUID before using remote commands.');
    process.exit(1);
}
const args = process.argv.slice(2);
if (!args.length || args.some(arg => arg === '--config' || arg === '-c' || arg.startsWith('--config='))) {
    console.error('Usage: pnpm wrangler:remote <wrangler command> (config is generated automatically)');
    process.exit(1);
}
const template = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const config = JSON.parse(template.replace(/^\/\/.*$/gm, ''));
config.d1_databases[0].database_id = id;
const configPath = fileURLToPath(new URL('../wrangler.deploy.jsonc', import.meta.url));
await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
const result = spawnSync(fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url)), [...args, '--config', configPath], { cwd: root, stdio: 'inherit', env: process.env });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
