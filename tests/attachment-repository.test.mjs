import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlAttachmentRepository } from '../apps/api/src/repositories/sql-attachment-repository.ts';

function createRepository() {
  const sqlite = new DatabaseSync(':memory:');
  const database = new SqliteDatabaseAdapter(sqlite);
  sqlite.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE release_batches (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
    CREATE TABLE implementation_records (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE settlements (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      r2_key TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      actor_member_id TEXT NOT NULL,
      action TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE idempotency_records (
      idempotency_key TEXT PRIMARY KEY,
      actor_member_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return { sqlite, database, repository: new SqlAttachmentRepository(database) };
}

test('attachment repository resolves project ownership without leaking runtime-specific database APIs', async () => {
  const { sqlite, database, repository } = createRepository();
  try {
    await database.batch([
      { sql: 'INSERT INTO projects (id) VALUES (?)', params: ['project-1'] },
      { sql: 'INSERT INTO release_batches (id,project_id) VALUES (?,?)', params: ['release-1', 'project-1'] },
      { sql: 'INSERT INTO implementation_records (id,project_id) VALUES (?,?)', params: ['implementation-1', 'project-1'] },
      { sql: 'INSERT INTO implementation_records (id,project_id) VALUES (?,NULL)', params: ['implementation-unlinked'] },
      { sql: 'INSERT INTO settlements (id,project_id) VALUES (?,?)', params: ['settlement-1', 'project-1'] },
    ]);

    assert.equal(await repository.resolveObjectProject('project', 'project-1'), 'project-1');
    assert.equal(await repository.resolveObjectProject('release', 'release-1'), 'project-1');
    assert.equal(await repository.resolveObjectProject('implementation', 'implementation-1'), 'project-1');
    assert.equal(await repository.resolveObjectProject('implementation', 'implementation-unlinked'), null);
    assert.equal(await repository.resolveObjectProject('settlement', 'settlement-1'), 'project-1');
    assert.equal(await repository.resolveObjectProject('project', 'missing'), null);
  } finally {
    sqlite.close();
  }
});

test('attachment repository writes metadata, audit and idempotency atomically and reads portable records', async () => {
  const { sqlite, database, repository } = createRepository();
  const record = {
    id: 'attachment-1',
    projectId: 'project-1',
    objectType: 'project',
    objectId: 'project-1',
    storageKey: 'attachments/project-1/attachment-1',
    fileName: 'proof.txt',
    contentType: 'text/plain',
    sizeBytes: 5,
    createdAt: '2026-09-14T00:00:00.000Z',
  };
  try {
    await database.run({ sql: 'INSERT INTO projects (id) VALUES (?)', params: ['project-1'] });
    await repository.create({
      record,
      uploadedBy: 'member-1',
      auditEventId: 'audit-1',
      idempotency: {
        key: 'idem-1',
        actorId: 'member-1',
        operation: 'attachments.create',
        requestHash: 'hash-1',
        responseJson: JSON.stringify({ ok: true, data: { id: record.id } }),
        statusCode: 201,
        createdAt: record.createdAt,
      },
    });

    assert.deepEqual(await repository.findById(record.id), record);
    assert.deepEqual(await repository.listByObject('project', 'project-1', 100), [record]);
    assert.equal((await database.first({ sql: 'SELECT action FROM audit_events WHERE id=?', params: ['audit-1'] })).action, 'attachment.create');
    assert.equal((await database.first({ sql: 'SELECT operation FROM idempotency_records WHERE idempotency_key=?', params: ['idem-1'] })).operation, 'attachments.create');

    await assert.rejects(repository.create({
      record: { ...record, id: 'attachment-2', storageKey: 'attachments/project-1/attachment-2' },
      uploadedBy: 'member-1',
      auditEventId: 'audit-2',
      idempotency: {
        key: 'idem-1',
        actorId: 'member-1',
        operation: 'attachments.create',
        requestHash: 'hash-2',
        responseJson: '{}',
        statusCode: 201,
        createdAt: record.createdAt,
      },
    }));
    assert.equal(await repository.findById('attachment-2'), null);
    assert.equal(await database.first({ sql: 'SELECT id FROM audit_events WHERE id=?', params: ['audit-2'] }), null);
  } finally {
    sqlite.close();
  }
});
