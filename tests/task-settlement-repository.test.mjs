import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlTaskSettlementRepository } from '../apps/api/src/repositories/sql-task-settlement-repository.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY,framework_id TEXT);
    CREATE TABLE project_tasks (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,planned_quantity_scaled INTEGER NOT NULL,settlement_version INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE task_demand_scopes (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,planned_quantity_scaled INTEGER NOT NULL);
    CREATE TABLE task_settlements (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,settlement_date TEXT NOT NULL,coverage_quantity_scaled INTEGER NOT NULL,amount_fen INTEGER NOT NULL,final INTEGER NOT NULL,note TEXT,version INTEGER NOT NULL,voided_at TEXT,voided_by TEXT,void_reason TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE task_settlement_scope_lines (id TEXT PRIMARY KEY,settlement_id TEXT NOT NULL,task_demand_scope_id TEXT NOT NULL,quantity_scaled INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE task_settlement_agreement_allocations (id TEXT PRIMARY KEY,settlement_id TEXT NOT NULL,agreement_id TEXT NOT NULL,amount_fen INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE task_implementation_records (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,record_date TEXT NOT NULL,completed_quantity_scaled INTEGER NOT NULL,note TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE task_settlement_reminders (task_id TEXT PRIMARY KEY,first_implementation_date TEXT NOT NULL,due_date TEXT NOT NULL,status TEXT NOT NULL,final_settlement_id TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE audit_events (id TEXT PRIMARY KEY,actor_member_id TEXT,action TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL);
    CREATE TABLE idempotency_records (idempotency_key TEXT PRIMARY KEY,actor_member_id TEXT NOT NULL,operation TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,status_code INTEGER NOT NULL,created_at TEXT NOT NULL);
    INSERT INTO projects VALUES ('p1','fw1');
    INSERT INTO project_tasks VALUES ('t1','p1',100000,2,'u');
    INSERT INTO task_demand_scopes VALUES ('s1','t1',60000),('s2','t1',40000);
    INSERT INTO task_settlements VALUES ('old','t1','2026-01-01',20000,1000,0,NULL,1,NULL,NULL,NULL,'admin','c','c');
    INSERT INTO task_settlement_scope_lines VALUES ('osl','old','s1',20000,'c');
    INSERT INTO task_implementation_records VALUES ('impl','t1','2026-01-02',10000,NULL,'admin','c');
    INSERT INTO task_settlement_reminders VALUES ('t1','2026-01-02','2026-02-01','open',NULL,'u');
  `);
  return { sqlite, repository: new SqlTaskSettlementRepository(new SqliteDatabaseAdapter(sqlite)) };
}

test('task settlement repository loads task and active cumulative coverage with fixed state queries', async () => {
  const { sqlite, repository } = fixture();
  try {
    assert.deepEqual(await repository.findTaskHeader('t1'), { id: 't1', projectId: 'p1', frameworkId: 'fw1', plannedQuantityScaled: 100000, settlementVersion: 2 });
    assert.deepEqual(await repository.loadValidationState('t1'), {
      previousCoverageQuantityScaled: 20000,
      scopes: [
        { id: 's1', plannedQuantityScaled: 60000, settledQuantityScaled: 20000 },
        { id: 's2', plannedQuantityScaled: 40000, settledQuantityScaled: 0 },
      ],
    });
  } finally { sqlite.close(); }
});

test('task settlement create and void keep version guards, reminder, audit, and idempotency atomic', async () => {
  const { sqlite, repository } = fixture();
  try {
    const event = {
      id: 'st1', taskId: 't1', settlementDate: '2026-01-10', coverageQuantityScaled: 80000, amountFen: 5000, final: true, note: null,
      coverage: [{ taskDemandScopeId: 's1', quantityScaled: 40000 }, { taskDemandScopeId: 's2', quantityScaled: 40000 }], agreementAllocations: [],
      version: 1, settlementVersion: 3, voidedAt: null, voidReason: null, createdAt: '2026-01-10T00:00:00.000Z', updatedAt: '2026-01-10T00:00:00.000Z',
    };
    const create = {
      event, expectedSettlementVersion: 2,
      coverageWrites: [{ id: 'c1', taskDemandScopeId: 's1', quantityScaled: 40000 }, { id: 'c2', taskDemandScopeId: 's2', quantityScaled: 40000 }], allocationWrites: [],
      actorId: 'admin', auditId: 'a1', idempotencyKey: 'i1', operation: 'task-settlements.create', requestHash: 'h1', responseJson: '{}',
    };
    await assert.rejects(repository.createSettlement({ ...create, expectedSettlementVersion: 1 }));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM task_settlements WHERE id='st1'").get().count, 0);
    await repository.createSettlement(create);
    assert.equal(sqlite.prepare("SELECT settlement_version FROM project_tasks WHERE id='t1'").get().settlement_version, 3);
    assert.equal(sqlite.prepare("SELECT final_settlement_id FROM task_settlement_reminders WHERE task_id='t1'").get().final_settlement_id, 'st1');

    const state = await repository.findVoidState('st1');
    assert.equal(state?.firstImplementationDate, '2026-01-02');
    assert.equal(state?.replacementFinalId, null);
    const responseData = { id: 'st1', taskId: 't1', version: 2, settlementVersion: 4, voidedAt: '2026-01-11T00:00:00.000Z', voidReason: '撤销' };
    await repository.voidSettlement({ settlementId: 'st1', taskId: 't1', expectedRecordVersion: 1, expectedSettlementVersion: 3, final: true, firstImplementationDate: state.firstImplementationDate, replacementFinalId: null, reason: '撤销', now: responseData.voidedAt, actorId: 'admin', auditId: 'a2', idempotencyKey: 'i2', operation: 'task-settlements.void:st1', requestHash: 'h2', responseJson: JSON.stringify({ ok: true, data: responseData }), responseData });
    assert.equal(sqlite.prepare("SELECT void_reason FROM task_settlements WHERE id='st1'").get().void_reason, '撤销');
    assert.equal(sqlite.prepare("SELECT status FROM task_settlement_reminders WHERE task_id='t1'").get().status, 'open');
    assert.equal(sqlite.prepare("SELECT settlement_version FROM project_tasks WHERE id='t1'").get().settlement_version, 4);
  } finally { sqlite.close(); }
});
