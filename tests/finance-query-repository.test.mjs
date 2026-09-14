import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlFinanceQueryRepository } from '../apps/api/src/repositories/sql-finance-query-repository.ts';

function createRepository() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,business_year INTEGER,status TEXT NOT NULL,framework_id TEXT,version INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE frameworks (
      id TEXT PRIMARY KEY,code TEXT NOT NULL,name TEXT NOT NULL,total_amount_fen INTEGER NOT NULL,annual_target_fen INTEGER,
      start_date TEXT NOT NULL,end_date TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE framework_versions (
      id TEXT PRIMARY KEY,framework_id TEXT NOT NULL,version INTEGER NOT NULL,code TEXT NOT NULL,name TEXT NOT NULL,total_amount_fen INTEGER NOT NULL,
      annual_target_fen INTEGER,start_date TEXT NOT NULL,end_date TEXT NOT NULL,reason TEXT,created_at TEXT NOT NULL
    );
    CREATE TABLE agreements (
      id TEXT PRIMARY KEY,framework_id TEXT NOT NULL,code TEXT NOT NULL,name TEXT NOT NULL,amount_fen INTEGER NOT NULL,
      valid_from TEXT NOT NULL,valid_to TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE agreement_versions (
      id TEXT PRIMARY KEY,agreement_id TEXT NOT NULL,version INTEGER NOT NULL,framework_id TEXT NOT NULL,code TEXT NOT NULL,name TEXT NOT NULL,
      amount_fen INTEGER NOT NULL,valid_from TEXT NOT NULL,valid_to TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,created_at TEXT NOT NULL
    );
    CREATE TABLE budget_versions (id TEXT PRIMARY KEY,project_id TEXT NOT NULL);
    CREATE TABLE financial_entries (id TEXT PRIMARY KEY,project_id TEXT NOT NULL);
    INSERT INTO projects VALUES
      ('p2','Project B',2026,'confirmed','fw-b',2,'2026-09-14T02:00:00.000Z'),
      ('p1','Project A',2025,'draft','fw-a',1,'2026-09-14T01:00:00.000Z');
    INSERT INTO frameworks VALUES
      ('fw-b','B','Framework B',2000,NULL,'2026-01-01','2026-12-31',1,'c','u'),
      ('fw-a','A','Framework A',1000,800,'2026-01-01','2026-12-31',2,'c','u');
    INSERT INTO framework_versions VALUES
      ('fw-a-v2','fw-a',2,'A','Framework A',1000,800,'2026-01-01','2026-12-31','update','2026-02-01'),
      ('fw-a-v1','fw-a',1,'A','Framework A Old',900,700,'2026-01-01','2026-12-31',NULL,'2026-01-01');
    INSERT INTO agreements VALUES
      ('ag-b','fw-b','B-1','Agreement B',900,'2026-01-01','2026-12-31','active',1,'c','u'),
      ('ag-a2','fw-a','A-2','Agreement A2',500,'2026-01-01','2026-12-31','paused',1,'c','u'),
      ('ag-a1','fw-a','A-1','Agreement A1',400,'2026-01-01','2026-12-31','active',2,'c','u');
    INSERT INTO agreement_versions VALUES
      ('ag-a1-v2','ag-a1',2,'fw-a','A-1','Agreement A1',400,'2026-01-01','2026-12-31','active','update','2026-02-01'),
      ('ag-a1-v1','ag-a1',1,'fw-a','A-1','Agreement A1 Old',300,'2026-01-01','2026-12-31','active',NULL,'2026-01-01');
    INSERT INTO budget_versions VALUES ('bv-p2','p2');
  `);
  return { sqlite, repository: new SqlFinanceQueryRepository(new SqliteDatabaseAdapter(sqlite)) };
}

test('finance query repository lists projects and frameworks as business DTOs', async () => {
  const { sqlite, repository } = createRepository();
  try {
    assert.deepEqual(await repository.listProjects(), [
      { id: 'p2', name: 'Project B', year: 2026, status: 'confirmed', frameworkId: 'fw-b', version: 2 },
      { id: 'p1', name: 'Project A', year: 2025, status: 'draft', frameworkId: 'fw-a', version: 1 },
    ]);
    assert.deepEqual((await repository.listFrameworks()).map((item) => item.id), ['fw-a', 'fw-b']);
    assert.equal((await repository.findFramework('fw-a'))?.annualTargetFen, 800);
    assert.equal(await repository.findFramework('missing'), null);
    assert.deepEqual(await repository.findProject('p1'), { id: 'p1', name: 'Project A', year: 2025, status: 'draft', frameworkId: 'fw-a', version: 1 });
    assert.equal(await repository.findProject('missing'), null);
    assert.equal(await repository.hasProjectFinanceHistory('p1'), false);
    assert.equal(await repository.hasProjectFinanceHistory('p2'), true);
    const valid = await repository.validateAgreementAllocations('fw-a', [{ agreementId: 'ag-a1', amountFen: 300 }], '2026-03-01', true);
    assert.deepEqual(valid, { ok: true, summaries: [{ agreementId: 'ag-a1', amountFen: 300, agreementCode: 'A-1', agreementName: 'Agreement A1' }] });
    assert.deepEqual(await repository.validateAgreementAllocations('fw-a', [{ agreementId: 'missing', amountFen: 1 }], null, false), { ok: false, reason: 'not_found' });
    assert.deepEqual(await repository.validateAgreementAllocations('fw-a', [{ agreementId: 'ag-b', amountFen: 1 }], null, false), { ok: false, reason: 'framework_mismatch' });
    assert.deepEqual(await repository.validateAgreementAllocations('fw-a', [{ agreementId: 'ag-a2', amountFen: 1 }], '2026-03-01', true), { ok: false, reason: 'not_effective' });
  } finally { sqlite.close(); }
});

test('finance query repository lists framework history and agreements without leaking SQL rows', async () => {
  const { sqlite, repository } = createRepository();
  try {
    assert.deepEqual((await repository.getFrameworkHistory('fw-a'))?.map((item) => item.version), [2, 1]);
    assert.equal(await repository.getFrameworkHistory('missing'), null);
    assert.deepEqual((await repository.listAgreements('fw-a')).map((item) => item.code), ['A-1', 'A-2']);
    assert.deepEqual((await repository.listAgreements(null)).map((item) => item.code), ['A-1', 'A-2', 'B-1']);
    assert.equal((await repository.findAgreement('ag-a1'))?.version, 2);
    assert.deepEqual((await repository.getAgreementHistory('ag-a1'))?.map((item) => item.version), [2, 1]);
    assert.equal(await repository.getAgreementHistory('missing'), null);
  } finally { sqlite.close(); }
});
