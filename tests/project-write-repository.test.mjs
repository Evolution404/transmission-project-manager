import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlProjectWriteRepository } from '../apps/api/src/repositories/sql-project-write-repository.ts';

function createRepository() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE demand_materials (id TEXT PRIMARY KEY, quantity_scaled INTEGER NOT NULL);
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, business_year INTEGER, owner TEXT, status TEXT NOT NULL,
      reserve_version INTEGER NOT NULL, framework_id TEXT, version INTEGER NOT NULL, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE demand_allocations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      demand_material_id TEXT NOT NULL REFERENCES demand_materials(id), quantity_scaled INTEGER NOT NULL,
      created_at TEXT NOT NULL, UNIQUE(project_id,demand_material_id)
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY, actor_member_id TEXT, action TEXT NOT NULL, object_type TEXT NOT NULL,
      object_id TEXT NOT NULL, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE idempotency_records (
      idempotency_key TEXT PRIMARY KEY, actor_member_id TEXT NOT NULL, operation TEXT NOT NULL,
      request_hash TEXT NOT NULL, response_json TEXT NOT NULL, status_code INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO demand_materials VALUES ('dm-1',100),('dm-2',50);
  `);
  return { sqlite, repository: new SqlProjectWriteRepository(new SqliteDatabaseAdapter(sqlite)) };
}

function createInput(id = 'project-1') {
  const project = {
    id, name: 'Reserve A', year: 2026, owner: 'Alice', status: 'draft', reserveVersion: 0,
    version: 1, createdAt: '2026-09-14T02:00:00.000Z', updatedAt: '2026-09-14T02:00:00.000Z',
    knownAmountFen: 0, missingPriceCount: 2, completenessBasisPoints: 0,
  };
  return {
    project,
    allocations: [
      { id: `${id}-a1`, demandMaterialId: 'dm-1', quantityScaled: 60 },
      { id: `${id}-a2`, demandMaterialId: 'dm-2', quantityScaled: 50 },
    ],
    actorId: 'admin-1', auditId: `${id}-audit`, idempotencyKey: `${id}-idem`,
    operation: 'projects.create', requestHash: `${id}-hash`, responseJson: JSON.stringify({ ok: true, data: project }),
  };
}

test('project repository creates project, allocations, audit and idempotency atomically', async () => {
  const { sqlite, repository } = createRepository();
  try {
    await repository.create(createInput());
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM projects WHERE id='project-1'").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM demand_allocations WHERE project_id='project-1'").get().count, 2);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE object_id='project-1'").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='project-1-idem'").get().count, 1);
  } finally { sqlite.close(); }
});

test('project repository prevents over-allocation inside the write transaction and rolls back every side effect', async () => {
  const { sqlite, repository } = createRepository();
  try {
    sqlite.prepare("INSERT INTO projects VALUES ('existing','Existing',2026,NULL,'draft',0,NULL,1,'admin-1','t','t')").run();
    sqlite.prepare("INSERT INTO demand_allocations VALUES ('existing-a','existing','dm-1',70,'t')").run();
    const input = createInput('project-2');
    input.allocations = [{ id: 'project-2-a1', demandMaterialId: 'dm-1', quantityScaled: 40 }];
    input.project.missingPriceCount = 1;
    await assert.rejects(repository.create(input));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM projects WHERE id='project-2'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM demand_allocations WHERE project_id='project-2'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE object_id='project-2'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='project-2-idem'").get().count, 0);
    assert.deepEqual(await repository.findAllocationFailure([{ demandMaterialId: 'dm-1', quantityScaled: 40 }]), {
      status: 422, code: 'ALLOCATION_EXCEEDS_REMAINING', message: '分配数量超过需求物资剩余数量',
      details: { demandMaterialId: 'dm-1', remainingQuantityScaled: 30 },
    });
  } finally { sqlite.close(); }
});

test('project repository reports missing demand material distinctly', async () => {
  const { sqlite, repository } = createRepository();
  try {
    assert.deepEqual(await repository.findAllocationFailure([{ demandMaterialId: 'missing', quantityScaled: 1 }]), {
      status: 404, code: 'DEMAND_MATERIAL_NOT_FOUND', message: '需求物资不存在',
    });
  } finally { sqlite.close(); }
});

test('allocation replacement preserves old rows on stale version and replaces them atomically on success', async () => {
  const { sqlite, repository } = createRepository();
  try {
    sqlite.prepare("INSERT INTO projects VALUES ('p1','Reserve',2026,NULL,'draft',0,NULL,2,'admin-1','t','t')").run();
    sqlite.prepare("INSERT INTO demand_allocations VALUES ('old','p1','dm-1',40,'t')").run();
    const base = {
      projectId: 'p1', expectedVersion: 2, now: '2026-09-14T02:10:00.000Z',
      allocations: [{ id: 'new', demandMaterialId: 'dm-2', quantityScaled: 25 }],
      actorId: 'admin-1', auditId: 'replace-audit', idempotencyKey: 'replace-idem', operation: 'projects.allocations:p1',
      requestHash: 'replace-hash', responseJson: '{"ok":true}',
    };
    await assert.rejects(repository.replaceAllocations({ ...base, expectedVersion: 1 }));
    assert.deepEqual(sqlite.prepare("SELECT id,demand_material_id,quantity_scaled FROM demand_allocations WHERE project_id='p1'").all().map((row) => ({ ...row })), [
      { id: 'old', demand_material_id: 'dm-1', quantity_scaled: 40 },
    ]);
    assert.equal(sqlite.prepare("SELECT version FROM projects WHERE id='p1'").get().version, 2);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='replace-idem'").get().count, 0);

    await repository.replaceAllocations(base);
    assert.deepEqual(sqlite.prepare("SELECT id,demand_material_id,quantity_scaled FROM demand_allocations WHERE project_id='p1'").all().map((row) => ({ ...row })), [
      { id: 'new', demand_material_id: 'dm-2', quantity_scaled: 25 },
    ]);
    assert.equal(sqlite.prepare("SELECT version FROM projects WHERE id='p1'").get().version, 3);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='replace-audit'").get().count, 1);
  } finally { sqlite.close(); }
});
