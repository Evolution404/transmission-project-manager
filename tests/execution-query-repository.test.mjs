import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlExecutionQueryRepository } from '../apps/api/src/repositories/sql-execution-query-repository.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY,framework_id TEXT,version INTEGER NOT NULL);
    CREATE TABLE project_releases (id TEXT PRIMARY KEY,project_id TEXT NOT NULL);
    CREATE TABLE demands (id TEXT PRIMARY KEY,sequence_no TEXT,line_name TEXT,section_text TEXT);
    CREATE TABLE project_demand_links (id TEXT PRIMARY KEY,project_id TEXT,demand_id TEXT);
    CREATE TABLE project_tasks (id TEXT PRIMARY KEY,project_id TEXT,project_release_id TEXT,name TEXT,description TEXT,scope_text TEXT,owner TEXT,planned_date TEXT,planned_quantity_scaled INTEGER,unit TEXT,version INTEGER,implementation_version INTEGER,settlement_version INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE task_demand_scopes (id TEXT PRIMARY KEY,task_id TEXT,demand_id TEXT,planned_quantity_scaled INTEGER);
    CREATE TABLE task_material_requirements (id TEXT PRIMARY KEY,task_id TEXT,project_material_requirement_id TEXT,material_id TEXT,model TEXT,unit TEXT,required_quantity_scaled INTEGER,supply_version INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE material_supply_events (id TEXT PRIMARY KEY,task_material_requirement_id TEXT,stage TEXT,quantity_scaled INTEGER,event_date TEXT,created_at TEXT);
    CREATE TABLE task_implementation_records (id TEXT PRIMARY KEY,task_id TEXT,completed_quantity_scaled INTEGER,record_date TEXT);
    CREATE TABLE task_implementation_scope_lines (id TEXT PRIMARY KEY,implementation_id TEXT,task_demand_scope_id TEXT,completed_quantity_scaled INTEGER);
    CREATE TABLE task_settlements (id TEXT PRIMARY KEY,task_id TEXT,settlement_date TEXT,coverage_quantity_scaled INTEGER,final INTEGER,voided_at TEXT,created_at TEXT);
    CREATE TABLE task_settlement_scope_lines (id TEXT PRIMARY KEY,settlement_id TEXT,task_demand_scope_id TEXT,quantity_scaled INTEGER);
    CREATE TABLE task_settlement_reminders (task_id TEXT PRIMARY KEY,first_implementation_date TEXT,due_date TEXT,status TEXT,final_settlement_id TEXT);
    INSERT INTO projects VALUES ('p1','fw1',5);
    INSERT INTO project_releases VALUES ('r1','p1');
    INSERT INTO demands VALUES ('d1','001','Line A','S1');
    INSERT INTO project_demand_links VALUES ('l1','p1','d1');
    INSERT INTO project_tasks VALUES ('t1','p1','r1','Task',NULL,NULL,NULL,NULL,100,'项',1,2,2,'c','u');
    INSERT INTO task_demand_scopes VALUES ('s1','t1','d1',100);
    INSERT INTO task_material_requirements VALUES ('m1','t1',NULL,NULL,'M','件',10,2,'c','u');
    INSERT INTO material_supply_events VALUES ('se1','m1','reported',10,'2026-01-01','c');
    INSERT INTO task_implementation_records VALUES ('i1','t1',100,'2026-01-02');
    INSERT INTO task_implementation_scope_lines VALUES ('il1','i1','s1',100);
    INSERT INTO task_settlements VALUES ('st1','t1','2026-01-03',100,1,NULL,'c');
    INSERT INTO task_settlement_scope_lines VALUES ('sl1','st1','s1',100);
    INSERT INTO task_settlement_reminders VALUES ('t1','2026-01-02','2026-02-01','closed','st1');
  `);
  return { sqlite, repository: new SqlExecutionQueryRepository(new SqliteDatabaseAdapter(sqlite)) };
}

test('execution query repository returns portable task and project execution projections', async () => {
  const { sqlite, repository } = fixture();
  try {
    assert.deepEqual(await repository.findProjectHeader('p1'), { id: 'p1', frameworkId: 'fw1', version: 5, released: true });
    const tasks = await repository.listProjectTasks('p1');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].state, 'implemented_settled');
    assert.equal(tasks[0].supplyTotals[0].totals.reportedQuantityScaled, 10);
    const demands = await repository.listProjectDemands('p1');
    assert.equal(demands[0].state, 'implemented_settled');
    const demand = await repository.findDemandExecution('d1');
    assert.equal(demand?.summary.settlementComplete, true);
    assert.deepEqual(demand?.projects, [{ id: 'p1', frameworkId: 'fw1' }]);
  } finally { sqlite.close(); }
});
