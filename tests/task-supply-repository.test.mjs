import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlTaskSupplyRepository } from '../apps/api/src/repositories/sql-task-supply-repository.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY,framework_id TEXT);
    CREATE TABLE project_tasks (id TEXT PRIMARY KEY,project_id TEXT NOT NULL);
    CREATE TABLE task_material_requirements (
      id TEXT PRIMARY KEY,task_id TEXT NOT NULL,project_material_requirement_id TEXT,material_id TEXT,model TEXT NOT NULL,unit TEXT NOT NULL,
      required_quantity_scaled INTEGER NOT NULL,supply_version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE material_supply_events (
      id TEXT PRIMARY KEY,task_material_requirement_id TEXT NOT NULL,stage TEXT NOT NULL,quantity_scaled INTEGER NOT NULL,event_date TEXT NOT NULL,note TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,actor_member_id TEXT,action TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL
    );
    CREATE TABLE idempotency_records (
      idempotency_key TEXT PRIMARY KEY,actor_member_id TEXT NOT NULL,operation TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,status_code INTEGER NOT NULL,created_at TEXT NOT NULL
    );
    INSERT INTO projects VALUES ('p1','fw1');
    INSERT INTO project_tasks VALUES ('t1','p1');
    INSERT INTO task_material_requirements VALUES ('tm1','t1','pm1','m1','Model A','件',100000,2,'c','u');
    INSERT INTO material_supply_events VALUES
      ('e1','tm1','reported',60000,'2026-01-01',NULL,'admin','c'),
      ('e2','tm1','shipped',40000,'2026-01-02',NULL,'admin','c'),
      ('e3','tm1','arrived',10000,'2026-01-03',NULL,'admin','c');
  `);
  return { sqlite, repository: new SqlTaskSupplyRepository(new SqliteDatabaseAdapter(sqlite)) };
}

test('task supply repository reads material ownership and all stage totals in one portable state', async () => {
  const { sqlite, repository } = fixture();
  try {
    assert.deepEqual(await repository.findSupplyState('tm1'), {
      id: 'tm1', taskId: 't1', projectId: 'p1', frameworkId: 'fw1', projectMaterialRequirementId: 'pm1', materialId: 'm1',
      model: 'Model A', unit: '件', requiredQuantityScaled: 100000, supplyVersion: 2,
      totals: { reportedQuantityScaled: 60000, shippedQuantityScaled: 40000, arrivedQuantityScaled: 10000 },
    });
    assert.equal(await repository.findSupplyState('missing'), null);
  } finally { sqlite.close(); }
});

test('task supply event write atomically guards supply version with audit and idempotency', async () => {
  const { sqlite, repository } = fixture();
  const input = {
    event: { id: 'e4', taskMaterialRequirementId: 'tm1', taskId: 't1', stage: 'arrived', quantityScaled: 20000, eventDate: '2026-01-04', note: null, supplyVersion: 3, totals: { reportedQuantityScaled: 60000, shippedQuantityScaled: 40000, arrivedQuantityScaled: 30000 }, createdAt: '2026-01-04T00:00:00.000Z' },
    beforeTotals: { reportedQuantityScaled: 60000, shippedQuantityScaled: 40000, arrivedQuantityScaled: 10000 },
    actorId: 'admin', auditId: 'audit1', idempotencyKey: 'idem1', operation: 'task-material-supply-events.create', requestHash: 'h1', responseJson: '{}',
  };
  try {
    await assert.rejects(repository.createSupplyEvent({ ...input, expectedSupplyVersion: 1 }));
    assert.equal(sqlite.prepare("SELECT supply_version FROM task_material_requirements WHERE id='tm1'").get().supply_version, 2);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM material_supply_events WHERE id='e4'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='audit1'").get().count, 0);

    await repository.createSupplyEvent({ ...input, expectedSupplyVersion: 2 });
    assert.equal(sqlite.prepare("SELECT supply_version FROM task_material_requirements WHERE id='tm1'").get().supply_version, 3);
    assert.equal(sqlite.prepare("SELECT quantity_scaled FROM material_supply_events WHERE id='e4'").get().quantity_scaled, 20000);
    assert.equal(sqlite.prepare("SELECT status_code FROM idempotency_records WHERE idempotency_key='idem1'").get().status_code, 201);
  } finally { sqlite.close(); }
});
