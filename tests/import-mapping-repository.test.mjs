import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlImportMappingRepository } from '../apps/api/src/repositories/sql-import-mapping-repository.ts';

function createRepository() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE import_mapping_templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, mapping_json TEXT NOT NULL,
      version INTEGER NOT NULL, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
  return { sqlite, repository: new SqlImportMappingRepository(new SqliteDatabaseAdapter(sqlite)) };
}

const mapping = {
  sequenceNo: '序号', voltage: '电压', lineName: '线路', section: '杆段',
  materialModel: '型号', materialQuantity: '数量', unit: '单位', year: '年度', category: '类别', owner: '负责人',
};

test('import mapping repository creates mapping, audit and idempotency atomically and lists portable summaries', async () => {
  const { sqlite, repository } = createRepository();
  try {
    const created = {
      id: 'map-1', name: '标准模板', mapping, version: 1,
      createdAt: '2026-09-14T01:00:00.000Z', updatedAt: '2026-09-14T01:00:00.000Z',
    };
    await repository.create({
      template: created,
      actorId: 'admin-1', auditId: 'audit-1',
      idempotencyKey: 'idem-1', operation: 'import-mappings.create', requestHash: 'hash-1',
      responseJson: JSON.stringify({ ok: true, data: created }),
    });
    assert.deepEqual(await repository.list(), [created]);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE object_id='map-1'").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='idem-1'").get().count, 1);
  } finally { sqlite.close(); }
});

test('duplicate mapping name rolls back audit and idempotency with the failed insert', async () => {
  const { sqlite, repository } = createRepository();
  try {
    const first = { id: 'map-1', name: 'Template', mapping, version: 1, createdAt: '2026-09-14T01:00:00.000Z', updatedAt: '2026-09-14T01:00:00.000Z' };
    await repository.create({ template: first, actorId: 'admin-1', auditId: 'audit-1', idempotencyKey: 'idem-1', operation: 'import-mappings.create', requestHash: 'hash-1', responseJson: '{}' });
    await assert.rejects(repository.create({
      template: { ...first, id: 'map-2', name: 'template' }, actorId: 'admin-1', auditId: 'audit-2',
      idempotencyKey: 'idem-2', operation: 'import-mappings.create', requestHash: 'hash-2', responseJson: '{}',
    }));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM import_mapping_templates").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='audit-2'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='idem-2'").get().count, 0);
  } finally { sqlite.close(); }
});
