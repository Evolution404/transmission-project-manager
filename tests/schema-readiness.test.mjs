import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bootstrapAdmin, cookiePair } from './helpers/auth.mjs';
import { cleanupStateDir, executeLocalD1, makeStateDir, startWranglerServer } from './helpers/wrangler.mjs';

const stateDir = makeStateDir('tpm-schema-readiness-');
let runtime;
let adminCookie;

before(async () => {
  for (const migration of [
    'migrations/0001_p1_identity_and_config.sql',
    'migrations/0002_p2_import_demands_materials.sql',
    'migrations/0003_p3_reserve_projects.sql',
    'migrations/0004_p4_finance.sql',
    'migrations/0005_p5_delivery_implementation_settlement.sql',
    'migrations/0006_p6_analysis_notifications_backups.sql',
    'migrations/0007_p7_flexible_demand_sources.sql',
  ]) executeLocalD1(stateDir, { file: migration });

  // Wrangler tracks migrations through d1_migrations only when they are applied by the migration command.
  // This fixture deliberately represents a database whose business tables stop at 0007.
  executeLocalD1(stateDir, {
    command: `CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      DELETE FROM d1_migrations;
      INSERT INTO d1_migrations (name) VALUES
        ('0001_p1_identity_and_config.sql'),
        ('0002_p2_import_demands_materials.sql'),
        ('0003_p3_reserve_projects.sql'),
        ('0004_p4_finance.sql'),
        ('0005_p5_delivery_implementation_settlement.sql'),
        ('0006_p6_analysis_notifications_backups.sql'),
        ('0007_p7_flexible_demand_sources.sql');`,
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
  assert.equal(body.data.schema.currentMigration, '0007_p7_flexible_demand_sources.sql');
  assert.equal(body.data.schema.requiredMigration, '0012_master_data_write_guards.sql');
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
    currentMigration: '0007_p7_flexible_demand_sources.sql',
    requiredMigration: '0012_master_data_write_guards.sql',
  });
});
