import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlReserveCategoryWriteRepository } from '../apps/api/src/repositories/sql-reserve-category-write-repository.ts';

function createRepository() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE reserve_categories (
      id TEXT PRIMARY KEY, category_key TEXT NOT NULL COLLATE NOCASE UNIQUE, label TEXT NOT NULL,
      enabled INTEGER NOT NULL, version INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE category_mappings (
      id TEXT PRIMARY KEY, demand_category_key TEXT NOT NULL COLLATE NOCASE UNIQUE, reserve_category_id TEXT NOT NULL,
      version INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
  return { sqlite, repository: new SqlReserveCategoryWriteRepository(new SqliteDatabaseAdapter(sqlite)) };
}

test('reserve category creation is atomic with audit and idempotency', async () => {
  const { sqlite, repository } = createRepository();
  try {
    const category = { id: 'rc-1', key: 'construction', label: 'Construction', enabled: true, version: 1 };
    await repository.createCategory({
      category, actorId: 'admin-1', now: '2026-09-14T02:30:00.000Z', auditId: 'audit-1',
      idempotencyKey: 'idem-1', operation: 'reserve-categories.create', requestHash: 'hash-1', responseJson: '{}',
    });
    assert.deepEqual(await repository.findCategory('rc-1'), category);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='audit-1'").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='idem-1'").get().count, 1);
  } finally { sqlite.close(); }
});

test('category mapping upsert uses optimistic versioning and rolls back stale writes', async () => {
  const { sqlite, repository } = createRepository();
  try {
    sqlite.prepare("INSERT INTO reserve_categories VALUES ('rc-1','construction','Construction',1,1,'admin-1','t','t')").run();
    const first = {
      id: 'map-1', demandCategory: '防断线', reserveCategoryId: 'rc-1', version: 1,
    };
    await repository.upsertMapping({
      mapping: first, expectedVersion: null, actorId: 'admin-1', now: '2026-09-14T02:31:00.000Z', auditId: 'audit-map-1',
      idempotencyKey: 'idem-map-1', operation: 'category-mappings:防断线', requestHash: 'hash-map-1', responseJson: '{}', before: null,
    });
    assert.deepEqual(await repository.findMapping('防断线'), first);

    await assert.rejects(repository.upsertMapping({
      mapping: { ...first, version: 2 }, expectedVersion: 0, actorId: 'admin-1', now: '2026-09-14T02:32:00.000Z', auditId: 'audit-map-2',
      idempotencyKey: 'idem-map-2', operation: 'category-mappings:防断线', requestHash: 'hash-map-2', responseJson: '{}', before: first,
    }));
    assert.equal((await repository.findMapping('防断线'))?.version, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='idem-map-2'").get().count, 0);
  } finally { sqlite.close(); }
});
