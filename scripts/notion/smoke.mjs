import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NotionObjectStoreAdapter } from '../../apps/api/src/adapters/notion/notion-object-store.ts';
import { parseEnv } from './init.mjs';

const root = resolve(import.meta.dirname, '../..');
const env = { ...process.env, ...parseEnv(await readFile(resolve(root, '.env'), 'utf8')) };
const config = JSON.parse(await readFile(resolve(root, 'apps/api/wrangler.production.jsonc'), 'utf8'));
const token = env.NOTION_API_TOKEN?.trim();
const dataSourceId = config.vars?.NOTION_STORAGE_DATA_SOURCE_ID?.trim();
const apiVersion = config.vars?.NOTION_API_VERSION?.trim() || '2026-03-11';

if (!token) throw new Error('NOTION_API_TOKEN_REQUIRED');
if (config.vars?.OBJECT_STORAGE_PROVIDER !== 'notion') throw new Error('NOTION_STORAGE_PROVIDER_NOT_ACTIVE');
if (!dataSourceId) throw new Error('NOTION_STORAGE_DATA_SOURCE_ID_REQUIRED');

const store = new NotionObjectStoreAdapter({ token, dataSourceId, apiVersion });
const key = `smoke/notion-object-store-${Date.now()}.txt`;
const expected = 'notion-storage-smoke';

await store.put(key, expected, { contentType: 'text/plain', custom: { purpose: 'smoke' } });
const stored = await store.get(key);
if (!stored) throw new Error('NOTION_SMOKE_GET_MISSING');
const actual = new TextDecoder().decode(await stored.bytes());
if (actual !== expected) throw new Error('NOTION_SMOKE_CONTENT_MISMATCH');
if (stored.metadata.contentType !== 'text/plain') throw new Error('NOTION_SMOKE_CONTENT_TYPE_MISMATCH');
if (stored.metadata.sizeBytes !== new TextEncoder().encode(expected).byteLength) throw new Error('NOTION_SMOKE_SIZE_MISMATCH');
if (stored.metadata.custom.purpose !== 'smoke') throw new Error('NOTION_SMOKE_METADATA_MISMATCH');

await store.delete(key);
if (await store.get(key) !== null) throw new Error('NOTION_SMOKE_DELETE_FAILED');

console.log('NOTION_OBJECT_STORE_SMOKE=PASS');
