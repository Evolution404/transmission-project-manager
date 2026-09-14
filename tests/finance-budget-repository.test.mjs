import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlFinanceBudgetRepository } from '../apps/api/src/repositories/sql-finance-budget-repository.ts';

function createRepository() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,framework_id TEXT,version INTEGER NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE agreements (
      id TEXT PRIMARY KEY,framework_id TEXT NOT NULL,code TEXT NOT NULL,name TEXT NOT NULL,amount_fen INTEGER NOT NULL,
      valid_from TEXT NOT NULL,valid_to TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE project_budgets (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL UNIQUE,total_amount_fen INTEGER NOT NULL,note TEXT,status TEXT NOT NULL,
      budget_version INTEGER NOT NULL,version INTEGER NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE budget_allocations (
      id TEXT PRIMARY KEY,budget_id TEXT NOT NULL,agreement_id TEXT NOT NULL,amount_fen INTEGER NOT NULL,created_at TEXT NOT NULL,
      UNIQUE(budget_id,agreement_id)
    );
    CREATE TABLE budget_versions (
      id TEXT PRIMARY KEY,budget_id TEXT NOT NULL,project_id TEXT NOT NULL,framework_id TEXT NOT NULL,budget_version INTEGER NOT NULL,
      total_amount_fen INTEGER NOT NULL,note TEXT,confirmed_by TEXT NOT NULL,confirmed_at TEXT NOT NULL,UNIQUE(budget_id,budget_version)
    );
    CREATE TABLE budget_version_allocations (
      id TEXT PRIMARY KEY,budget_version_id TEXT NOT NULL,agreement_id TEXT NOT NULL,amount_fen INTEGER NOT NULL,created_at TEXT NOT NULL,
      UNIQUE(budget_version_id,agreement_id)
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,actor_member_id TEXT,action TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL
    );
    CREATE TABLE idempotency_records (
      idempotency_key TEXT PRIMARY KEY,actor_member_id TEXT NOT NULL,operation TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,status_code INTEGER NOT NULL,created_at TEXT NOT NULL
    );
    INSERT INTO projects VALUES ('p1','Project 1','fw-1',1,'2026-01-01T00:00:00.000Z');
    INSERT INTO agreements VALUES
      ('ag-1','fw-1','AG-1','Agreement 1',600,'2026-01-01','2026-12-31','active',1,'c','u'),
      ('ag-2','fw-1','AG-2','Agreement 2',400,'2026-01-01','2026-06-30','paused',1,'c','u'),
      ('ag-x','fw-x','AG-X','Agreement X',500,'2026-01-01','2026-12-31','active',1,'c','u');
  `);
  return { sqlite, repository: new SqlFinanceBudgetRepository(new SqliteDatabaseAdapter(sqlite)) };
}

const baseBudget = {
  id:'b1',projectId:'p1',projectName:'Project 1',frameworkId:'fw-1',totalAmountFen:1000,note:null,status:'draft',budgetVersion:0,version:1,
  allocations:[
    { agreementId:'ag-1',amountFen:600,agreementCode:'AG-1',agreementName:'Agreement 1' },
    { agreementId:'ag-2',amountFen:400,agreementCode:'AG-2',agreementName:'Agreement 2' },
  ],
  createdAt:'2026-01-10T00:00:00.000Z',updatedAt:'2026-01-10T00:00:00.000Z',
};

const mutationMeta = {
  actorId:'admin',auditId:'audit-1',idempotencyKey:'idem-1',operation:'budgets.create',requestHash:'hash-1',responseJson:'{}',
};

function allocationWrites(prefix, allocations = baseBudget.allocations) {
  return allocations.map((item, index) => ({ id:`${prefix}-${index}`,agreementId:item.agreementId,amountFen:item.amountFen }));
}

test('budget repository lists budgets with allocations and validates agreements without N+1 route queries', async () => {
  const { sqlite, repository } = createRepository();
  try {
    await repository.createBudget({ budget:baseBudget, allocations:allocationWrites('ba'), ...mutationMeta });
    assert.deepEqual(await repository.listBudgets(null), [baseBudget]);
    assert.deepEqual(await repository.findBudget('b1'), baseBudget);
    assert.equal(await repository.findBudget('missing'), null);

    const ok = await repository.validateAgreementAllocations('fw-1', [{ agreementId:'ag-1',amountFen:600 }], '2026-03-01', true);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.ok ? ok.summaries.map((item) => item.agreementCode) : [], ['AG-1']);
    assert.deepEqual(await repository.validateAgreementAllocations('fw-1', [{ agreementId:'missing',amountFen:1 }], null, false), { ok:false, reason:'not_found' });
    assert.deepEqual(await repository.validateAgreementAllocations('fw-1', [{ agreementId:'ag-x',amountFen:1 }], null, false), { ok:false, reason:'framework_mismatch' });
    assert.deepEqual(await repository.validateAgreementAllocations('fw-1', [{ agreementId:'ag-2',amountFen:1 }], '2026-03-01', true), { ok:false, reason:'not_effective' });
  } finally { sqlite.close(); }
});

test('budget update and confirmation keep version guard, immutable history, audit, and idempotency atomic', async () => {
  const { sqlite, repository } = createRepository();
  try {
    await repository.createBudget({ budget:baseBudget, allocations:allocationWrites('ba'), ...mutationMeta });
    const updated = { ...baseBudget,totalAmountFen:900,note:'revised',version:2,allocations:[{ agreementId:'ag-1',amountFen:900,agreementCode:'AG-1',agreementName:'Agreement 1' }],updatedAt:'2026-02-01T00:00:00.000Z' };
    await assert.rejects(repository.updateBudget({ before:baseBudget,next:updated,expectedVersion:0,allocations:allocationWrites('stale', updated.allocations),actorId:'admin',auditId:'audit-stale',idempotencyKey:'idem-stale',operation:'budgets.update:b1',requestHash:'stale',responseJson:'{}' }));
    assert.equal((await repository.findBudget('b1'))?.version,1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='audit-stale'").get().count,0);

    await repository.updateBudget({ before:baseBudget,next:updated,expectedVersion:1,allocations:allocationWrites('upd', updated.allocations),actorId:'admin',auditId:'audit-upd',idempotencyKey:'idem-upd',operation:'budgets.update:b1',requestHash:'upd',responseJson:'{}' });
    assert.equal((await repository.findBudget('b1'))?.totalAmountFen,900);

    const confirmed = { ...updated,status:'confirmed',budgetVersion:1,version:3,updatedAt:'2026-02-02T00:00:00.000Z' };
    await repository.confirmBudget({ before:updated,next:confirmed,expectedVersion:2,budgetVersionId:'bv-1',allocations:allocationWrites('bva', confirmed.allocations),actorId:'admin',auditId:'audit-confirm',idempotencyKey:'idem-confirm',operation:'budgets.confirm:b1',requestHash:'confirm',responseJson:'{}' });
    const history = await repository.getBudgetHistory('b1');
    assert.equal(history?.length,1);
    assert.deepEqual(history?.[0], { id:'bv-1',budgetId:'b1',projectId:'p1',frameworkId:'fw-1',budgetVersion:1,totalAmountFen:900,note:'revised',confirmedAt:'2026-02-02T00:00:00.000Z',allocations:confirmed.allocations });
  } finally { sqlite.close(); }
});
