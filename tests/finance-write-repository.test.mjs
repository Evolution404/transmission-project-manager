import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlFinanceWriteRepository } from '../apps/api/src/repositories/sql-finance-write-repository.ts';

function createRepository() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE frameworks (
      id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,name TEXT NOT NULL,total_amount_fen INTEGER NOT NULL,annual_target_fen INTEGER,
      start_date TEXT NOT NULL,end_date TEXT NOT NULL,version INTEGER NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE framework_versions (
      id TEXT PRIMARY KEY,framework_id TEXT NOT NULL,version INTEGER NOT NULL,code TEXT NOT NULL,name TEXT NOT NULL,total_amount_fen INTEGER NOT NULL,
      annual_target_fen INTEGER,start_date TEXT NOT NULL,end_date TEXT NOT NULL,reason TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE agreements (
      id TEXT PRIMARY KEY,framework_id TEXT NOT NULL,code TEXT NOT NULL,name TEXT NOT NULL,amount_fen INTEGER NOT NULL,valid_from TEXT NOT NULL,valid_to TEXT NOT NULL,
      status TEXT NOT NULL,version INTEGER NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL, UNIQUE(framework_id,code)
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,framework_id TEXT,version INTEGER NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE agreement_versions (
      id TEXT PRIMARY KEY,agreement_id TEXT NOT NULL,version INTEGER NOT NULL,framework_id TEXT NOT NULL,code TEXT NOT NULL,name TEXT NOT NULL,
      amount_fen INTEGER NOT NULL,valid_from TEXT NOT NULL,valid_to TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,actor_member_id TEXT,action TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL
    );
    CREATE TABLE idempotency_records (
      idempotency_key TEXT PRIMARY KEY,actor_member_id TEXT NOT NULL,operation TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,status_code INTEGER NOT NULL,created_at TEXT NOT NULL
    );
  `);
  return { sqlite, repository: new SqlFinanceWriteRepository(new SqliteDatabaseAdapter(sqlite)) };
}

const fw = { id:'fw-1',code:'FW-1',name:'Framework',totalAmountFen:1000,annualTargetFen:800,startDate:'2026-01-01',endDate:'2026-12-31',version:1,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z' };

test('framework create and update keep immutable version history atomically', async () => {
  const { sqlite, repository } = createRepository();
  try {
    await repository.createFramework({ framework: fw, versionId:'fw-v1', actorId:'admin', auditId:'audit-fw1', idempotencyKey:'idem-fw1', operation:'frameworks.create', requestHash:'h1', responseJson:'{}' });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM framework_versions WHERE framework_id='fw-1'").get().count,1);
    const next = { ...fw,name:'Framework 2',totalAmountFen:1200,version:2,updatedAt:'2026-02-01T00:00:00.000Z' };
    await assert.rejects(repository.updateFramework({ before:fw,next,expectedVersion:0,reason:'x',versionId:'fw-v2-stale',actorId:'admin',auditId:'audit-stale',idempotencyKey:'idem-stale',operation:'frameworks.update:fw-1',requestHash:'hs',responseJson:'{}' }));
    assert.equal(sqlite.prepare("SELECT name FROM frameworks WHERE id='fw-1'").get().name,'Framework');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM framework_versions WHERE id='fw-v2-stale'").get().count,0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='idem-stale'").get().count,0);
    await repository.updateFramework({ before:fw,next,expectedVersion:1,reason:'update',versionId:'fw-v2',actorId:'admin',auditId:'audit-fw2',idempotencyKey:'idem-fw2',operation:'frameworks.update:fw-1',requestHash:'h2',responseJson:'{}' });
    assert.deepEqual({ ...sqlite.prepare("SELECT name,total_amount_fen,version FROM frameworks WHERE id='fw-1'").get() },{name:'Framework 2',total_amount_fen:1200,version:2});
    assert.equal(sqlite.prepare("SELECT reason FROM framework_versions WHERE id='fw-v2'").get().reason,'update');
  } finally { sqlite.close(); }
});

test('project framework binding keeps version guard, audit, and idempotency atomic', async () => {
  const { sqlite, repository } = createRepository();
  try {
    sqlite.prepare("INSERT INTO projects (id,name,framework_id,version,updated_at) VALUES ('p1','Project',NULL,1,'2026-01-01T00:00:00.000Z')").run();
    await assert.rejects(repository.bindProjectFramework({ projectId:'p1',beforeFrameworkId:null,frameworkId:'fw-1',expectedVersion:0,nextVersion:1,now:'2026-02-01T00:00:00.000Z',actorId:'admin',auditId:'audit-bind-stale',idempotencyKey:'idem-bind-stale',operation:'projects.framework:p1',requestHash:'bs',responseJson:'{}' }));
    assert.deepEqual({ ...sqlite.prepare("SELECT framework_id,version FROM projects WHERE id='p1'").get() }, { framework_id:null, version:1 });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='audit-bind-stale'").get().count,0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='idem-bind-stale'").get().count,0);
    await repository.bindProjectFramework({ projectId:'p1',beforeFrameworkId:null,frameworkId:'fw-1',expectedVersion:1,nextVersion:2,now:'2026-02-01T00:00:00.000Z',actorId:'admin',auditId:'audit-bind',idempotencyKey:'idem-bind',operation:'projects.framework:p1',requestHash:'b1',responseJson:'{}' });
    assert.deepEqual({ ...sqlite.prepare("SELECT framework_id,version,updated_at FROM projects WHERE id='p1'").get() }, { framework_id:'fw-1', version:2, updated_at:'2026-02-01T00:00:00.000Z' });
  } finally { sqlite.close(); }
});

test('agreement create and update preserve immutable versions and stale writes roll back', async () => {
  const { sqlite, repository } = createRepository();
  try {
    await repository.createFramework({ framework: fw, versionId:'fw-v1', actorId:'admin', auditId:'audit-fw1', idempotencyKey:'idem-fw1', operation:'frameworks.create', requestHash:'h1', responseJson:'{}' });
    const ag = { id:'ag-1',frameworkId:'fw-1',code:'AG-1',name:'Agreement',amountFen:400,validFrom:'2026-01-01',validTo:'2026-12-31',status:'active',version:1,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z' };
    await repository.createAgreement({ agreement:ag,versionId:'ag-v1',actorId:'admin',auditId:'audit-ag1',idempotencyKey:'idem-ag1',operation:'agreements.create',requestHash:'a1',responseJson:'{}' });
    const next = { ...ag,name:'Agreement 2',amountFen:500,status:'paused',version:2,updatedAt:'2026-02-01T00:00:00.000Z' };
    await assert.rejects(repository.updateAgreement({ before:ag,next,expectedVersion:0,reason:'x',versionId:'ag-v2-stale',actorId:'admin',auditId:'audit-ags',idempotencyKey:'idem-ags',operation:'agreements.update:ag-1',requestHash:'as',responseJson:'{}' }));
    assert.equal(sqlite.prepare("SELECT version FROM agreements WHERE id='ag-1'").get().version,1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM agreement_versions WHERE id='ag-v2-stale'").get().count,0);
    await repository.updateAgreement({ before:ag,next,expectedVersion:1,reason:'pause',versionId:'ag-v2',actorId:'admin',auditId:'audit-ag2',idempotencyKey:'idem-ag2',operation:'agreements.update:ag-1',requestHash:'a2',responseJson:'{}' });
    assert.deepEqual({ ...sqlite.prepare("SELECT name,amount_fen,status,version FROM agreements WHERE id='ag-1'").get() },{name:'Agreement 2',amount_fen:500,status:'paused',version:2});
  } finally { sqlite.close(); }
});
