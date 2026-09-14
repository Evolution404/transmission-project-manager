import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { app } from '../apps/api/src/app.ts';
import { createNodePersistence } from '../apps/api/src/runtime/node/persistence.ts';
import { bootstrapAdmin, cookiePair, jsonRequest, mutation } from './helpers/auth.mjs';

const apiDir = resolve(import.meta.dirname, '../apps/api');
const migrationsDir = resolve(apiDir, 'migrations');
const migrationFiles = readdirSync(migrationsDir).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function applyMigrations(database) {
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const applied = new Set(database.prepare('SELECT name FROM d1_migrations').all().map((row) => row.name));
  const record = database.prepare('INSERT INTO d1_migrations (name) VALUES (?)');
  for (const name of migrationFiles) {
    if (applied.has(name)) continue;
    database.exec(readFileSync(resolve(migrationsDir, name), 'utf8'));
    record.run(name);
  }
}

function createRuntime(database, objectRoot) {
  const persistence = createNodePersistence({ database, objectRoot });
  const env = {
    APP_ENV: 'test',
    PERSISTENCE: persistence,
    AUTH_CREDENTIAL_PEPPER: 'node-runtime-e2e-pepper',
    BOOTSTRAP_TOKEN: 'node-runtime-bootstrap',
  };
  return {
    persistence,
    request(path, init = {}) {
      return app.request(path, init, env);
    },
  };
}

test('Node + SQLite + Filesystem serves the real HTTP app and survives restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tpm-node-app-'));
  const databasePath = join(root, 'runtime.sqlite');
  const objectRoot = join(root, 'objects');
  let database = new DatabaseSync(databasePath);
  try {
    applyMigrations(database);
    let runtime = createRuntime(database, objectRoot);

    const health = await jsonRequest(runtime, '/api/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.body.data.schema.ready, true);
    assert.equal(health.body.data.schema.currentMigration, '0012_master_data_write_guards.sql');

    const statusBefore = await jsonRequest(runtime, '/api/auth/status');
    assert.equal(statusBefore.body.data.initialized, false);

    const bootstrap = await bootstrapAdmin(runtime, { token: 'node-runtime-bootstrap' });
    assert.equal(bootstrap.response.status, 201);
    const cookie = cookiePair(bootstrap.response.headers.get('set-cookie'));

    const settings = await jsonRequest(runtime, '/api/settings', { headers: { Cookie: cookie } });
    assert.equal(settings.response.status, 200);
    assert.ok(settings.body.data.items.length > 0);

    const settingBody = { expectedVersion: null, value: { runtime: 'node-sqlite-filesystem' } };
    const settingInit = mutation('PUT', settingBody, { Cookie: cookie, 'Idempotency-Key': 'node-setting-1' });
    const setting = await jsonRequest(runtime, '/api/settings/runtime.node', settingInit);
    assert.equal(setting.response.status, 200);
    const settingReplay = await jsonRequest(runtime, '/api/settings/runtime.node', settingInit);
    assert.deepEqual(settingReplay.body, setting.body);

    const createdVoltage = await jsonRequest(runtime, '/api/master/voltage-levels', mutation('POST', {
      code: 'NODE-330', displayName: '330kV Node', systemType: 'AC', nominalKv: 330, sortOrder: 330,
    }, { Cookie: cookie, 'Idempotency-Key': 'node-voltage-1' }));
    assert.equal(createdVoltage.response.status, 201);

    const voltages = await jsonRequest(runtime, '/api/master/voltage-levels', { headers: { Cookie: cookie } });
    assert.ok(voltages.body.data.items.some((item) => item.code === 'NODE-330'));

    const backup = await jsonRequest(runtime, '/api/backups', mutation('POST', {
      backupDate: '2026-09-14', kind: 'daily',
    }, { Cookie: cookie, 'Idempotency-Key': 'node-backup-1' }));
    assert.equal(backup.response.status, 201);
    const backupId = backup.body.data.id;

    const step = await jsonRequest(runtime, `/api/backups/${backupId}/step`, mutation('POST', {}, {
      Cookie: cookie, 'Idempotency-Key': 'node-backup-step-1',
    }));
    assert.equal(step.response.status, 200);
    const chunk = database.prepare('SELECT r2_key,table_name FROM backup_chunks WHERE backup_run_id=? ORDER BY chunk_index LIMIT 1').get(backupId);
    assert.equal(chunk.table_name, 'members');
    const stored = await runtime.persistence.objectStore.get(chunk.r2_key);
    assert.ok(stored, 'backup chunk must be written through FilesystemObjectStoreAdapter');
    const payload = JSON.parse(new TextDecoder().decode(await stored.bytes()));
    assert.equal(payload.table, 'members');
    assert.ok(payload.rows.some((row) => row.username === 'admin'));

    database.close();
    database = new DatabaseSync(databasePath);
    runtime = createRuntime(database, objectRoot);

    const afterRestart = await jsonRequest(runtime, '/api/settings/runtime.node/history', { headers: { Cookie: cookie } });
    assert.equal(afterRestart.response.status, 200);
    assert.equal(afterRestart.body.data.items[0].value.runtime, 'node-sqlite-filesystem');
    const me = await jsonRequest(runtime, '/api/me', { headers: { Cookie: cookie } });
    assert.equal(me.response.status, 200);
    assert.equal(me.body.data.username, 'admin');
  } finally {
    try { database.close(); } catch { /* already closed */ }
    await rm(root, { recursive: true, force: true });
  }
});
