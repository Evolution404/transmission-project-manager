import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlImportRepository } from '../apps/api/src/repositories/sql-import-repository.ts';

function createRepository() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE import_batches (
      id TEXT PRIMARY KEY, file_name TEXT NOT NULL, file_sha256 TEXT NOT NULL COLLATE NOCASE UNIQUE,
      file_type TEXT NOT NULL, mapping_json TEXT NOT NULL, status TEXT NOT NULL,
      uploaded_rows INTEGER NOT NULL, valid_rows INTEGER NOT NULL, error_rows INTEGER NOT NULL,
      warning_rows INTEGER NOT NULL, published_rows INTEGER NOT NULL, version INTEGER NOT NULL,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT
    );
    CREATE TABLE import_rows (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, sheet_name TEXT NOT NULL,
      source_row_number INTEGER NOT NULL, source_key TEXT NOT NULL UNIQUE, raw_json TEXT NOT NULL,
      normalized_json TEXT, errors_json TEXT NOT NULL, warnings_json TEXT NOT NULL, row_status TEXT NOT NULL,
      published_demand_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(batch_id,sheet_name,source_row_number)
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
  return { sqlite, repository: new SqlImportRepository(new SqliteDatabaseAdapter(sqlite)) };
}

const mapping = { sequenceNo: '序号', voltage: '电压', lineName: '线路', section: '杆段', materialModel: '型号', materialQuantity: '数量' };
const batch = {
  id: 'batch-1', fileName: 'input.xlsx', fileSha256: 'a'.repeat(64), fileType: 'xlsx', mapping,
  status: 'draft', uploadedRows: 0, validRows: 0, errorRows: 0, warningRows: 0, publishedRows: 0,
  version: 1, createdAt: '2026-09-14T01:00:00.000Z', updatedAt: '2026-09-14T01:00:00.000Z', publishedAt: null,
};

test('import repository creates a batch with audit and idempotency atomically', async () => {
  const { sqlite, repository } = createRepository();
  try {
    await repository.create({
      batch, actorId: 'admin-1', auditId: 'audit-1', idempotencyKey: 'idem-1', operation: 'imports.create',
      requestHash: 'hash-1', responseJson: JSON.stringify({ ok: true, data: batch }),
    });
    assert.deepEqual(await repository.findById('batch-1'), batch);
    assert.deepEqual(await repository.findByFileHash(batch.fileSha256), batch);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE object_id='batch-1'").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='idem-1'").get().count, 1);
  } finally { sqlite.close(); }
});

test('duplicate file hash cannot leave a second audit or idempotency row, while reuse can record its response', async () => {
  const { sqlite, repository } = createRepository();
  try {
    await repository.create({ batch, actorId: 'admin-1', auditId: 'audit-1', idempotencyKey: 'idem-1', operation: 'imports.create', requestHash: 'hash-1', responseJson: '{}' });
    await assert.rejects(repository.create({
      batch: { ...batch, id: 'batch-2' }, actorId: 'admin-1', auditId: 'audit-2', idempotencyKey: 'idem-2', operation: 'imports.create', requestHash: 'hash-2', responseJson: '{}',
    }));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM import_batches").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id='audit-2'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='idem-2'").get().count, 0);

    await repository.recordReuse({ idempotencyKey: 'idem-reuse', actorId: 'admin-1', operation: 'imports.create', requestHash: 'hash-reuse', responseJson: '{"ok":true}', now: '2026-09-14T01:01:00.000Z' });
    assert.equal(sqlite.prepare("SELECT status_code FROM idempotency_records WHERE idempotency_key='idem-reuse'").get().status_code, 200);
  } finally { sqlite.close(); }
});

test('chunk upload atomically inserts source rows and advances batch version', async () => {
  const { sqlite, repository } = createRepository();
  try {
    await repository.create({ batch, actorId: 'admin-1', auditId: 'audit-1', idempotencyKey: 'idem-create', operation: 'imports.create', requestHash: 'hash-create', responseJson: '{}' });
    await repository.uploadChunk({
      batchId: 'batch-1', expectedVersion: 1, chunkIndex: 0, actorId: 'admin-1', now: '2026-09-14T01:05:00.000Z',
      idempotencyKey: 'idem-chunk', operation: 'imports.chunk:batch-1', requestHash: 'hash-chunk', responseJson: '{"ok":true}',
      rows: [
        { id: 'row-1', sheetName: 'Sheet1', rowNumber: 2, sourceKey: 'source-1', rawJson: '{"A":1}' },
        { id: 'row-2', sheetName: 'Sheet1', rowNumber: 3, sourceKey: 'source-2', rawJson: '{"A":2}' },
      ],
    });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM import_rows WHERE batch_id='batch-1'").get().count, 2);
    assert.deepEqual((await repository.listRows('batch-1', 100)).map((row) => row.id), ['row-1', 'row-2']);
    assert.deepEqual(await repository.findById('batch-1'), { ...batch, uploadedRows: 2, version: 2, updatedAt: '2026-09-14T01:05:00.000Z' });
    assert.equal(sqlite.prepare("SELECT status_code FROM idempotency_records WHERE idempotency_key='idem-chunk'").get().status_code, 200);
  } finally { sqlite.close(); }
});

test('stale chunk version rolls back source rows and idempotency record', async () => {
  const { sqlite, repository } = createRepository();
  try {
    await repository.create({ batch, actorId: 'admin-1', auditId: 'audit-1', idempotencyKey: 'idem-create', operation: 'imports.create', requestHash: 'hash-create', responseJson: '{}' });
    await assert.rejects(repository.uploadChunk({
      batchId: 'batch-1', expectedVersion: 2, chunkIndex: 0, actorId: 'admin-1', now: '2026-09-14T01:05:00.000Z',
      idempotencyKey: 'idem-stale', operation: 'imports.chunk:batch-1', requestHash: 'hash-stale', responseJson: '{}',
      rows: [{ id: 'row-stale', sheetName: 'Sheet1', rowNumber: 2, sourceKey: 'source-stale', rawJson: '{}' }],
    }));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM import_rows").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='idem-stale'").get().count, 0);
    assert.equal((await repository.findById('batch-1')).version, 1);
  } finally { sqlite.close(); }
});
