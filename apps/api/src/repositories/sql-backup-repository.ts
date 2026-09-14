import type { BackupKind, BackupSummary } from '@tpm/shared';
import type { DatabasePort, DatabaseValue } from '../ports/database';
import { BACKUP_TABLES, type BackupChunkState, type BackupRepository, type BackupRetentionCandidate, type BackupTableName, type BackupTableRow } from '../ports/backup-repository.ts';

const allowedTables = new Set<string>(BACKUP_TABLES);

function backup(row: {
  id: string; backup_date: string; kind: BackupKind; status: BackupSummary['status']; current_table_index: number; cursor_rowid: number; manifest_key: string | null; chunk_count: number; error: string | null; started_at: string | null; completed_at: string | null; verified_at: string | null; created_at: string; updated_at: string;
}): BackupSummary {
  return { id: row.id, backupDate: row.backup_date, kind: row.kind, status: row.status, currentTableIndex: row.current_table_index, cursorRowid: row.cursor_rowid, manifestKey: row.manifest_key, chunkCount: row.chunk_count, error: row.error, startedAt: row.started_at, completedAt: row.completed_at, verifiedAt: row.verified_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

const backupSelect = `id,backup_date,kind,status,current_table_index,cursor_rowid,manifest_key,chunk_count,error,started_at,completed_at,verified_at,created_at,updated_at`;

export class SqlBackupRepository implements BackupRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) { this.database = database; }

  async ensure(backupDate: string, kind: BackupKind, now: string): Promise<{ created: boolean; backup: BackupSummary }> {
    const existing = await this.database.first<any>({ sql: `SELECT ${backupSelect} FROM backup_runs WHERE backup_date=? AND kind=? LIMIT 1`, params: [backupDate, kind] });
    if (existing) return { created: false, backup: backup(existing) };
    const id = crypto.randomUUID();
    try {
      await this.database.run({ sql: `INSERT INTO backup_runs (id,backup_date,kind,status,current_table_index,cursor_rowid,manifest_key,chunk_count,error,started_at,completed_at,verified_at,created_at,updated_at) VALUES (?,?,?,'pending',0,0,NULL,0,NULL,NULL,NULL,NULL,?,?)`, params: [id, backupDate, kind, now, now] });
      const created = await this.find(id);
      if (!created) throw new Error('backup creation disappeared');
      return { created: true, backup: created };
    } catch (error) {
      const winner = await this.database.first<any>({ sql: `SELECT ${backupSelect} FROM backup_runs WHERE backup_date=? AND kind=? LIMIT 1`, params: [backupDate, kind] });
      if (winner) return { created: false, backup: backup(winner) };
      throw error;
    }
  }

  async find(id: string): Promise<BackupSummary | null> {
    const row = await this.database.first<any>({ sql: `SELECT ${backupSelect} FROM backup_runs WHERE id=? LIMIT 1`, params: [id] });
    return row ? backup(row) : null;
  }

  async list(limit: number): Promise<readonly BackupSummary[]> {
    const rows = await this.database.all<any>({ sql: `SELECT ${backupSelect} FROM backup_runs ORDER BY backup_date DESC,kind,id DESC LIMIT ?`, params: [limit] });
    return rows.map(backup);
  }

  async listChunks(backupRunId: string): Promise<readonly BackupChunkState[]> {
    const rows = await this.database.all<{ id: string; backup_run_id: string; table_name: string; chunk_index: number; r2_key: string; row_count: number; sha256: string; created_at: string }>({ sql: `SELECT id,backup_run_id,table_name,chunk_index,r2_key,row_count,sha256,created_at FROM backup_chunks WHERE backup_run_id=? ORDER BY table_name,chunk_index`, params: [backupRunId] });
    return rows.map((row) => ({ id: row.id, backupRunId: row.backup_run_id, tableName: row.table_name as BackupTableName, chunkIndex: row.chunk_index, objectKey: row.r2_key, rowCount: row.row_count, sha256: row.sha256, createdAt: row.created_at }));
  }

  async listAttachmentKeys(): Promise<readonly string[]> {
    const rows = await this.database.all<{ r2_key: string }>({ sql: `SELECT r2_key FROM attachments WHERE deleted_at IS NULL ORDER BY r2_key` });
    return rows.map((row) => row.r2_key);
  }

  async readTableRows(table: BackupTableName, afterRowid: number, limit: number): Promise<readonly BackupTableRow[]> {
    if (!allowedTables.has(table)) throw new Error(`unsupported backup table: ${table}`);
    const rows = await this.database.all<Record<string, unknown>>({ sql: `SELECT rowid AS __rowid,* FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`, params: [afterRowid, limit] });
    return rows.map((row) => {
      const value = row.__rowid;
      if (typeof value !== 'number') throw new Error(`invalid rowid for ${table}`);
      return row as BackupTableRow;
    });
  }

  async advanceEmptyTable(backupId: string, startedAt: string, now: string): Promise<void> {
    await this.database.run({ sql: `UPDATE backup_runs SET status='running',current_table_index=current_table_index+1,cursor_rowid=0,started_at=?,updated_at=? WHERE id=?`, params: [startedAt, now, backupId] });
  }

  async nextChunkIndex(backupId: string, table: BackupTableName): Promise<number> {
    const row = await this.database.first<{ next_index: number | string }>({ sql: `SELECT COALESCE(MAX(chunk_index),-1)+1 AS next_index FROM backup_chunks WHERE backup_run_id=? AND table_name=?`, params: [backupId, table] });
    return Number(row?.next_index ?? 0);
  }

  async recordChunk(input: { backupId: string; table: BackupTableName; chunkIndex: number; objectKey: string; rowCount: number; sha256: string; nextTableIndex: number; nextCursorRowid: number; startedAt: string; now: string }): Promise<void> {
    await this.database.batch([
      { sql: `INSERT INTO backup_chunks (id,backup_run_id,table_name,chunk_index,r2_key,row_count,sha256,created_at) VALUES (?,?,?,?,?,?,?,?)`, params: [crypto.randomUUID(), input.backupId, input.table, input.chunkIndex, input.objectKey, input.rowCount, input.sha256, input.now] },
      { sql: `UPDATE backup_runs SET status='running',current_table_index=?,cursor_rowid=?,chunk_count=chunk_count+1,started_at=?,updated_at=? WHERE id=?`, params: [input.nextTableIndex, input.nextCursorRowid, input.startedAt, input.now, input.backupId] },
    ]);
  }

  async markCompleted(backupId: string, manifestKey: string, now: string): Promise<void> {
    await this.database.run({ sql: `UPDATE backup_runs SET status='completed',manifest_key=?,completed_at=?,updated_at=? WHERE id=?`, params: [manifestKey, now, now, backupId] });
  }

  async markFailed(backupId: string, error: string, now: string): Promise<void> {
    await this.database.run({ sql: `UPDATE backup_runs SET status='failed',error=?,updated_at=? WHERE id=?`, params: [error, now, backupId] });
  }

  async markVerified(backupId: string, now: string): Promise<void> {
    await this.database.run({ sql: `UPDATE backup_runs SET verified_at=?,updated_at=? WHERE id=?`, params: [now, now, backupId] });
  }

  async retentionCandidates(kind: BackupKind, keep: number): Promise<readonly BackupRetentionCandidate[]> {
    const rows = await this.database.all<{ id: string; manifest_key: string | null }>({ sql: `SELECT id,manifest_key FROM backup_runs WHERE kind=? AND status='completed' ORDER BY backup_date DESC,completed_at DESC LIMIT 100 OFFSET ?`, params: [kind, keep] });
    return rows.map((row) => ({ id: row.id, manifestKey: row.manifest_key }));
  }

  async chunkObjectKeys(backupId: string): Promise<readonly string[]> {
    const rows = await this.database.all<{ r2_key: string }>({ sql: `SELECT r2_key FROM backup_chunks WHERE backup_run_id=?`, params: [backupId] });
    return rows.map((row) => row.r2_key);
  }

  async deleteRun(backupId: string): Promise<void> {
    await this.database.run({ sql: `DELETE FROM backup_runs WHERE id=?`, params: [backupId] });
  }

  async findPending(): Promise<string | null> {
    const row = await this.database.first<{ id: string }>({ sql: `SELECT id FROM backup_runs WHERE status IN ('pending','running') ORDER BY backup_date,kind,id LIMIT 1` });
    return row?.id ?? null;
  }
}
