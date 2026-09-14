import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const target = resolve(root, '.env');
const sources = [target, resolve(root, '.env.notion'), resolve(root, 'apps/api/.dev.vars')];
const required = ['CLOUDFLARE_API_TOKEN', 'AUTH_CREDENTIAL_PEPPER', 'NOTION_API_TOKEN'];
const outputKeys = [...required, 'BOOTSTRAP_TOKEN'];

function unquote(value) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    if (trimmed.startsWith('"')) {
      try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); }
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseDotenv(source) {
  const values = {};
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = unquote(line.slice(index + 1));
  }
  return values;
}

export function renderUnifiedEnv(values) {
  const missing = required.filter((key) => !values[key]?.trim());
  if (missing.length) throw new Error(`LOCAL_ENV_REQUIRED_SECRET_MISSING:${missing.join(',')}`);
  return [
    '# Local development / operations secrets only. Never commit this file.',
    ...outputKeys.map((key) => `${key}=${JSON.stringify(values[key] ?? '')}`),
    '',
  ].join('\n');
}

export async function migrateLocalEnv() {
  const values = {};
  for (const file of sources) {
    if (!existsSync(file)) continue;
    Object.assign(values, parseDotenv(await readFile(file, 'utf8')));
  }
  await writeFile(target, renderUnifiedEnv(values), { mode: 0o600 });
  await chmod(target, 0o600);
  for (const legacy of sources.slice(1)) {
    if (existsSync(legacy)) await unlink(legacy);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  migrateLocalEnv()
    .then(() => console.log('LOCAL_ENV_MIGRATION=PASS'))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
