import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlDemandMaterialWriteRepository } from '../apps/api/src/repositories/sql-demand-material-write-repository.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE demands (id TEXT PRIMARY KEY,version INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE demand_materials (id TEXT PRIMARY KEY,demand_id TEXT NOT NULL,raw_model TEXT NOT NULL,material_id TEXT,quantity_scaled INTEGER NOT NULL,unit TEXT,created_at TEXT NOT NULL,source_import_row_id TEXT,created_by TEXT NOT NULL,version INTEGER NOT NULL);
    CREATE TABLE audit_events (id TEXT PRIMARY KEY,actor_member_id TEXT,action TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL);
    CREATE TABLE idempotency_records (idempotency_key TEXT PRIMARY KEY,actor_member_id TEXT NOT NULL,operation TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,status_code INTEGER NOT NULL,created_at TEXT NOT NULL);
    INSERT INTO demands VALUES ('d1',2,'u');
  `);
  return { sqlite, repository: new SqlDemandMaterialWriteRepository(new SqliteDatabaseAdapter(sqlite)) };
}

test('demand material append is atomic under optimistic version guard', async () => {
  const { sqlite, repository } = fixture();
  const input = {
    demandId: 'd1', expectedVersion: 2, now: '2026-01-01T00:00:00.000Z', actorId: 'admin', auditId: 'a1',
    rows: [{ id: 'dm1', rawModel: 'M1', materialId: null, quantityScaled: 10000, unit: '件' }],
    idempotencyKey: 'i1', operation: 'demands.materials.add:d1', requestHash: 'h1', responseJson: '{}',
  };
  try {
    assert.deepEqual(await repository.findState('d1'), { id: 'd1', version: 2 });
    await assert.rejects(repository.append({ ...input, expectedVersion: 1 }));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM demand_materials").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 0);
    await repository.append(input);
    assert.equal(sqlite.prepare("SELECT version FROM demands WHERE id='d1'").get().version, 3);
    assert.equal(sqlite.prepare("SELECT raw_model FROM demand_materials WHERE id='dm1'").get().raw_model, 'M1');
    assert.equal(sqlite.prepare("SELECT status_code FROM idempotency_records WHERE idempotency_key='i1'").get().status_code, 200);
  } finally { sqlite.close(); }
});
