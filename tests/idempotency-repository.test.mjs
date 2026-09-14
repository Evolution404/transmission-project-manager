import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlIdempotencyRepository } from '../apps/api/src/repositories/sql-idempotency-repository.ts';

test('idempotency repository reads replay records through DatabasePort', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(`CREATE TABLE idempotency_records (
      idempotency_key TEXT PRIMARY KEY, actor_member_id TEXT NOT NULL, operation TEXT NOT NULL,
      request_hash TEXT NOT NULL, response_json TEXT NOT NULL, status_code INTEGER NOT NULL, created_at TEXT NOT NULL
    );`);
    sqlite.prepare('INSERT INTO idempotency_records VALUES (?,?,?,?,?,?,?)').run(
      'key-1','actor-1','POST:/api/x','hash-1','{"ok":true}',201,'2026-09-14T01:00:00.000Z'
    );
    const repository = new SqlIdempotencyRepository(new SqliteDatabaseAdapter(sqlite));
    assert.deepEqual(await repository.findByKey('key-1'), {
      actorMemberId: 'actor-1', operation: 'POST:/api/x', requestHash: 'hash-1', responseJson: '{"ok":true}', statusCode: 201,
    });
    assert.equal(await repository.findByKey('missing'), null);
  } finally { sqlite.close(); }
});
