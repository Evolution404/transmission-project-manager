import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlDemandQueryRepository } from '../apps/api/src/repositories/sql-demand-query-repository.ts';

function createRepository() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE demands (
      id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_key TEXT NOT NULL,
      source_batch_id TEXT, source_file_sha256 TEXT, source_file_name TEXT, source_sheet TEXT, source_row_number INTEGER,
      sequence_no TEXT NOT NULL, business_year INTEGER, voltage_raw TEXT NOT NULL, voltage_verified TEXT,
      line_name TEXT NOT NULL, section_text TEXT NOT NULL, category_key TEXT, owner TEXT, raw_json TEXT NOT NULL,
      version INTEGER NOT NULL, created_at TEXT NOT NULL,
      voltage_level_id TEXT, line_id TEXT, location_type TEXT, start_tower_id TEXT, end_tower_id TEXT
    );
    CREATE TABLE materials (
      id TEXT PRIMARY KEY, code TEXT, name TEXT NOT NULL, model TEXT NOT NULL, unit TEXT NOT NULL,
      enabled INTEGER NOT NULL, version INTEGER NOT NULL
    );
    CREATE TABLE demand_materials (
      id TEXT PRIMARY KEY, demand_id TEXT NOT NULL, raw_model TEXT NOT NULL, material_id TEXT,
      quantity_scaled INTEGER NOT NULL, unit TEXT
    );
    CREATE TABLE demand_source_rows (
      id TEXT PRIMARY KEY, demand_id TEXT NOT NULL, file_name TEXT NOT NULL, file_sha256 TEXT NOT NULL,
      sheet_name TEXT NOT NULL, source_row_number INTEGER NOT NULL, raw_json TEXT NOT NULL
    );
    INSERT INTO demands VALUES
      ('d2','manual','manual:d2',NULL,NULL,NULL,NULL,NULL,'002',2026,'110kV','110kV','Line B','#2',NULL,'Bob','{"note":"manual"}',1,'2026-09-14T02:00:00.000Z','vl-110','line-b','tower','tb2','tb2'),
      ('d1','import','src:d1','batch-1','sha-1','file.xlsx','Sheet1',3,'001',2026,'110kV','110kV','Line A','#1—#2','repair','Alice','{"note":"import"}',1,'2026-09-14T01:00:00.000Z','vl-110','line-a','tower_range','ta1','ta2');
    INSERT INTO materials VALUES ('m1','M-1','Material 1','Model 1','piece',1,2);
    INSERT INTO demand_materials VALUES ('dm1','d1','Model 1','m1',20000,'piece');
    INSERT INTO demand_source_rows VALUES
      ('sr1','d1','file.xlsx','sha-1','Sheet1',3,'{"row":3}'),
      ('sr2','d1','file.xlsx','sha-1','Sheet1',4,'{"row":4}');
  `);
  return { sqlite, repository: new SqlDemandQueryRepository(new SqliteDatabaseAdapter(sqlite)) };
}

test('demand query repository provides bounded cursor pages without duplicate rows', async () => {
  const { sqlite, repository } = createRepository();
  try {
    const first = await repository.list({ query: '', cursor: null, limit: 1 });
    assert.deepEqual(first.items.map((item) => item.id), ['d2']);
    assert.deepEqual(first.nextCursor, { createdAt: '2026-09-14T02:00:00.000Z', id: 'd2' });
    const second = await repository.list({ query: '', cursor: first.nextCursor, limit: 1 });
    assert.deepEqual(second.items.map((item) => item.id), ['d1']);
    assert.equal(second.nextCursor, null);
    const searched = await repository.list({ query: 'Line A', cursor: null, limit: 50 });
    assert.deepEqual(searched.items.map((item) => item.id), ['d1']);
  } finally { sqlite.close(); }
});

test('demand query repository returns material and full import source trace in fixed set queries', async () => {
  const { sqlite, repository } = createRepository();
  try {
    const detail = await repository.getById('d1');
    assert.equal(detail?.source.type, 'import');
    assert.equal(detail?.materials.length, 1);
    assert.equal(detail?.materials[0].material?.id, 'm1');
    assert.deepEqual(detail?.source.type === 'import' ? detail.source.rows?.map((row) => row.rowNumber) : [], [3, 4]);
    const manual = await repository.getById('d2');
    assert.deepEqual(manual?.source, { type: 'manual', raw: { note: 'manual' } });
    assert.equal(await repository.getById('missing'), null);
  } finally { sqlite.close(); }
});
