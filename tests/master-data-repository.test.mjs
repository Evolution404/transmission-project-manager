import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlMasterDataRepository } from '../apps/api/src/repositories/sql-master-data-repository.ts';

function createRepository() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE voltage_levels (
      id TEXT PRIMARY KEY, code TEXT NOT NULL, display_name TEXT NOT NULL, system_type TEXT NOT NULL,
      nominal_kv INTEGER NOT NULL, sort_order INTEGER NOT NULL, enabled INTEGER NOT NULL, version INTEGER NOT NULL
    );
    CREATE TABLE transmission_lines (
      id TEXT PRIMARY KEY, voltage_level_id TEXT NOT NULL, line_code TEXT, line_name TEXT NOT NULL,
      enabled INTEGER NOT NULL, version INTEGER NOT NULL, tower_order_version INTEGER NOT NULL
    );
    CREATE TABLE teams (id TEXT PRIMARY KEY, code TEXT, name TEXT NOT NULL, enabled INTEGER NOT NULL, version INTEGER NOT NULL);
    CREATE TABLE tower_types (id TEXT PRIMARY KEY, code TEXT, label TEXT NOT NULL, sort_order INTEGER NOT NULL, enabled INTEGER NOT NULL, version INTEGER NOT NULL);
    CREATE TABLE physical_towers (
      id TEXT PRIMARY KEY, asset_code TEXT, tower_type_id TEXT, maintenance_team_id TEXT,
      enabled INTEGER NOT NULL, version INTEGER NOT NULL
    );
    CREATE TABLE custom_field_definitions (
      id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, field_key TEXT NOT NULL, label TEXT NOT NULL,
      data_type TEXT NOT NULL, required INTEGER NOT NULL, filterable INTEGER NOT NULL,
      options_json TEXT, validation_json TEXT NOT NULL, sort_order INTEGER NOT NULL, enabled INTEGER NOT NULL, version INTEGER NOT NULL
    );
    CREATE TABLE custom_field_value_sets (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(entity_type,entity_id));
    CREATE TABLE custom_field_values (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, field_definition_id TEXT NOT NULL, value_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(entity_type,entity_id,field_definition_id));
    CREATE TABLE line_tower_positions (
      id TEXT PRIMARY KEY, line_id TEXT NOT NULL, physical_tower_id TEXT NOT NULL, tower_no TEXT NOT NULL,
      sort_rank INTEGER NOT NULL, position_label TEXT, enabled INTEGER NOT NULL, version INTEGER NOT NULL
    );
    INSERT INTO voltage_levels VALUES
      ('v110','110','110kV','AC',110,10,1,1),
      ('v220','220','220kV','AC',220,20,1,2);
    INSERT INTO transmission_lines VALUES
      ('l1','v110',NULL,'Alpha Line',1,1,1),
      ('l2','v110','L2','Beta Line',1,2,3),
      ('l3','v220',NULL,'Gamma Line',0,1,1),
      ('l4','v220',NULL,'Delta Line',1,1,1);
    INSERT INTO tower_types VALUES ('tt1','strain','耐张塔',10,1,1);
    INSERT INTO teams VALUES ('team1','north','城北班',1,1);
    INSERT INTO physical_towers VALUES
      ('p1','PT-001',NULL,'team1',1,1),
      ('p2','PT-002','tt1',NULL,1,1);
    INSERT INTO custom_field_definitions VALUES ('cf1','physical_tower','owner_unit','产权单位','text',0,1,NULL,'{}',10,1,1);
    INSERT INTO custom_field_value_sets VALUES ('physical_tower','p1',2,'t','t');
    INSERT INTO custom_field_values VALUES ('physical_tower','p1','cf1','"输电班"','t','t');
    INSERT INTO line_tower_positions VALUES
      ('t1','l1','p1','1',1,NULL,1,1),
      ('t2','l1','p2','2',2,'左侧',1,1),
      ('t3','l2','p1','1',1,'右侧',1,1);
  `);
  const database = new SqliteDatabaseAdapter(sqlite);
  return { sqlite, repository: new SqlMasterDataRepository(database) };
}

test('master data repository lists voltage levels in configured order', async () => {
  const { sqlite, repository } = createRepository();
  try {
    const items = await repository.listVoltageLevels();
    assert.deepEqual(items.map((item) => [item.id, item.displayName, item.version]), [
      ['v110', '110kV', 1],
      ['v220', '220kV', 2],
    ]);
  } finally { sqlite.close(); }
});

test('master data repository pages and filters lines with tower counts', async () => {
  const { sqlite, repository } = createRepository();
  try {
    const first = await repository.listLines({ voltageLevelId: 'v110', enabled: null, query: null, cursor: null, limit: 1 });
    assert.equal(first.length, 2);
    assert.equal(first[0].id, 'l1');
    assert.equal(first[0].towerCount, 2);

    const second = await repository.listLines({ voltageLevelId: 'v110', enabled: null, query: null, cursor: { lineName: first[0].lineName, id: first[0].id }, limit: 2 });
    assert.deepEqual(second.map((item) => item.id), ['l2']);

    const disabled = await repository.listLines({ voltageLevelId: 'v220', enabled: false, query: null, cursor: null, limit: 10 });
    assert.deepEqual(disabled.map((item) => item.id), ['l3']);
    const enabled = await repository.listLines({ voltageLevelId: 'v220', enabled: true, query: null, cursor: null, limit: 10 });
    assert.deepEqual(enabled.map((item) => item.id), ['l4']);
  } finally { sqlite.close(); }
});

test('master data repository pages line positions and exposes their shared physical tower', async () => {
  const { sqlite, repository } = createRepository();
  try {
    const first = await repository.listLineTowerPositions({ lineId: 'l1', query: null, cursor: null, limit: 1 });
    assert.equal(first.length, 2);
    assert.equal(first[0].towerNo, '1');
    assert.equal(first[0].physicalTowerId, 'p1');
    assert.equal(first[0].maintenanceTeamName, '城北班');
    const second = await repository.listLineTowerPositions({ lineId: 'l1', query: null, cursor: { sortRank: first[0].sortRank, id: first[0].id }, limit: 2 });
    assert.deepEqual(second.map((item) => item.id), ['t2']);
    const otherCircuit = await repository.listLineTowerPositions({ lineId: 'l2', query: null, cursor: null, limit: 10 });
    assert.equal(otherCircuit[0].physicalTowerId, 'p1');
    assert.equal(otherCircuit[0].positionLabel, '右侧');
  } finally { sqlite.close(); }
});

test('master data repository lists configurable teams, tower types and physical towers', async () => {
  const { sqlite, repository } = createRepository();
  try {
    assert.deepEqual((await repository.listTeams()).map((item) => item.name), ['城北班']);
    assert.deepEqual((await repository.listTowerTypes()).map((item) => item.label), ['耐张塔']);
    const physical = await repository.listPhysicalTowers({ query: 'PT-001', limit: 10 });
    assert.equal(physical.length, 1);
    assert.equal(physical[0].linePositionCount, 2);
    assert.equal(physical[0].customFieldsVersion, 2);
    assert.deepEqual(physical[0].customValues, { owner_unit: '输电班' });
  } finally { sqlite.close(); }
});
