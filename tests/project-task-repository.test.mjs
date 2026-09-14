import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlProjectTaskRepository } from '../apps/api/src/repositories/sql-project-task-repository.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE projects (id TEXT PRIMARY KEY,version INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE project_demand_links (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,demand_id TEXT NOT NULL,UNIQUE(project_id,demand_id));
    CREATE TABLE project_material_requirements (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,material_id TEXT,model TEXT NOT NULL,unit TEXT NOT NULL,required_quantity_scaled INTEGER NOT NULL,
      active INTEGER NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE project_tasks (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,project_release_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT,scope_text TEXT,owner TEXT,
      planned_date TEXT,planned_quantity_scaled INTEGER NOT NULL,unit TEXT NOT NULL,version INTEGER NOT NULL,implementation_version INTEGER NOT NULL,
      settlement_version INTEGER NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE task_demand_scopes (
      id TEXT PRIMARY KEY,task_id TEXT NOT NULL,demand_id TEXT NOT NULL,planned_quantity_scaled INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,demand_id)
    );
    CREATE TABLE task_material_requirements (
      id TEXT PRIMARY KEY,task_id TEXT NOT NULL,project_material_requirement_id TEXT,material_id TEXT,model TEXT NOT NULL,unit TEXT NOT NULL,
      required_quantity_scaled INTEGER NOT NULL,supply_version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,actor_member_id TEXT,action TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL
    );
    CREATE TABLE idempotency_records (
      idempotency_key TEXT PRIMARY KEY,actor_member_id TEXT NOT NULL,operation TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,status_code INTEGER NOT NULL,created_at TEXT NOT NULL
    );
    INSERT INTO projects VALUES ('p1',8,'2026-03-01');
    INSERT INTO project_demand_links VALUES ('l1','p1','d1'),('l2','p1','d2');
    INSERT INTO project_material_requirements VALUES
      ('pm1','p1','m1','Model A','件',100000,1,'2026-01-01'),
      ('pm2','p1','m2','Model B','套',50000,1,'2026-01-02');
    INSERT INTO project_tasks VALUES ('old','p1','rel1','Old',NULL,NULL,NULL,NULL,10000,'项',1,1,1,'admin','2026-02-01','2026-02-01');
    INSERT INTO task_material_requirements VALUES ('oldm','old','pm1','m1','Model A','件',30000,1,'2026-02-01','2026-02-01');
  `);
  return { sqlite, repository: new SqlProjectTaskRepository(new SqliteDatabaseAdapter(sqlite)) };
}

test('project task repository validates demand links and material availability with set queries', async () => {
  const { sqlite, repository } = fixture();
  try {
    assert.deepEqual(await repository.listLinkedDemandIds('p1'), ['d1','d2']);
    const materials = await repository.listProjectMaterialAvailability('p1');
    assert.deepEqual(materials.map((item) => ({ id: item.id, required: item.requiredQuantityScaled, assigned: item.assignedQuantityScaled })), [
      { id: 'pm1', required: 100000, assigned: 30000 },
      { id: 'pm2', required: 50000, assigned: 0 },
    ]);
  } finally { sqlite.close(); }
});

test('project task creation atomically guards project version with scopes, materials, audit, and idempotency', async () => {
  const { sqlite, repository } = fixture();
  const base = {
    task: {
      id: 't1', projectId: 'p1', projectReleaseId: 'rel1', name: 'Task 1', description: null, scopeText: '#1-#2', owner: 'owner',
      plannedDate: '2026-03-10', plannedQuantityScaled: 60000, unit: '项', version: 1, implementationVersion: 1, settlementVersion: 1,
      projectVersion: 9, createdAt: '2026-03-02T00:00:00.000Z', updatedAt: '2026-03-02T00:00:00.000Z',
      demandScopes: [{ id: 's1', taskId: 't1', demandId: 'd1', plannedQuantityScaled: 60000 }],
      materials: [{ id: 'tm1', taskId: 't1', projectMaterialRequirementId: 'pm1', materialId: 'm1', model: 'Model A', unit: '件', requiredQuantityScaled: 60000, supplyVersion: 1, createdAt: '2026-03-02T00:00:00.000Z', updatedAt: '2026-03-02T00:00:00.000Z' }],
    },
    actorId: 'admin', auditId: 'audit1', idempotencyKey: 'idem1', operation: 'project-tasks.create', requestHash: 'h1', responseJson: '{}',
  };
  try {
    await assert.rejects(repository.createTask({ ...base, expectedProjectVersion: 7 }));
    assert.equal(sqlite.prepare("SELECT version FROM projects WHERE id='p1'").get().version, 8);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM project_tasks WHERE id='t1'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='audit1'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='idem1'").get().count, 0);

    await repository.createTask({ ...base, expectedProjectVersion: 8 });
    assert.equal(sqlite.prepare("SELECT version FROM projects WHERE id='p1'").get().version, 9);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM task_demand_scopes WHERE task_id='t1'").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM task_material_requirements WHERE task_id='t1'").get().count, 1);
  } finally { sqlite.close(); }
});
