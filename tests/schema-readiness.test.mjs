import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bootstrapAdmin, cookiePair } from './helpers/auth.mjs';
import { cleanupStateDir, executeLocalD1, makeStateDir, startWranglerServer } from './helpers/wrangler.mjs';

const stateDir = makeStateDir('tpm-schema-readiness-');
let runtime;
let adminCookie;

before(async () => {
  executeLocalD1(stateDir, { file: 'migrations/0001_initial_schema.sql' });

  // The business schema exists, but the Wrangler migration ledger deliberately does not
  // record the required baseline. Readiness must fail closed without inventing legacy versions.
  executeLocalD1(stateDir, {
    command: `CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      DELETE FROM d1_migrations;`,
  });

  runtime = await startWranglerServer({
    stateDir,
    port: 8813,
    migrate: false,
    vars: ['AUTH_CREDENTIAL_PEPPER:schema-readiness-pepper', 'BOOTSTRAP_TOKEN:schema-readiness-bootstrap'],
  });
  const bootstrap = await bootstrapAdmin(runtime, { token: 'schema-readiness-bootstrap' });
  assert.equal(bootstrap.response.status, 201);
  adminCookie = cookiePair(bootstrap.response.headers.get('set-cookie'));
}, { timeout: 80000 });

after(async () => {
  await runtime?.stop();
  cleanupStateDir(stateDir);
});

test('health exposes explicit schema readiness when the database is behind code', async () => {
  const response = await runtime.request('/api/health');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.schema.ready, false);
  assert.equal(body.data.schema.currentMigration, null);
  assert.equal(body.data.schema.requiredMigration, '0001_initial_schema.sql');
});

test('authenticated business routes fail closed with SCHEMA_OUTDATED instead of reaching missing-table SQL', async () => {
  const response = await runtime.request('/api/analysis/dashboard?asOf=2026-09-13', {
    headers: { Cookie: adminCookie },
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'SCHEMA_OUTDATED');
  assert.match(body.error.message, /数据库结构/);
  assert.deepEqual(body.error.details, {
    ready: false,
    currentMigration: null,
    requiredMigration: '0001_initial_schema.sql',
  });
});
