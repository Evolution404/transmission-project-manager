import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlFinanceEntryRepository } from '../apps/api/src/repositories/sql-finance-entry-repository.ts';

function createRepository() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE agreements (id TEXT PRIMARY KEY,code TEXT NOT NULL,name TEXT NOT NULL);
    CREATE TABLE financial_entries (
      id TEXT PRIMARY KEY,framework_id TEXT NOT NULL,project_id TEXT NOT NULL,entry_type TEXT NOT NULL,business_date TEXT NOT NULL,
      amount_fen INTEGER NOT NULL,note TEXT,reverses_entry_id TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_reversal_once ON financial_entries(reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
    CREATE TABLE financial_entry_allocations (
      id TEXT PRIMARY KEY,financial_entry_id TEXT NOT NULL,agreement_id TEXT NOT NULL,amount_fen INTEGER NOT NULL,created_at TEXT NOT NULL,
      UNIQUE(financial_entry_id,agreement_id)
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,actor_member_id TEXT,action TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL
    );
    CREATE TABLE idempotency_records (
      idempotency_key TEXT PRIMARY KEY,actor_member_id TEXT NOT NULL,operation TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,status_code INTEGER NOT NULL,created_at TEXT NOT NULL
    );
    INSERT INTO projects VALUES ('p1','Project 1'),('p2','Project 2');
    INSERT INTO agreements VALUES ('ag-1','AG-1','Agreement 1'),('ag-2','AG-2','Agreement 2');
  `);
  return { sqlite, repository: new SqlFinanceEntryRepository(new SqliteDatabaseAdapter(sqlite)) };
}

function meta(suffix, operation = 'financial-entries.create') {
  return { actorId:'admin',auditId:`audit-${suffix}`,idempotencyKey:`idem-${suffix}`,operation,requestHash:`hash-${suffix}`,responseJson:'{}' };
}

function entry(id, businessDate, createdAt, overrides = {}) {
  return {
    id,frameworkId:'fw-1',projectId:'p1',projectName:'Project 1',type:'budget_occurrence',businessDate,amountFen:100,
    note:null,reversesEntryId:null,allocations:[{agreementId:'ag-1',amountFen:100,agreementCode:'AG-1',agreementName:'Agreement 1'}],createdAt,
    ...overrides,
  };
}

function writes(prefix, allocations) {
  return allocations.map((item, index) => ({ id:`${prefix}-${index}`,agreementId:item.agreementId,amountFen:item.amountFen }));
}

test('financial entry repository creates, finds, and keyset-lists entries with allocations', async () => {
  const { sqlite, repository } = createRepository();
  try {
    const e1 = entry('e1','2026-03-03','2026-03-03T01:00:00.000Z');
    const e2 = entry('e2','2026-03-02','2026-03-02T01:00:00.000Z',{projectId:'p2',projectName:'Project 2',type:'actual_cost'});
    const e3 = entry('e3','2026-03-01','2026-03-01T01:00:00.000Z');
    for (const [index, item] of [e1,e2,e3].entries()) {
      await repository.createEntry({ entry:item, allocations:writes(`ea-${index}`, item.allocations), ...meta(index) });
    }
    assert.deepEqual(await repository.findEntry('e1'), e1);
    assert.equal(await repository.findEntry('missing'), null);
    assert.deepEqual((await repository.listEntries({frameworkId:null,projectId:null,cursor:null,limit:2})).map((item) => item.id), ['e1','e2']);
    assert.deepEqual((await repository.listEntries({frameworkId:null,projectId:null,cursor:{businessDate:'2026-03-02',createdAt:'2026-03-02T01:00:00.000Z',id:'e2'},limit:2})).map((item) => item.id), ['e3']);
    assert.deepEqual((await repository.listEntries({frameworkId:'fw-1',projectId:'p2',cursor:null,limit:10})).map((item) => item.id), ['e2']);
  } finally { sqlite.close(); }
});

test('reversal write is atomic and a second reversal is rejected by the unique fact', async () => {
  const { sqlite, repository } = createRepository();
  try {
    const original = entry('e1','2026-03-03','2026-03-03T01:00:00.000Z');
    await repository.createEntry({ entry:original, allocations:writes('orig', original.allocations), ...meta('orig') });
    assert.equal(await repository.hasReversal('e1'), false);
    const reversal = entry('r1','2026-03-04','2026-03-04T01:00:00.000Z',{
      amountFen:-100,note:'reverse',reversesEntryId:'e1',allocations:[{agreementId:'ag-1',amountFen:-100,agreementCode:'AG-1',agreementName:'Agreement 1'}],
    });
    await repository.reverseEntry({ original,reversal,allocations:writes('rev', reversal.allocations),...meta('rev','financial-entries.reverse:e1') });
    assert.equal(await repository.hasReversal('e1'), true);
    assert.deepEqual(await repository.findEntry('r1'), reversal);

    const second = entry('r2','2026-03-05','2026-03-05T01:00:00.000Z',{
      amountFen:-100,note:'again',reversesEntryId:'e1',allocations:[{agreementId:'ag-1',amountFen:-100,agreementCode:'AG-1',agreementName:'Agreement 1'}],
    });
    await assert.rejects(repository.reverseEntry({ original,reversal:second,allocations:writes('rev2', second.allocations),...meta('rev2','financial-entries.reverse:e1') }));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM financial_entries WHERE reverses_entry_id='e1'").get().count,1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='audit-rev2'").get().count,0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='idem-rev2'").get().count,0);
  } finally { sqlite.close(); }
});
