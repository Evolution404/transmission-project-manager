import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnv } from '../scripts/notion/init.mjs';

test('Notion storage local env parser keeps only secret input concerns', () => {
  const source = 'NOTION_API_TOKEN="secret-value"\nAUTH_CREDENTIAL_PEPPER="pepper-value"\n';
  const env = parseEnv(source);
  assert.equal(env.NOTION_API_TOKEN, 'secret-value');
  assert.equal(env.AUTH_CREDENTIAL_PEPPER, 'pepper-value');
});
