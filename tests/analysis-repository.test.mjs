import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlAnalysisRepository } from '../apps/api/src/repositories/sql-analysis-repository.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE analysis_rules (id TEXT PRIMARY KEY,version INTEGER NOT NULL UNIQUE,mode TEXT NOT NULL,threshold_basis_points INTEGER NOT NULL,effective_from TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE frameworks (id TEXT PRIMARY KEY,code TEXT,name TEXT,total_amount_fen INTEGER,annual_target_fen INTEGER,start_date TEXT,end_date TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY,framework_id TEXT,name TEXT);
    CREATE TABLE monthly_plans (id TEXT PRIMARY KEY,project_id TEXT,business_year INTEGER,month INTEGER,target_amount_fen INTEGER,version INTEGER,created_by TEXT,created_at TEXT,updated_at TEXT NOT NULL,UNIQUE(project_id,business_year,month));
    CREATE TABLE financial_entries (id TEXT PRIMARY KEY,framework_id TEXT,project_id TEXT,entry_type TEXT,business_date TEXT,amount_fen INTEGER);
    CREATE TABLE report_snapshots (id TEXT PRIMARY KEY,framework_id TEXT,business_month TEXT,revision INTEGER,data_cutoff_date TEXT,rule_version INTEGER,rule_json TEXT,snapshot_json TEXT,created_by TEXT,created_at TEXT,UNIQUE(framework_id,business_month,revision));
    CREATE TABLE annual_milestones (id TEXT PRIMARY KEY,business_year INTEGER,title TEXT,owner TEXT,project_id TEXT,date_precision TEXT,month INTEGER,specific_date TEXT,lead_days_json TEXT,status TEXT,version INTEGER,created_by TEXT,created_at TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE audit_events (id TEXT PRIMARY KEY,actor_member_id TEXT,action TEXT,object_type TEXT,object_id TEXT,before_json TEXT,after_json TEXT,created_at TEXT);
    CREATE TABLE idempotency_records (idempotency_key TEXT PRIMARY KEY,actor_member_id TEXT,operation TEXT,request_hash TEXT,response_json TEXT,status_code INTEGER,created_at TEXT);
    INSERT INTO analysis_rules VALUES ('r1',1,'ratio',8000,'2026-01-01T00:00:00.000Z','admin','2026-01-01T00:00:00.000Z');
    INSERT INTO frameworks VALUES ('fw1','FW1','框架1',120000,120000,'2026-01-01','2026-12-31');
    INSERT INTO projects VALUES ('p1','fw1','项目1');
    INSERT INTO monthly_plans VALUES ('mp1','p1',2026,1,10000,1,'admin','c','c');
    INSERT INTO financial_entries VALUES ('fe1','fw1','p1','budget_occurrence','2026-01-20',8000);
  `);
  return { sqlite, repository: new SqlAnalysisRepository(new SqliteDatabaseAdapter(sqlite)) };
}

function meta(key, now='2026-02-01T00:00:00.000Z') {
  return { actorId:'admin',auditId:`audit-${key}`,idempotencyKey:key,operation:`op-${key}`,requestHash:`hash-${key}`,responseJson:'{}',statusCode:200,now };
}

test('analysis repository exposes portable progress facts and versioned plan writes', async () => {
  const { sqlite, repository } = fixture();
  try {
    assert.equal((await repository.currentRule()).thresholdBasisPoints, 8000);
    assert.deepEqual(await repository.planMeta('fw1', 2026, 1), { countAll: 1, cumulativeFen: 10000 });
    assert.equal(await repository.actualFrameworkOccurrence('fw1', 2026, '2026-01-31'), 8000);
    const previous = await repository.findPlan('p1', 2026, 1);
    const next = { ...previous, targetAmountFen: 12000, version: 2, updatedAt: '2026-02-01T00:00:00.000Z' };
    await repository.putPlan({ previous, next, meta: meta('plan') });
    assert.equal((await repository.findPlan('p1', 2026, 1)).targetAmountFen, 12000);
    assert.equal(sqlite.prepare("SELECT status_code FROM idempotency_records WHERE idempotency_key='plan'").get().status_code, 200);
  } finally { sqlite.close(); }
});

test('analysis repository keeps stale plan writes atomic', async () => {
  const { sqlite, repository } = fixture();
  try {
    const previous = await repository.findPlan('p1', 2026, 1);
    sqlite.prepare("UPDATE monthly_plans SET version=2 WHERE id='mp1'").run();
    const next = { ...previous, targetAmountFen: 13000, version: 2, updatedAt: '2026-02-01T00:00:00.000Z' };
    await assert.rejects(repository.putPlan({ previous, next, meta: meta('stale') }));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='audit-stale'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='stale'").get().count, 0);
  } finally { sqlite.close(); }
});
