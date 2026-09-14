import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlSystemConfigRepository } from '../apps/api/src/repositories/sql-system-config-repository.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE settings_versions (
      id TEXT PRIMARY KEY,setting_key TEXT NOT NULL,version INTEGER NOT NULL,value_json TEXT NOT NULL,
      effective_from TEXT NOT NULL,created_by TEXT,created_at TEXT NOT NULL,UNIQUE(setting_key,version)
    );
    CREATE TABLE dictionary_items (
      id TEXT PRIMARY KEY,dictionary_key TEXT NOT NULL,item_key TEXT NOT NULL,label TEXT NOT NULL,
      value_json TEXT,enabled INTEGER NOT NULL,sort_order INTEGER NOT NULL,version INTEGER NOT NULL,
      UNIQUE(dictionary_key,item_key)
    );
    CREATE TABLE audit_events (id TEXT PRIMARY KEY,actor_member_id TEXT,action TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL);
    CREATE TABLE idempotency_records (idempotency_key TEXT PRIMARY KEY,actor_member_id TEXT NOT NULL,operation TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,status_code INTEGER NOT NULL,created_at TEXT NOT NULL);
    INSERT INTO settings_versions VALUES ('s1','ui.test',1,'{"enabled":false}','2026-09-01T00:00:00.000Z','admin','2026-09-01T00:00:00.000Z');
    INSERT INTO dictionary_items VALUES ('d1','role','admin','管理员','{"level":1}',1,1,1);
  `);
  return { sqlite, repository: new SqlSystemConfigRepository(new SqliteDatabaseAdapter(sqlite)) };
}

test('system config repository reads settings and dictionaries portably', async () => {
  const { sqlite, repository } = fixture();
  try {
    assert.equal((await repository.listCurrentSettings())[0].value.enabled, false);
    assert.equal((await repository.getSettingHistory('ui.test'))[0].version, 1);
    assert.equal((await repository.listDictionary('role'))[0].label, '管理员');
    assert.equal(await repository.currentSettingVersion('ui.test'), 1);
  } finally { sqlite.close(); }
});

test('setting version write keeps business row, audit, and idempotency atomic', async () => {
  const { sqlite, repository } = fixture();
  try {
    await repository.createSettingVersion({
      id: 's2', key: 'ui.test', version: 2, valueJson: '{"enabled":true}',
      effectiveFrom: '2026-09-14T00:00:00.000Z', createdBy: 'admin', createdAt: '2026-09-14T00:00:00.000Z',
    }, {
      auditId: 'a1', actorId: 'admin', beforeJson: '{"version":1}', afterJson: '{"version":2}',
      idempotencyKey: 'i1', operation: 'settings.put:ui.test', requestHash: 'h1', responseJson: '{"ok":true}', statusCode: 200,
    });
    assert.equal(await repository.currentSettingVersion('ui.test'), 2);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='a1'").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='i1'").get().count, 1);

    await assert.rejects(repository.createSettingVersion({
      id: 's3', key: 'ui.test', version: 2, valueJson: '{}', effectiveFrom: '2026-09-15T00:00:00.000Z', createdBy: 'admin', createdAt: '2026-09-15T00:00:00.000Z',
    }, {
      auditId: 'a2', actorId: 'admin', beforeJson: '{}', afterJson: '{}', idempotencyKey: 'i2', operation: 'settings.put:ui.test', requestHash: 'h2', responseJson: '{}', statusCode: 200,
    }));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='a2'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='i2'").get().count, 0);
  } finally { sqlite.close(); }
});
