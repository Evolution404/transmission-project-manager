import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlOperationJournalRepository } from '../apps/api/src/repositories/sql-operation-journal-repository.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE audit_events (id TEXT PRIMARY KEY,actor_member_id TEXT,action TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL);
    CREATE TABLE idempotency_records (idempotency_key TEXT PRIMARY KEY,actor_member_id TEXT NOT NULL,operation TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,status_code INTEGER NOT NULL,created_at TEXT NOT NULL);
  `);
  return { sqlite, repository: new SqlOperationJournalRepository(new SqliteDatabaseAdapter(sqlite)) };
}

test('operation journal records audit and idempotency atomically', async () => {
  const { sqlite, repository } = fixture();
  try {
    const input = {
      auditId: 'a1', actorId: 'm1', action: 'test.action', objectType: 'object', objectId: 'o1',
      before: null, after: { ok: true }, idempotencyKey: 'i1', operation: 'test.operation', requestHash: 'h1',
      responseJson: '{"ok":true}', statusCode: 200, now: '2026-09-14T00:00:00.000Z',
    };
    await repository.record(input);
    assert.equal(sqlite.prepare("SELECT action FROM audit_events WHERE id='a1'").get().action, 'test.action');
    assert.equal(sqlite.prepare("SELECT status_code FROM idempotency_records WHERE idempotency_key='i1'").get().status_code, 200);
    await assert.rejects(repository.record({ ...input, auditId: 'a2' }));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='a2'").get().count, 0);
  } finally { sqlite.close(); }
});
