import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlTaskImplementationRepository } from '../apps/api/src/repositories/sql-task-implementation-repository.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY,framework_id TEXT);
    CREATE TABLE project_tasks (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,planned_quantity_scaled INTEGER NOT NULL,implementation_version INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE task_demand_scopes (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,planned_quantity_scaled INTEGER NOT NULL);
    CREATE TABLE task_material_requirements (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,required_quantity_scaled INTEGER NOT NULL);
    CREATE TABLE task_implementation_records (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,record_date TEXT NOT NULL,completed_quantity_scaled INTEGER NOT NULL,note TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE task_implementation_scope_lines (id TEXT PRIMARY KEY,implementation_id TEXT NOT NULL,task_demand_scope_id TEXT NOT NULL,completed_quantity_scaled INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE task_material_usage_lines (id TEXT PRIMARY KEY,implementation_id TEXT NOT NULL,task_material_requirement_id TEXT NOT NULL,quantity_scaled INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE task_settlements (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,final INTEGER NOT NULL,voided_at TEXT);
    CREATE TABLE task_settlement_reminders (task_id TEXT PRIMARY KEY,first_implementation_date TEXT NOT NULL,due_date TEXT NOT NULL,status TEXT NOT NULL,final_settlement_id TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE audit_events (id TEXT PRIMARY KEY,actor_member_id TEXT,action TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL);
    CREATE TABLE idempotency_records (idempotency_key TEXT PRIMARY KEY,actor_member_id TEXT NOT NULL,operation TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,status_code INTEGER NOT NULL,created_at TEXT NOT NULL);
    INSERT INTO projects VALUES ('p1','fw1');
    INSERT INTO project_tasks VALUES ('t1','p1',100000,2,'u');
    INSERT INTO task_demand_scopes VALUES ('s1','t1',60000),('s2','t1',40000);
    INSERT INTO task_material_requirements VALUES ('tm1','t1',100000);
    INSERT INTO task_implementation_records VALUES ('old','t1','2026-01-01',20000,NULL,'admin','c');
    INSERT INTO task_implementation_scope_lines VALUES ('osl','old','s1',20000,'c');
    INSERT INTO task_material_usage_lines VALUES ('oul','old','tm1',10000,'c');
    INSERT INTO task_settlement_reminders VALUES ('t1','2026-01-01','2026-01-31','open',NULL,'u');
  `);
  return { sqlite, repository: new SqlTaskImplementationRepository(new SqliteDatabaseAdapter(sqlite)) };
}

test('task implementation repository loads task header and bounded cumulative validation state', async () => {
  const { sqlite, repository } = fixture();
  try {
    assert.deepEqual(await repository.findTaskHeader('t1'), {
      id: 't1', projectId: 'p1', frameworkId: 'fw1', plannedQuantityScaled: 100000, implementationVersion: 2,
    });
    const state = await repository.loadValidationState('t1');
    assert.equal(state.previousCompletedQuantityScaled, 20000);
    assert.equal(state.finalSettlementId, null);
    assert.equal(state.firstImplementationDate, '2026-01-01');
    assert.deepEqual(state.scopes, [
      { id: 's1', plannedQuantityScaled: 60000, usedQuantityScaled: 20000 },
      { id: 's2', plannedQuantityScaled: 40000, usedQuantityScaled: 0 },
    ]);
    assert.deepEqual(state.materials, [{ id: 'tm1', requiredQuantityScaled: 100000, usedQuantityScaled: 10000 }]);
  } finally { sqlite.close(); }
});

test('task implementation write atomically guards version and updates settlement reminder', async () => {
  const { sqlite, repository } = fixture();
  const event = {
    id: 'impl1', taskId: 't1', recordDate: '2026-01-10', completedQuantityScaled: 30000,
    scopeLines: [{ taskDemandScopeId: 's1', completedQuantityScaled: 30000 }],
    materialUsages: [{ taskMaterialRequirementId: 'tm1', quantityScaled: 20000 }], note: null,
    implementationVersion: 3, createdAt: '2026-01-10T00:00:00.000Z',
  };
  const input = {
    event,
    scopeWrites: [{ id: 'sl1', taskDemandScopeId: 's1', completedQuantityScaled: 30000 }],
    usageWrites: [{ id: 'ul1', taskMaterialRequirementId: 'tm1', quantityScaled: 20000 }],
    reminder: { firstImplementationDate: '2026-01-01', dueDate: '2026-01-31', status: 'open', finalSettlementId: null },
    actorId: 'admin', auditId: 'audit1', idempotencyKey: 'idem1', operation: 'task-implementations.create', requestHash: 'h1', responseJson: '{}',
  };
  try {
    await assert.rejects(repository.createImplementation({ ...input, expectedImplementationVersion: 1 }));
    assert.equal(sqlite.prepare("SELECT implementation_version FROM project_tasks WHERE id='t1'").get().implementation_version, 2);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM task_implementation_records WHERE id='impl1'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='audit1'").get().count, 0);

    await repository.createImplementation({ ...input, expectedImplementationVersion: 2 });
    assert.equal(sqlite.prepare("SELECT implementation_version FROM project_tasks WHERE id='t1'").get().implementation_version, 3);
    assert.equal(sqlite.prepare("SELECT completed_quantity_scaled FROM task_implementation_records WHERE id='impl1'").get().completed_quantity_scaled, 30000);
    assert.equal(sqlite.prepare("SELECT due_date FROM task_settlement_reminders WHERE task_id='t1'").get().due_date, '2026-01-31');
    assert.equal(sqlite.prepare("SELECT status_code FROM idempotency_records WHERE idempotency_key='idem1'").get().status_code, 201);
  } finally { sqlite.close(); }
});
