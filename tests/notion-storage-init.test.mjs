import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnv, setEnvValue } from '../scripts/notion/init.mjs';

test('Notion storage env parser supports quoted values and ID updates without altering secrets', () => {
  const source = 'OBJECT_STORAGE_PROVIDER=notion\nNOTION_API_TOKEN=secret-value\nNOTION_STORAGE_ROOT_TITLE="Transmission Project Manager Storage"\nNOTION_STORAGE_DATA_SOURCE_ID=\n';
  const env = parseEnv(source);
  assert.equal(env.OBJECT_STORAGE_PROVIDER, 'notion');
  assert.equal(env.NOTION_API_TOKEN, 'secret-value');
  assert.equal(env.NOTION_STORAGE_ROOT_TITLE, 'Transmission Project Manager Storage');
  const updated = setEnvValue(source, 'NOTION_STORAGE_DATA_SOURCE_ID', '12345678-1234-4321-8321-123456789abc');
  assert.match(updated, /NOTION_API_TOKEN=secret-value/);
  assert.match(updated, /NOTION_STORAGE_DATA_SOURCE_ID=12345678-1234-4321-8321-123456789abc/);
});
