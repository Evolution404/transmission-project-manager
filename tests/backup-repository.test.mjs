import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';
import { SqlBackupRepository } from '../apps/api/src/repositories/sql-backup-repository.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE backup_runs (id TEXT PRIMARY KEY,backup_date TEXT,kind TEXT,status TEXT,current_table_index INTEGER,cursor_rowid INTEGER,manifest_key TEXT,chunk_count INTEGER,error TEXT,started_at TEXT,completed_at TEXT,verified_at TEXT,created_at TEXT,updated_at TEXT,UNIQUE(backup_date,kind));
    CREATE TABLE backup_chunks (id TEXT PRIMARY KEY,backup_run_id TEXT,table_name TEXT,chunk_index INTEGER,r2_key TEXT,row_count INTEGER,sha256 TEXT,created_at TEXT,UNIQUE(backup_run_id,table_name,chunk_index));
    CREATE TABLE attachments (id TEXT PRIMARY KEY,r2_key TEXT,deleted_at TEXT);
    CREATE TABLE members (id TEXT PRIMARY KEY,name TEXT);
    INSERT INTO members VALUES ('m1','Alice'),('m2','Bob');
    INSERT INTO attachments VALUES ('a1','attachments/a1',NULL);
  `);
  return { sqlite, repository: new SqlBackupRepository(new SqliteDatabaseAdapter(sqlite)) };
}

test('backup repository runs cursor and chunk metadata flow on SQLite', async () => {
  const { sqlite, repository } = fixture();
  try {
    const now = '2026-09-14T00:00:00.000Z';
    const ensured = await repository.ensure('2026-09-14','daily',now);
    assert.equal(ensured.created, true);
    assert.equal((await repository.ensure('2026-09-14','daily',now)).created, false);
    const rows = await repository.readTableRows('members',0,100);
    assert.equal(rows.length,2);
    assert.ok(rows[0].__rowid > 0);
    await repository.recordChunk({ backupId:ensured.backup.id,table:'members',chunkIndex:0,objectKey:'backups/chunk.json',rowCount:2,sha256:'abc',nextTableIndex:1,nextCursorRowid:0,startedAt:now,now });
    assert.equal((await repository.find(ensured.backup.id)).chunkCount,1);
    assert.equal((await repository.listChunks(ensured.backup.id))[0].objectKey,'backups/chunk.json');
    assert.deepEqual(await repository.listAttachmentKeys(),['attachments/a1']);
    await repository.markCompleted(ensured.backup.id,'backups/manifest.json',now);
    assert.equal((await repository.find(ensured.backup.id)).status,'completed');
    await repository.markVerified(ensured.backup.id,now);
    assert.equal((await repository.find(ensured.backup.id)).verifiedAt,now);
  } finally { sqlite.close(); }
});

test('backup repository rejects dynamic tables outside the fixed whitelist', async () => {
  const { sqlite, repository } = fixture();
  try {
    await assert.rejects(repository.readTableRows('sqlite_master',0,10), /unsupported backup table/);
  } finally { sqlite.close(); }
});
