import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlMasterDataWriteRepository } from '../apps/api/src/repositories/sql-master-data-write-repository.ts';

function createRepository() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE voltage_levels (
      id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL UNIQUE,
      system_type TEXT NOT NULL, nominal_kv INTEGER NOT NULL, sort_order INTEGER NOT NULL,
      enabled INTEGER NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE transmission_lines (
      id TEXT PRIMARY KEY, voltage_level_id TEXT NOT NULL REFERENCES voltage_levels(id),
      line_code TEXT, line_name TEXT NOT NULL, enabled INTEGER NOT NULL, version INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(voltage_level_id,line_name)
    );
    CREATE TABLE transmission_towers (
      id TEXT PRIMARY KEY, line_id TEXT NOT NULL REFERENCES transmission_lines(id),
      tower_no TEXT NOT NULL, sort_index INTEGER NOT NULL, tower_type TEXT,
      enabled INTEGER NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(line_id,tower_no), UNIQUE(line_id,sort_index)
    );
    CREATE TABLE master_data_guards (valid INTEGER NOT NULL);
    CREATE TRIGGER master_data_guard BEFORE INSERT ON master_data_guards
      WHEN NEW.valid<>1 BEGIN SELECT RAISE(ABORT,'MASTER_DATA_GUARD_FAILED'); END;
    CREATE TRIGGER master_data_guard_cleanup AFTER INSERT ON master_data_guards
      BEGIN DELETE FROM master_data_guards; END;
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY, actor_member_id TEXT, action TEXT NOT NULL, object_type TEXT NOT NULL,
      object_id TEXT NOT NULL, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE idempotency_records (
      idempotency_key TEXT PRIMARY KEY, actor_member_id TEXT NOT NULL, operation TEXT NOT NULL,
      request_hash TEXT NOT NULL, response_json TEXT NOT NULL, status_code INTEGER NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const database = new SqliteDatabaseAdapter(sqlite);
  return { sqlite, database, repository: new SqlMasterDataWriteRepository(database) };
}

const mutation = (suffix, responseJson = '{"ok":true}') => ({
  key: `key-${suffix}`,
  actorId: 'admin-1',
  operation: `POST:/master/${suffix}`,
  hash: `hash-${suffix}`,
  responseJson,
  statusCode: 201,
  now: '2026-09-14T01:00:00.000Z',
  auditId: `audit-${suffix}`,
});

test('single master-data create persists business row, audit and idempotency atomically', async () => {
  const { sqlite, repository } = createRepository();
  try {
    await repository.commitSingle({
      kind: 'voltage-level',
      action: 'create',
      id: 'vl-110',
      values: { code: 'AC110', displayName: '110kV', systemType: 'AC', nominalKv: 110, sortOrder: 10, enabled: true },
      expectedVersion: null,
      mutation: mutation('vl-110'),
      audit: { action: 'master.voltage-levels.create', objectType: 'voltage_levels', before: null, after: { id: 'vl-110' } },
    });
    assert.equal(sqlite.prepare("SELECT display_name FROM voltage_levels WHERE id='vl-110'").get().display_name, '110kV');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE object_id='vl-110'").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='key-vl-110'").get().count, 1);
  } finally { sqlite.close(); }
});

test('single master-data update rejects stale version without leaving audit or idempotency rows', async () => {
  const { sqlite, repository } = createRepository();
  try {
    sqlite.prepare(`INSERT INTO voltage_levels VALUES (?,?,?,?,?,?,?,?,?,?)`).run('vl-110','AC110','110kV','AC',110,10,1,2,'t','t');
    await assert.rejects(repository.commitSingle({
      kind: 'voltage-level', action: 'update', id: 'vl-110',
      values: { code: 'AC110', displayName: '110kV-new', systemType: 'AC', nominalKv: 110, sortOrder: 10, enabled: true },
      expectedVersion: 1,
      mutation: mutation('stale'),
      audit: { action: 'master.voltage-levels.update', objectType: 'voltage_levels', before: { version: 2 }, after: { version: 2 } },
    }));
    assert.equal(sqlite.prepare("SELECT display_name FROM voltage_levels WHERE id='vl-110'").get().display_name, '110kV');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get().count, 0);
  } finally { sqlite.close(); }
});

test('line create rechecks enabled parent inside the same atomic batch', async () => {
  const { sqlite, repository } = createRepository();
  try {
    sqlite.prepare(`INSERT INTO voltage_levels VALUES (?,?,?,?,?,?,?,?,?,?)`).run('vl-110','AC110','110kV','AC',110,10,0,1,'t','t');
    await assert.rejects(repository.commitSingle({
      kind: 'line', action: 'create', id: 'line-1',
      values: { voltageLevelId: 'vl-110', lineName: 'Line A', lineCode: null, enabled: true },
      expectedVersion: null,
      requireEnabledParent: true,
      mutation: mutation('line-1'),
      audit: { action: 'master.lines.create', objectType: 'transmission_lines', before: null, after: { id: 'line-1' } },
    }), /MASTER_DATA_GUARD_FAILED/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM transmission_lines").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get().count, 0);
  } finally { sqlite.close(); }
});
