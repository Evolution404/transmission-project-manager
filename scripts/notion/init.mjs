import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const ENV_PATH = resolve(ROOT, '.env');
const CONFIG_PATH = resolve(ROOT, 'apps/api/wrangler.production.jsonc');
const DEFAULT_VERSION = '2026-03-11';
const ROOT_TITLE = 'Transmission Project Manager Storage';
const DATABASE_TITLE = 'TPM Object Store';
const REQUIRED_PROPERTIES = {
  'Object Key': 'title',
  File: 'files',
  'Content Type': 'rich_text',
  'Size Bytes': 'number',
  'Custom Metadata': 'rich_text',
  State: 'select',
  'Created At': 'date',
  'Updated At': 'date',
};

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    if (trimmed.startsWith('"')) {
      try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); }
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseEnv(source) {
  const result = {};
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    result[trimmed.slice(0, index).trim()] = unquote(trimmed.slice(index + 1));
  }
  return result;
}

function schema() {
  return {
    'Object Key': { title: {} },
    File: { files: {} },
    'Content Type': { rich_text: {} },
    'Size Bytes': { number: { format: 'number' } },
    'Custom Metadata': { rich_text: {} },
    State: { select: { options: [{ name: 'active', color: 'green' }, { name: 'deleted', color: 'gray' }] } },
    'Created At': { date: {} },
    'Updated At': { date: {} },
  };
}

function validateSchema(dataSource) {
  const properties = dataSource?.properties ?? {};
  const problems = [];
  for (const [name, type] of Object.entries(REQUIRED_PROPERTIES)) {
    if (properties[name]?.type !== type) problems.push(`${name}:${properties[name]?.type ?? 'missing'}!=${type}`);
  }
  if (problems.length) throw new Error(`NOTION_STORAGE_SCHEMA_MISMATCH:${problems.join(',')}`);
}

function pageTitle(page) {
  for (const property of Object.values(page?.properties ?? {})) {
    if (property?.type === 'title') return (property.title ?? []).map(item => item?.plain_text ?? '').join('');
  }
  return '';
}

async function run() {
  const env = { ...process.env, ...parseEnv(await readFile(ENV_PATH, 'utf8')) };
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const token = env.NOTION_API_TOKEN?.trim();
  const version = config.vars?.NOTION_API_VERSION?.trim() || DEFAULT_VERSION;
  if (!token) throw new Error('NOTION_API_TOKEN_REQUIRED');
  if (config.vars?.OBJECT_STORAGE_PROVIDER !== 'notion') throw new Error('NOTION_STORAGE_PROVIDER_NOT_ACTIVE');

  const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': version, 'Content-Type': 'application/json' };
  const request = async (path, init = {}) => {
    const response = await fetch(`https://api.notion.com/v1${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.object === 'error') throw new Error(`NOTION_API_ERROR:${response.status}:${body?.code ?? 'unknown'}`);
    return body;
  };

  const me = await request('/users/me');
  if (me?.type !== 'bot') throw new Error('NOTION_CONNECTION_IS_NOT_BOT');

  const search = await request('/search', {
    method: 'POST',
    body: JSON.stringify({ query: ROOT_TITLE, filter: { property: 'object', value: 'page' }, page_size: 20 }),
  });
  const matches = (search.results ?? []).filter(page => !page.in_trash && pageTitle(page) === ROOT_TITLE);
  if (matches.length !== 1) throw new Error(`NOTION_STORAGE_ROOT_MATCH_COUNT:${matches.length}`);
  const parentPageId = matches[0].id;

  let dataSourceId = config.vars?.NOTION_STORAGE_DATA_SOURCE_ID?.trim();
  let databaseId;

  if (dataSourceId) {
    const dataSource = await request(`/data_sources/${encodeURIComponent(dataSourceId)}`);
    validateSchema(dataSource);
    databaseId = dataSource?.parent?.database_id;
  } else {
    const dataSourceSearch = await request('/search', {
      method: 'POST',
      body: JSON.stringify({ query: DATABASE_TITLE, filter: { property: 'object', value: 'data_source' }, page_size: 20 }),
    });
    for (const candidate of dataSourceSearch.results ?? []) {
      const candidateDatabaseId = candidate?.parent?.database_id;
      if (!candidateDatabaseId) continue;
      const database = await request(`/databases/${encodeURIComponent(candidateDatabaseId)}`);
      if (database?.parent?.page_id !== parentPageId) continue;
      dataSourceId = candidate.id;
      databaseId = candidateDatabaseId;
      validateSchema(await request(`/data_sources/${encodeURIComponent(dataSourceId)}`));
      break;
    }
  }

  if (!dataSourceId) {
    const database = await request('/databases', {
      method: 'POST',
      body: JSON.stringify({
        parent: { type: 'page_id', page_id: parentPageId },
        title: [{ type: 'text', text: { content: DATABASE_TITLE } }],
        description: [{ type: 'text', text: { content: 'Private object index managed by Transmission Project Manager.' } }],
        is_inline: false,
        initial_data_source: { properties: schema() },
      }),
    });
    databaseId = database.id;
    const retrieved = await request(`/databases/${encodeURIComponent(databaseId)}`);
    const candidates = retrieved.data_sources ?? [];
    if (candidates.length !== 1) throw new Error(`NOTION_INITIAL_DATA_SOURCE_COUNT:${candidates.length}`);
    dataSourceId = candidates[0].id;
    validateSchema(await request(`/data_sources/${encodeURIComponent(dataSourceId)}`));
  }

  if (config.vars.NOTION_STORAGE_DATA_SOURCE_ID !== dataSourceId) {
    config.vars.NOTION_STORAGE_DATA_SOURCE_ID = dataSourceId;
    await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  }

  console.log('NOTION_STORAGE_INIT=PASS');
  console.log(`parent_page_id=${parentPageId}`);
  console.log(`database_id=${databaseId ?? 'unknown'}`);
  console.log(`data_source_id=${dataSourceId}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
