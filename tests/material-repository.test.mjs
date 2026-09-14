import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlMaterialRepository } from '../apps/api/src/repositories/sql-material-repository.ts';

function createRepository() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE materials (
      id TEXT PRIMARY KEY, code TEXT COLLATE NOCASE UNIQUE, name TEXT NOT NULL,
      model TEXT NOT NULL COLLATE NOCASE, unit TEXT NOT NULL COLLATE NOCASE,
      enabled INTEGER NOT NULL, version INTEGER NOT NULL, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(model,unit)
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY, actor_member_id TEXT, action TEXT NOT NULL, object_type TEXT NOT NULL,
      object_id TEXT NOT NULL, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE idempotency_records (
      idempotency_key TEXT PRIMARY KEY, actor_member_id TEXT NOT NULL, operation TEXT NOT NULL,
      request_hash TEXT NOT NULL, response_json TEXT NOT NULL, status_code INTEGER NOT NULL, created_at TEXT NOT NULL
    );
  `);
  return { sqlite, repository: new SqlMaterialRepository(new SqliteDatabaseAdapter(sqlite)) };
}

function input(id, model, unit, suffix = id) {
  const material = { id, code: `C-${suffix}`, name: `Material ${suffix}`, model, unit, enabled: true, version: 1 };
  return {
    material,
    actorId: 'admin-1', now: '2026-09-14T01:00:00.000Z', auditId: `audit-${suffix}`,
    idempotencyKey: `idem-${suffix}`, operation: 'materials.create', requestHash: `hash-${suffix}`,
    responseJson: JSON.stringify({ ok: true, data: material }),
  };
}

test('material repository creates atomically and allows the same model with different units', async () => {
  const { sqlite, repository } = createRepository();
  try {
    await repository.create(input('m1', 'X-1', 'piece', '1'));
    await repository.create(input('m2', 'X-1', 'set', '2'));
    assert.deepEqual(await repository.list({ query: '', limit: 100 }), [
      { id: 'm1', code: 'C-1', name: 'Material 1', model: 'X-1', unit: 'piece', enabled: true, version: 1 },
      { id: 'm2', code: 'C-2', name: 'Material 2', model: 'X-1', unit: 'set', enabled: true, version: 1 },
    ]);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 2);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM idempotency_records').get().count, 2);
  } finally { sqlite.close(); }
});

test('material repository search is bounded and duplicate model+unit rolls back metadata writes', async () => {
  const { sqlite, repository } = createRepository();
  try {
    await repository.create(input('m1', 'ABC-10', 'piece', '1'));
    await repository.create(input('m2', 'XYZ-20', 'set', '2'));
    assert.deepEqual((await repository.list({ query: 'abc', limit: 10 })).map((item) => item.id), ['m1']);
    await assert.rejects(repository.create({ ...input('m3', 'ABC-10', 'piece', '3'), material: { ...input('m3', 'ABC-10', 'piece', '3').material, code: 'C-3' } }));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM materials WHERE id='m3'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='audit-3'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='idem-3'").get().count, 0);
  } finally { sqlite.close(); }
});
