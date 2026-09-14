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
      enabled INTEGER NOT NULL, version INTEGER NOT NULL
    );
    CREATE TABLE transmission_towers (
      id TEXT PRIMARY KEY, line_id TEXT NOT NULL, tower_no TEXT NOT NULL, sort_index INTEGER NOT NULL,
      tower_type TEXT, enabled INTEGER NOT NULL, version INTEGER NOT NULL
    );
    INSERT INTO voltage_levels VALUES
      ('v110','110','110kV','AC',110,10,1,1),
      ('v220','220','220kV','AC',220,20,1,2);
    INSERT INTO transmission_lines VALUES
      ('l1','v110',NULL,'Alpha Line',1,1),
      ('l2','v110','L2','Beta Line',1,2),
      ('l3','v220',NULL,'Gamma Line',0,1);
    INSERT INTO transmission_towers VALUES
      ('t1','l1','1',1,NULL,1,1),
      ('t2','l1','2',2,'耐张',1,1),
      ('t3','l2','1',1,NULL,1,1);
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
    const first = await repository.listLines({ voltageLevelId: 'v110', cursor: null, limit: 1 });
    assert.equal(first.length, 2);
    assert.equal(first[0].id, 'l1');
    assert.equal(first[0].towerCount, 2);

    const second = await repository.listLines({ voltageLevelId: 'v110', cursor: { lineName: first[0].lineName, id: first[0].id }, limit: 2 });
    assert.deepEqual(second.map((item) => item.id), ['l2']);
  } finally { sqlite.close(); }
});

test('master data repository pages and filters towers by line', async () => {
  const { sqlite, repository } = createRepository();
  try {
    const first = await repository.listTowers({ lineId: 'l1', cursor: null, limit: 1 });
    assert.equal(first.length, 2);
    assert.equal(first[0].towerNo, '1');
    const second = await repository.listTowers({ lineId: 'l1', cursor: { sortIndex: first[0].sortIndex, id: first[0].id }, limit: 2 });
    assert.deepEqual(second.map((item) => item.id), ['t2']);
  } finally { sqlite.close(); }
});
