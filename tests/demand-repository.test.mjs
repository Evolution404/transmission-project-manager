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
    CREATE TABLE transmission_towers (id TEXT PRIMARY KEY, line_id TEXT NOT NULL, tower_no TEXT NOT NULL, sort_index INTEGER NOT NULL, enabled INTEGER NOT NULL);
    CREATE TABLE materials (id TEXT PRIMARY KEY, code TEXT, name TEXT NOT NULL, model TEXT NOT NULL, unit TEXT NOT NULL, enabled INTEGER NOT NULL, version INTEGER NOT NULL);
    INSERT INTO voltage_levels VALUES ('vl-110','110kV',1),('vl-off','220kV',0);
    INSERT INTO transmission_lines VALUES ('line-1','vl-110','Line A',1),('line-off','vl-off','Line B',1);
    INSERT INTO transmission_towers VALUES ('t1','line-1','#1',1,1),('t2','line-1','#2',2,1),('t-off','line-1','#3',3,0);
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
      { id: 't1', towerNo: '#1', sortIndex: 1, lineId: 'line-1', enabled: true },
      { id: 't2', towerNo: '#2', sortIndex: 2, lineId: 'line-1', enabled: true },
    ]);
    assert.deepEqual(await repository.findEnabledMaterials(['m1', 'm2']), [
      { id: 'm1', code: 'M-1', name: 'Material 1', model: 'Model 1', unit: 'piece', enabled: true, version: 3 },
    ]);
    assert.deepEqual(await repository.findTowers([]), []);
    assert.deepEqual(await repository.findEnabledMaterials([]), []);
  } finally { sqlite.close(); }
});
