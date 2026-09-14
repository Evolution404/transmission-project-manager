import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { app } from '../apps/api/src/app.ts';
import { createNodePersistence } from '../apps/api/src/runtime/node/persistence.ts';
import { hashSessionToken, SESSION_COOKIE } from '../apps/api/src/session.ts';

const apiDir = resolve(import.meta.dirname, '../apps/api');
const migrationsDir = resolve(apiDir, 'migrations');
const migrationFiles = readdirSync(migrationsDir).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function ensureMigrationTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function applyMigrations(database, names) {
  ensureMigrationTable(database);
  const record = database.prepare('INSERT INTO d1_migrations (name) VALUES (?)');
  for (const name of names) {
    database.exec(readFileSync(resolve(migrationsDir, name), 'utf8'));
    record.run(name);
  }
}

function runtime(database, objectRoot) {
  const env = {
    APP_ENV: 'test',
    PERSISTENCE: createNodePersistence({ database, objectRoot }),
  };
  return {
    request(path, init = {}) {
      return app.request(path, init, env);
    },
  };
}

async function jsonRequest(target, path, init = {}) {
  const response = await target.request(path, init);
  return { response, body: await response.json() };
}

test('P7-era SQLite data upgrades through 0012 and boots in the Node application runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tpm-node-upgrade-'));
  const databasePath = join(root, 'upgrade.sqlite');
  const objectRoot = join(root, 'objects');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON;');
    const oldMigrations = migrationFiles.filter((name) => name <= '0007_p7_flexible_demand_sources.sql');
    const newMigrations = migrationFiles.filter((name) => name > '0007_p7_flexible_demand_sources.sql');
    applyMigrations(database, oldMigrations);

    const now = '2026-09-12T00:00:00.000Z';
    database.exec(`
      INSERT INTO members
        (id,username,display_name,role,enabled,version,credential_salt,credential_verifier,
         credential_algorithm,credential_params_json,must_change_password,session_version,
         failed_login_count,credential_changed_at,invited_at,first_login_at,last_login_at,created_at,updated_at)
      VALUES
        ('upgrade-admin','upgrade-admin','升级演练管理员','admin',1,1,'salt','verifier','argon2id-v1',
         '{"algorithm":"argon2id-v1","memoryCostKiB":19456,"timeCost":2,"parallelism":1,"hashLength":32,"version":19}',
         0,1,0,'${now}','${now}','${now}','${now}','${now}','${now}');
      INSERT INTO member_scopes (id,member_id,scope_type,scope_id,created_at)
      VALUES ('upgrade-scope','upgrade-admin','all',NULL,'${now}');
      INSERT INTO settings_versions (id,setting_key,version,value_json,effective_from,created_by,created_at)
      VALUES ('upgrade-setting','upgrade.marker',1,'{"preserved":true}','${now}','upgrade-admin','${now}');
      INSERT INTO import_batches
        (id,file_name,file_sha256,file_type,mapping_json,status,uploaded_rows,valid_rows,error_rows,warning_rows,published_rows,version,created_by,created_at,updated_at,published_at)
      VALUES ('upgrade-batch','历史需求.xlsx','${'8'.repeat(64)}','xlsx','{}','published',1,1,0,0,1,1,'upgrade-admin','${now}','${now}','${now}');
      INSERT INTO import_rows
        (id,batch_id,chunk_index,sheet_name,source_row_number,source_key,raw_json,normalized_json,errors_json,warnings_json,row_status,published_demand_id,created_at,updated_at)
      VALUES ('upgrade-row','upgrade-batch',0,'需求',9,'upgrade-source','{"序号":"9"}','{}','[]','[]','published','upgrade-demand','${now}','${now}');
      INSERT INTO demands
        (id,source_type,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,
         sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,business_signature,
         raw_json,extra_json,version,created_by,created_at,updated_at)
      VALUES
        ('upgrade-demand','import','upgrade-source','upgrade-batch','${'8'.repeat(64)}','历史需求.xlsx','需求',9,
         '9',2026,'220kV','220kV','升级历史线','#1-#2','防鸟',NULL,'upgrade-signature','{"序号":"9"}','{}',1,'upgrade-admin','${now}','${now}');
      INSERT INTO demand_materials (id,demand_id,raw_model,material_id,quantity_scaled,unit,created_at)
      VALUES ('upgrade-dm','upgrade-demand','JX-UPGRADE',NULL,10000,'套','${now}');
      INSERT INTO projects (id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at)
      VALUES ('upgrade-project','升级历史储备',2026,NULL,'draft',0,NULL,1,'upgrade-admin','${now}','${now}');
      INSERT INTO demand_allocations (id,project_id,demand_material_id,quantity_scaled,created_at)
      VALUES ('upgrade-allocation','upgrade-project','upgrade-dm',10000,'${now}');
    `);

    applyMigrations(database, newMigrations);

    assert.deepEqual(
      database.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map((row) => row.name),
      migrationFiles,
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM demand_allocations WHERE id='upgrade-allocation'").get().count, 1);
    assert.equal(database.prepare("SELECT import_row_id FROM demand_source_rows WHERE demand_id='upgrade-demand'").get().import_row_id, 'upgrade-row');
    assert.equal(database.prepare("SELECT source_import_row_id FROM demand_materials WHERE id='upgrade-dm'").get().source_import_row_id, 'upgrade-row');

    const token = 'upgrade-runtime-session-token';
    const tokenHash = await hashSessionToken(token);
    database.prepare(`
      INSERT INTO auth_sessions (id,member_id,token_hash,session_version,created_at,last_seen_at,expires_at,revoked_at)
      VALUES (?,?,?,?,?,?,?,NULL)
    `).run('upgrade-session', 'upgrade-admin', tokenHash, 1, now, now, '2099-01-01T00:00:00.000Z');

    const target = runtime(database, objectRoot);
    const cookie = `${SESSION_COOKIE}=${token}`;
    const health = await jsonRequest(target, '/api/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.body.data.schema.ready, true);
    assert.equal(health.body.data.schema.currentMigration, '0012_master_data_write_guards.sql');

    const setting = await jsonRequest(target, '/api/settings/upgrade.marker/history', { headers: { Cookie: cookie } });
    assert.equal(setting.response.status, 200);
    assert.equal(setting.body.data.items[0].value.preserved, true);

    const lifecycle = await jsonRequest(target, '/api/projects/upgrade-project/lifecycle', { headers: { Cookie: cookie } });
    assert.equal(lifecycle.response.status, 200);
    assert.equal(lifecycle.body.data.lines.length, 1);
    assert.equal(lifecycle.body.data.lines[0].demandMaterialId, 'upgrade-dm');
    assert.equal(lifecycle.body.data.lines[0].allocatedQuantityScaled, 10000);
    assert.equal(lifecycle.body.data.projectState, 'unimplemented_unsettled');
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
