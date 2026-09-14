import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlLegacyExecutionRepository } from '../apps/api/src/repositories/sql-legacy-execution-repository.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT,framework_id TEXT,status TEXT,reserve_version INTEGER,version INTEGER,updated_at TEXT NOT NULL);
    CREATE TABLE demands (id TEXT PRIMARY KEY,line_name TEXT,section_text TEXT);
    CREATE TABLE demand_materials (id TEXT PRIMARY KEY,demand_id TEXT,raw_model TEXT,unit TEXT);
    CREATE TABLE demand_allocations (id TEXT PRIMARY KEY,project_id TEXT,demand_material_id TEXT,quantity_scaled INTEGER);
    CREATE TABLE release_batches (id TEXT PRIMARY KEY,project_id TEXT,release_date TEXT,note TEXT,project_version_snapshot INTEGER,reserve_version_snapshot INTEGER,created_by TEXT,created_at TEXT);
    CREATE TABLE release_lines (id TEXT PRIMARY KEY,release_batch_id TEXT,project_id TEXT,demand_material_id TEXT,quantity_scaled INTEGER,snapshot_json TEXT,created_at TEXT);
    CREATE TABLE implementation_records (id TEXT PRIMARY KEY,project_id TEXT,historical INTEGER,record_date TEXT,personnel TEXT,note TEXT,version INTEGER,created_by TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE implementation_lines (id TEXT PRIMARY KEY,implementation_id TEXT,project_id TEXT,release_line_id TEXT,demand_material_id TEXT,description TEXT,unit TEXT,completed_quantity_scaled INTEGER,actual_used_quantity_scaled INTEGER,created_at TEXT);
    CREATE TABLE settlements (id TEXT PRIMARY KEY,project_id TEXT,settlement_date TEXT,amount_fen INTEGER,final INTEGER,note TEXT,version INTEGER,voided_at TEXT,voided_by TEXT,void_reason TEXT,created_by TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE settlement_coverage (id TEXT PRIMARY KEY,settlement_id TEXT,project_id TEXT,demand_material_id TEXT,quantity_scaled INTEGER,created_at TEXT);
    CREATE TABLE settlement_agreement_allocations (id TEXT PRIMARY KEY,settlement_id TEXT,agreement_id TEXT,amount_fen INTEGER,created_at TEXT);
    CREATE TABLE audit_events (id TEXT PRIMARY KEY,actor_member_id TEXT,action TEXT,object_type TEXT,object_id TEXT,before_json TEXT,after_json TEXT,created_at TEXT);
    CREATE TABLE idempotency_records (idempotency_key TEXT PRIMARY KEY,actor_member_id TEXT,operation TEXT,request_hash TEXT,response_json TEXT,status_code INTEGER,created_at TEXT);

    INSERT INTO projects VALUES ('p1','项目1',NULL,'confirmed',1,1,'u');
    INSERT INTO demands VALUES ('d1','线路1','#1-#2');
    INSERT INTO demand_materials VALUES ('dm1','d1','A','套');
    INSERT INTO demand_allocations VALUES ('da1','p1','dm1',100000);
  `);
  return { sqlite, repository: new SqlLegacyExecutionRepository(new SqliteDatabaseAdapter(sqlite)) };
}

function meta(key, operation, now, statusCode = 201) {
  return { actorId: 'admin', auditId: `audit-${key}`, idempotencyKey: key, operation, requestHash: `hash-${key}`, responseJson: '{}', statusCode, now };
}

test('legacy execution repository runs release and lifecycle facts on SQLite', async () => {
  const { sqlite, repository } = fixture();
  try {
    assert.deepEqual(await repository.findProject('p1'), {
      id: 'p1', name: '项目1', frameworkId: null, status: 'confirmed', reserveVersion: 1, version: 1, updatedAt: 'u',
    });
    const now = '2026-09-14T00:00:00.000Z';
    const batch = {
      id: 'rb1', projectId: 'p1', releaseDate: '2026-09-14', note: null,
      projectVersionSnapshot: 1, reserveVersionSnapshot: 1, projectVersion: 2,
      lines: [{
        id: 'rl1', releaseBatchId: 'rb1', demandMaterialId: 'dm1', quantityScaled: 60000,
        snapshot: { demandId: 'd1', lineName: '线路1', section: '#1-#2', rawModel: 'A', unit: '套', projectVersion: 1, reserveVersion: 1 },
      }],
      createdAt: now,
    };
    await repository.createReleaseBatch({ projectId: 'p1', expectedProjectVersion: 1, batch, meta: meta('release', 'release-batches.create', now) });
    assert.equal((await repository.findProject('p1')).version, 2);
    assert.equal((await repository.listReleaseBatches('p1'))[0].lines[0].quantityScaled, 60000);
    const lifecycle = await repository.lifecycle('p1');
    assert.equal(lifecycle.lines[0].releasedQuantityScaled, 60000);
    assert.equal(lifecycle.projectState, 'unimplemented_unsettled');
  } finally { sqlite.close(); }
});

test('legacy execution writes roll back completely on stale project version', async () => {
  const { sqlite, repository } = fixture();
  try {
    const now = '2026-09-14T00:00:00.000Z';
    const batch = {
      id: 'rb2', projectId: 'p1', releaseDate: '2026-09-14', note: null,
      projectVersionSnapshot: 2, reserveVersionSnapshot: 1, projectVersion: 3,
      lines: [{ id: 'rl2', releaseBatchId: 'rb2', demandMaterialId: 'dm1', quantityScaled: 10000, snapshot: { demandId: 'd1', lineName: '线路1', section: '#1-#2', rawModel: 'A', unit: '套', projectVersion: 2, reserveVersion: 1 } }],
      createdAt: now,
    };
    await assert.rejects(repository.createReleaseBatch({ projectId: 'p1', expectedProjectVersion: 2, batch, meta: meta('stale', 'release-batches.create', now) }));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM release_batches WHERE id='rb2'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='audit-stale'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='stale'").get().count, 0);
  } finally { sqlite.close(); }
});
