import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlReserveProjectWriteRepository } from '../apps/api/src/repositories/sql-reserve-project-write-repository.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT,business_year INTEGER,owner TEXT,status TEXT,reserve_version INTEGER,framework_id TEXT,version INTEGER,created_by TEXT,created_at TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE project_demand_links (id TEXT PRIMARY KEY,project_id TEXT,demand_id TEXT,created_by TEXT,created_at TEXT);
    CREATE TABLE project_material_requirements (id TEXT PRIMARY KEY,project_id TEXT,material_id TEXT,model TEXT,unit TEXT,required_quantity_scaled INTEGER,unit_price_scaled INTEGER,amount_fen INTEGER,reserve_category_id TEXT,active INTEGER,version INTEGER,created_by TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE project_material_revisions (id TEXT PRIMARY KEY,project_id TEXT,project_version INTEGER,reason TEXT,before_json TEXT,after_json TEXT,created_by TEXT,created_at TEXT);
    CREATE TABLE project_versions (id TEXT PRIMARY KEY,project_id TEXT,reserve_version INTEGER,snapshot_json TEXT,known_amount_fen INTEGER,missing_price_count INTEGER,completeness_basis_points INTEGER,reason TEXT,confirmed_by TEXT,confirmed_at TEXT);
    CREATE TABLE audit_events (id TEXT PRIMARY KEY,actor_member_id TEXT,action TEXT,object_type TEXT,object_id TEXT,before_json TEXT,after_json TEXT,created_at TEXT);
    CREATE TABLE idempotency_records (idempotency_key TEXT PRIMARY KEY,actor_member_id TEXT,operation TEXT,request_hash TEXT,response_json TEXT,status_code INTEGER,created_at TEXT);
    INSERT INTO projects VALUES ('p1','P1',2026,NULL,'draft',0,NULL,1,'admin','c','u');
    INSERT INTO project_demand_links VALUES ('l0','p1','d0','admin','c');
    INSERT INTO project_material_requirements VALUES ('pm0','p1',NULL,'M0','件',100,NULL,NULL,NULL,1,1,'admin','c','u');
  `);
  return { sqlite, repository: new SqlReserveProjectWriteRepository(new SqliteDatabaseAdapter(sqlite)) };
}

const meta = { actorId: 'admin', auditId: 'a1', idempotencyKey: 'i1', operation: 'op', requestHash: 'h', responseJson: '{}', now: '2026-01-01T00:00:00.000Z' };

test('reserve project create and aggregate mutations are atomic under project version guards', async () => {
  const { sqlite, repository } = fixture();
  try {
    await repository.create({
      ...meta,
      project: { id: 'p2', name: 'P2', year: 2026, owner: null },
      demandLinks: [{ id: 'l2', demandId: 'd2' }],
      materials: [{ id: 'pm2', item: { id: null, materialId: null, model: 'M2', unit: '件', requiredQuantityScaled: 10, unitPriceScaled: null, amountFen: null, reserveCategoryId: null } }],
      auditAfter: { name: 'P2' },
    });
    assert.equal(sqlite.prepare("SELECT version FROM projects WHERE id='p2'").get().version, 1);

    await assert.rejects(repository.replaceDemands({ ...meta, auditId: 'a2', idempotencyKey: 'i2', projectId: 'p1', expectedVersion: 2, beforeDemandIds: ['d0'], demandLinks: [{ id: 'l1', demandId: 'd1' }] }));
    assert.equal(sqlite.prepare("SELECT demand_id FROM project_demand_links WHERE project_id='p1'").get().demand_id, 'd0');

    await repository.replaceDemands({ ...meta, auditId: 'a3', idempotencyKey: 'i3', projectId: 'p1', expectedVersion: 1, beforeDemandIds: ['d0'], demandLinks: [{ id: 'l1', demandId: 'd1' }] });
    assert.equal(sqlite.prepare("SELECT version FROM projects WHERE id='p1'").get().version, 2);
    assert.equal(sqlite.prepare("SELECT demand_id FROM project_demand_links WHERE project_id='p1'").get().demand_id, 'd1');

    await repository.replaceMaterials({
      ...meta, auditId: 'a4', idempotencyKey: 'i4', projectId: 'p1', expectedVersion: 2, reason: '调整', revisionId: 'r1', before: [], after: [],
      materials: [{ id: 'pm0', existing: true, item: { id: 'pm0', materialId: null, model: 'M0', unit: '件', requiredQuantityScaled: 120, unitPriceScaled: null, amountFen: null, reserveCategoryId: null } }],
    });
    assert.equal(sqlite.prepare("SELECT required_quantity_scaled FROM project_material_requirements WHERE id='pm0'").get().required_quantity_scaled, 120);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM project_material_revisions WHERE id='r1'").get().count, 1);
  } finally { sqlite.close(); }
});

test('reserve project confirmation advances both project and immutable reserve version atomically', async () => {
  const { sqlite, repository } = fixture();
  const snapshot = {
    id: 'p1', name: 'P1', year: 2026, owner: null, status: 'draft', reserveVersion: 0, frameworkId: null, version: 1,
    demandLinks: [], materialRequirements: [], knownMaterialAmountFen: 0, missingPriceCount: 0, materialPriceCompletenessBasisPoints: 10000, createdAt: 'c', updatedAt: 'u',
  };
  try {
    await repository.confirm({ ...meta, projectId: 'p1', expectedVersion: 1, previousReserveVersion: 0, reserveVersion: 1, versionId: 'v1', snapshot, reason: null, auditAfter: { version: 2, reserveVersion: 1, status: 'confirmed' } });
    const project = sqlite.prepare("SELECT status,reserve_version,version FROM projects WHERE id='p1'").get();
    assert.equal(project.status, 'confirmed');
    assert.equal(project.reserve_version, 1);
    assert.equal(project.version, 2);
    assert.equal(sqlite.prepare("SELECT reserve_version FROM project_versions WHERE id='v1'").get().reserve_version, 1);
  } finally { sqlite.close(); }
});
