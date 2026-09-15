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
      line_code TEXT, line_name TEXT NOT NULL, name_valid_from TEXT NOT NULL,
      enabled INTEGER NOT NULL, version INTEGER NOT NULL, tower_order_version INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE physical_towers (
      id TEXT PRIMARY KEY, asset_code TEXT, tower_type_id TEXT, maintenance_team_id TEXT,
      enabled INTEGER NOT NULL, version INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE teams (id TEXT PRIMARY KEY, code TEXT, name TEXT NOT NULL, enabled INTEGER NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tower_types (id TEXT PRIMARY KEY, code TEXT, label TEXT NOT NULL, enabled INTEGER NOT NULL, sort_order INTEGER NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE custom_field_definitions (
      id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, field_key TEXT NOT NULL, label TEXT NOT NULL, data_type TEXT NOT NULL,
      required INTEGER NOT NULL, filterable INTEGER NOT NULL, options_json TEXT, validation_json TEXT NOT NULL,
      sort_order INTEGER NOT NULL, enabled INTEGER NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE custom_field_value_sets (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(entity_type,entity_id));
    CREATE TABLE custom_field_values (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, field_definition_id TEXT NOT NULL REFERENCES custom_field_definitions(id), value_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(entity_type,entity_id,field_definition_id));
    CREATE TABLE custom_field_index (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, field_definition_id TEXT NOT NULL REFERENCES custom_field_definitions(id), text_value TEXT, integer_value INTEGER, date_value TEXT, boolean_value INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(entity_type,entity_id,field_definition_id));
    CREATE TABLE custom_field_multi_select_index (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, field_definition_id TEXT NOT NULL REFERENCES custom_field_definitions(id), option_value TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(entity_type,entity_id,field_definition_id,option_value));
    CREATE TABLE line_tower_positions (
      id TEXT PRIMARY KEY, line_id TEXT NOT NULL REFERENCES transmission_lines(id), physical_tower_id TEXT NOT NULL REFERENCES physical_towers(id),
      tower_no TEXT NOT NULL, number_valid_from TEXT NOT NULL, sort_rank INTEGER NOT NULL, position_label TEXT,
      enabled INTEGER NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(line_id,sort_rank)
    );
    CREATE TABLE demands (
      id TEXT PRIMARY KEY, voltage_level_id TEXT, line_id TEXT, start_tower_position_id TEXT, end_tower_position_id TEXT
    );
    CREATE TABLE master_data_guards (
      id INTEGER PRIMARY KEY CHECK(id=1),
      invalid_grid_location INTEGER NOT NULL DEFAULT 1 CONSTRAINT INVALID_GRID_LOCATION CHECK(invalid_grid_location=1),
      voltage_parent INTEGER NOT NULL DEFAULT 1 CONSTRAINT VOLTAGE_LEVEL_NOT_FOUND CHECK(voltage_parent=1),
      line_parent INTEGER NOT NULL DEFAULT 1 CONSTRAINT LINE_NOT_FOUND CHECK(line_parent=1),
      line_reference INTEGER NOT NULL DEFAULT 1 CONSTRAINT LINE_LOCATION_IN_USE CHECK(line_reference=1),
      tower_reference INTEGER NOT NULL DEFAULT 1 CONSTRAINT TOWER_LOCATION_IN_USE CHECK(tower_reference=1),
      voltage_reference INTEGER NOT NULL DEFAULT 1 CONSTRAINT VOLTAGE_LOCATION_IN_USE CHECK(voltage_reference=1)
    );
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
    }), /VOLTAGE_LEVEL_NOT_FOUND/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM transmission_lines").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get().count, 0);
  } finally { sqlite.close(); }
});

test('referenced line cannot change its voltage parent inside the atomic write batch', async () => {
  const { sqlite, repository } = createRepository();
  try {
    sqlite.prepare(`INSERT INTO voltage_levels VALUES (?,?,?,?,?,?,?,?,?,?)`).run('vl-220','AC220','220kV','AC',220,20,1,1,'t','t');
    sqlite.prepare(`INSERT INTO voltage_levels VALUES (?,?,?,?,?,?,?,?,?,?)`).run('vl-110','AC110','110kV','AC',110,10,1,1,'t','t');
    sqlite.prepare(`INSERT INTO transmission_lines VALUES (?,?,?,?,?,?,?,?,?,?)`).run('line-a','vl-220',null,'A线','t',1,1,1,'t','t');
    sqlite.prepare(`INSERT INTO demands (id,voltage_level_id,line_id) VALUES (?,?,?)`).run('d1','vl-220','line-a');
    await assert.rejects(repository.commitSingle({
      kind: 'line', action: 'update', id: 'line-a',
      values: { voltageLevelId: 'vl-110', lineName: 'A线', lineCode: null, enabled: true },
      expectedVersion: 1,
      requireEnabledParent: true,
      mutation: mutation('line-parent-change'),
      audit: { action: 'master.lines.update', objectType: 'transmission_lines', before: { voltage_level_id: 'vl-220' }, after: { voltageLevelId: 'vl-110' } },
    }), /LINE_LOCATION_IN_USE/);
    assert.equal(sqlite.prepare("SELECT voltage_level_id FROM transmission_lines WHERE id='line-a'").get().voltage_level_id, 'vl-220');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='key-line-parent-change'").get().count, 0);
  } finally { sqlite.close(); }
});

test('line tower position creation atomically creates a physical tower and another line may reuse it', async () => {
  const { sqlite, repository } = createRepository();
  try {
    sqlite.prepare(`INSERT INTO voltage_levels VALUES (?,?,?,?,?,?,?,?,?,?)`).run('vl-110','AC110','110kV','AC',110,10,1,1,'t','t');
    sqlite.prepare(`INSERT INTO transmission_lines VALUES (?,?,?,?,?,?,?,?,?,?)`).run('line-a','vl-110',null,'A线','t',1,1,1,'t','t');
    sqlite.prepare(`INSERT INTO transmission_lines VALUES (?,?,?,?,?,?,?,?,?,?)`).run('line-b','vl-110',null,'B线','t',1,1,1,'t','t');

    await repository.commitSingle({
      kind: 'tower-position', action: 'create', id: 'pos-a',
      values: { lineId: 'line-a', physicalTowerId: 'physical-1', towerNo: '#001', sortRank: 1000, positionLabel: '左回', enabled: true },
      createPhysicalTower: { id: 'physical-1', assetCode: 'PT-001', towerTypeId: null, maintenanceTeamId: null, enabled: true },
      expectedVersion: null,
      changesTowerOrder: true, parentLineId: 'line-a', expectedTowerOrderVersion: 1,
      requireEnabledParent: true,
      mutation: mutation('pos-a'),
      audit: { action: 'master.towers.create', objectType: 'line_tower_positions', before: null, after: { id: 'pos-a' } },
    });
    assert.equal(sqlite.prepare("SELECT asset_code FROM physical_towers WHERE id='physical-1'").get().asset_code, 'PT-001');
    assert.equal(sqlite.prepare("SELECT physical_tower_id FROM line_tower_positions WHERE id='pos-a'").get().physical_tower_id, 'physical-1');

    await repository.commitSingle({
      kind: 'tower-position', action: 'create', id: 'pos-b',
      values: { lineId: 'line-b', physicalTowerId: 'physical-1', towerNo: '#003', sortRank: 1000, positionLabel: '右回', enabled: true },
      expectedVersion: null,
      changesTowerOrder: true, parentLineId: 'line-b', expectedTowerOrderVersion: 1,
      requireEnabledParent: true,
      mutation: mutation('pos-b'),
      audit: { action: 'master.towers.create', objectType: 'line_tower_positions', before: null, after: { id: 'pos-b' } },
    });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM physical_towers WHERE id='physical-1'").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM line_tower_positions WHERE physical_tower_id='physical-1'").get().count, 2);

    await repository.commitSingle({
      kind: 'tower-position', action: 'delete', id: 'pos-a', expectedVersion: 1,
      changesTowerOrder: true, parentLineId: 'line-a', expectedTowerOrderVersion: 2,
      mutation: mutation('delete-pos-a'),
      audit: { action: 'master.towers.delete', objectType: 'line_tower_positions', before: { id: 'pos-a' }, after: null },
    });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM line_tower_positions WHERE id='pos-a'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM physical_towers WHERE id='physical-1'").get().count, 1);
    assert.equal(sqlite.prepare("SELECT physical_tower_id FROM line_tower_positions WHERE id='pos-b'").get().physical_tower_id, 'physical-1');
  } finally { sqlite.close(); }
});

test('custom field values replace atomically with an independent value-set version and typed indexes', async () => {
  const { sqlite, repository } = createRepository();
  try {
    sqlite.prepare(`INSERT INTO physical_towers VALUES (?,?,?,?,?,?,?,?)`).run('physical-1','PT-001',null,null,1,1,'t','t');
    sqlite.prepare(`INSERT INTO custom_field_definitions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('cf-owner','physical_tower','owner_unit','产权单位','text',0,1,null,'{}',10,1,1,'t','t');
    sqlite.prepare(`INSERT INTO custom_field_definitions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('cf-tags','physical_tower','tags','标签','multi_select',0,1,'["重要","跨江"]','{}',20,1,1,'t','t');
    await repository.commitCustomFieldValues({
      entityType: 'physical_tower', entityId: 'physical-1', expectedVersion: null,
      values: [
        { fieldDefinitionId: 'cf-owner', valueJson: '"输电班"', textValue: '输电班', integerValue: null, dateValue: null, booleanValue: null, multiSelectValues: [], filterable: true },
        { fieldDefinitionId: 'cf-tags', valueJson: '["重要","跨江"]', textValue: null, integerValue: null, dateValue: null, booleanValue: null, multiSelectValues: ['重要','跨江'], filterable: true },
      ],
      mutation: mutation('custom-values'),
      audit: { action: 'master.custom-values.replace', objectType: 'physical_tower', before: null, after: { owner_unit: '输电班' } },
    });
    assert.equal(sqlite.prepare("SELECT version FROM custom_field_value_sets WHERE entity_type='physical_tower' AND entity_id='physical-1'").get().version, 1);
    assert.equal(sqlite.prepare("SELECT text_value FROM custom_field_index WHERE field_definition_id='cf-owner'").get().text_value, '输电班');
    assert.deepEqual(sqlite.prepare("SELECT option_value FROM custom_field_multi_select_index WHERE field_definition_id='cf-tags' ORDER BY option_value").all().map((row) => row.option_value), ['跨江','重要']);
    await assert.rejects(repository.commitCustomFieldValues({
      entityType: 'physical_tower', entityId: 'physical-1', expectedVersion: null, values: [],
      mutation: mutation('custom-values-stale'),
      audit: { action: 'master.custom-values.replace', objectType: 'physical_tower', before: null, after: {} },
    }));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM custom_field_values WHERE entity_id='physical-1'").get().count, 2);
  } finally { sqlite.close(); }
});
