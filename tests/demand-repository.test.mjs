import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlDemandRepository } from '../apps/api/src/repositories/sql-demand-repository.ts';

function createRepository() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE voltage_levels (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, enabled INTEGER NOT NULL);
    CREATE TABLE transmission_lines (id TEXT PRIMARY KEY, voltage_level_id TEXT NOT NULL, line_name TEXT NOT NULL, enabled INTEGER NOT NULL);
    CREATE TABLE transmission_towers (id TEXT PRIMARY KEY, line_id TEXT NOT NULL, tower_no TEXT NOT NULL, sort_rank INTEGER NOT NULL, enabled INTEGER NOT NULL);
    CREATE TABLE materials (id TEXT PRIMARY KEY, code TEXT, name TEXT NOT NULL, model TEXT NOT NULL, unit TEXT NOT NULL, enabled INTEGER NOT NULL, version INTEGER NOT NULL);
    CREATE TABLE master_data_guards (
      id INTEGER PRIMARY KEY CHECK(id=1),
      invalid_grid_location INTEGER NOT NULL DEFAULT 1 CONSTRAINT INVALID_GRID_LOCATION CHECK(invalid_grid_location=1),
      voltage_parent INTEGER NOT NULL DEFAULT 1 CONSTRAINT VOLTAGE_LEVEL_NOT_FOUND CHECK(voltage_parent=1),
      line_parent INTEGER NOT NULL DEFAULT 1 CONSTRAINT LINE_NOT_FOUND CHECK(line_parent=1),
      line_reference INTEGER NOT NULL DEFAULT 1 CONSTRAINT LINE_LOCATION_IN_USE CHECK(line_reference=1),
      tower_reference INTEGER NOT NULL DEFAULT 1 CONSTRAINT TOWER_LOCATION_IN_USE CHECK(tower_reference=1),
      voltage_reference INTEGER NOT NULL DEFAULT 1 CONSTRAINT VOLTAGE_LOCATION_IN_USE CHECK(voltage_reference=1)
    );
    CREATE TABLE demands (
      id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE,
      source_batch_id TEXT, source_file_sha256 TEXT, source_file_name TEXT, source_sheet TEXT, source_row_number INTEGER,
      sequence_no TEXT NOT NULL, business_year INTEGER, voltage_raw TEXT NOT NULL, voltage_verified TEXT,
      line_name TEXT NOT NULL, section_text TEXT NOT NULL, category_key TEXT, owner TEXT, business_signature TEXT NOT NULL,
      raw_json TEXT NOT NULL, extra_json TEXT NOT NULL, version INTEGER NOT NULL, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, voltage_level_id TEXT, line_id TEXT, location_type TEXT,
      start_tower_id TEXT, end_tower_id TEXT
    );
    CREATE TABLE demand_materials (
      id TEXT PRIMARY KEY, demand_id TEXT NOT NULL, raw_model TEXT NOT NULL, material_id TEXT,
      quantity_scaled INTEGER NOT NULL, unit TEXT, created_at TEXT NOT NULL, source_import_row_id TEXT,
      created_by TEXT, version INTEGER NOT NULL
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY, actor_member_id TEXT, action TEXT NOT NULL, object_type TEXT NOT NULL,
      object_id TEXT NOT NULL, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE idempotency_records (
      idempotency_key TEXT PRIMARY KEY, actor_member_id TEXT NOT NULL, operation TEXT NOT NULL,
      request_hash TEXT NOT NULL, response_json TEXT NOT NULL, status_code INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO voltage_levels VALUES ('vl-110','110kV',1),('vl-off','220kV',0);
    INSERT INTO transmission_lines VALUES ('line-1','vl-110','Line A',1),('line-off','vl-off','Line B',1);
    INSERT INTO transmission_towers VALUES ('t1','line-1','#001',1000,1),('t2','line-1','#002',2000,1),('t-off','line-1','#003',3000,0);
    INSERT INTO materials VALUES ('m1','M-1','Material 1','Model 1','piece',1,3),('m2',NULL,'Material 2','Model 2','piece',0,1);
  `);
  return { sqlite, repository: new SqlDemandRepository(new SqliteDatabaseAdapter(sqlite)) };
}

test('demand repository resolves line with parent voltage state in one portable query', async () => {
  const { sqlite, repository } = createRepository();
  try {
    assert.deepEqual(await repository.findLine('line-1'), {
      id: 'line-1', lineName: 'Line A', enabled: true, voltageLevelId: 'vl-110', voltageName: '110kV', voltageEnabled: true,
    });
    assert.equal((await repository.findLine('line-off'))?.voltageEnabled, false);
  } finally { sqlite.close(); }
});

test('demand repository resolves selected towers and only enabled materials in set queries', async () => {
  const { sqlite, repository } = createRepository();
  try {
    assert.deepEqual(await repository.findTowers(['t2', 't1']), [
      { id: 't1', towerNo: '#001', sortRank: 1000, lineId: 'line-1', enabled: true },
      { id: 't2', towerNo: '#002', sortRank: 2000, lineId: 'line-1', enabled: true },
    ]);
    assert.deepEqual(await repository.findEnabledMaterials(['m1', 'm2']), [
      { id: 'm1', code: 'M-1', name: 'Material 1', model: 'Model 1', unit: 'piece', enabled: true, version: 3 },
    ]);
    assert.deepEqual(await repository.findTowers([]), []);
    assert.deepEqual(await repository.findEnabledMaterials([]), []);
  } finally { sqlite.close(); }
});

test('structured demand creation rechecks grid and material versions and commits all facts atomically', async () => {
  const { sqlite, repository } = createRepository();
  const base = {
    id: 'd1', sourceKey: 'manual:d1', sequenceNo: '001', year: 2026,
    voltageLevelId: 'vl-110', lineId: 'line-1', locationType: 'tower_range', startTowerId: 't1', endTowerId: 't2',
    voltageName: '110kV', lineName: 'Line A', sectionText: '#001—#002', category: null, owner: null,
    businessSignature: 'sig-1', rawJson: '{"sequenceNo":"001"}', actorId: 'admin-1', now: '2026-09-14T01:00:00.000Z',
    materials: [{ id: 'dm1', rawModel: 'Model 1', materialId: 'm1', quantityScaled: 10000, unit: 'piece' }],
    materialVersions: { m1: 3 },
    responseJson: '{"ok":true}', idempotencyKey: 'idem-d1', operation: 'POST:/api/demands', requestHash: 'hash-d1', auditId: 'audit-d1',
    auditAfter: { id: 'd1' },
  };
  try {
    await repository.createStructured(base);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM demands WHERE id='d1'").get().count, 1);
    assert.equal(sqlite.prepare("SELECT material_id FROM demand_materials WHERE id='dm1'").get().material_id, 'm1');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE object_id='d1'").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='idem-d1'").get().count, 1);

    sqlite.prepare("UPDATE materials SET version=4 WHERE id='m1'").run();
    await assert.rejects(repository.createStructured({
      ...base, id: 'd2', sourceKey: 'manual:d2', responseJson: '{"ok":true,"id":"d2"}', idempotencyKey: 'idem-d2', requestHash: 'hash-d2', auditId: 'audit-d2',
    }), /INVALID_GRID_LOCATION/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM demands WHERE id='d2'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='idem-d2'").get().count, 0);
  } finally { sqlite.close(); }
});
