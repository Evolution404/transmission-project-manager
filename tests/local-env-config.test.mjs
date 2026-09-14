import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDotenv, renderUnifiedEnv } from '../scripts/config/local-env.mjs';

test('local env migration keeps only the four approved secret keys', () => {
  const values = {
    ...parseDotenv('CLOUDFLARE_API_TOKEN="cf-token"\nCLOUDFLARE_ACCOUNT_ID=non-secret-id\n'),
    ...parseDotenv('NOTION_API_TOKEN="notion-token"\nNOTION_STORAGE_DATA_SOURCE_ID=resource-id\n'),
    ...parseDotenv('AUTH_CREDENTIAL_PEPPER="pepper"\nBOOTSTRAP_TOKEN="bootstrap"\n'),
  };
  const rendered = renderUnifiedEnv(values);
  assert.match(rendered, /CLOUDFLARE_API_TOKEN="cf-token"/);
  assert.match(rendered, /AUTH_CREDENTIAL_PEPPER="pepper"/);
  assert.match(rendered, /NOTION_API_TOKEN="notion-token"/);
  assert.match(rendered, /BOOTSTRAP_TOKEN="bootstrap"/);
  assert.doesNotMatch(rendered, /CLOUDFLARE_ACCOUNT_ID|NOTION_STORAGE_DATA_SOURCE_ID/);
});

test('local env migration fails closed when a long-lived secret is missing', () => {
  assert.throws(
    () => renderUnifiedEnv({ CLOUDFLARE_API_TOKEN: 'cf', AUTH_CREDENTIAL_PEPPER: 'pepper' }),
    /LOCAL_ENV_REQUIRED_SECRET_MISSING:NOTION_API_TOKEN/,
  );
});
