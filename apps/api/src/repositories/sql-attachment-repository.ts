import type { AttachmentObjectType, AttachmentRecord, AttachmentRepository, CreateAttachmentRecord } from '../ports/attachment-repository.ts';
import type { DatabasePort } from '../ports/database.ts';

type AttachmentRow = {
  id: string;
  project_id: string;
  object_type: AttachmentObjectType;
  object_id: string;
  r2_key: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
};

function toRecord(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    objectType: row.object_type,
    objectId: row.object_id,
    storageKey: row.r2_key,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}

function auditSummary(record: AttachmentRecord) {
  return {
    id: record.id,
    projectId: record.projectId,
    objectType: record.objectType,
    objectId: record.objectId,
    fileName: record.fileName,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt,
  };
}

const attachmentColumns = 'id,project_id,object_type,object_id,r2_key,file_name,content_type,size_bytes,created_at';

export class SqlAttachmentRepository implements AttachmentRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async resolveObjectProject(objectType: AttachmentObjectType, objectId: string): Promise<string | null> {
    if (objectType === 'project') {
      const row = await this.database.first<{ id: string }>({
        sql: 'SELECT id FROM projects WHERE id=? LIMIT 1',
        params: [objectId],
      });
      return row?.id ?? null;
    }
    const table = objectType === 'release'
      ? 'release_batches'
      : objectType === 'implementation'
        ? 'implementation_records'
        : 'settlements';
    const projectConstraint = objectType === 'implementation' ? ' AND project_id IS NOT NULL' : '';
    const row = await this.database.first<{ project_id: string }>({
      sql: `SELECT project_id FROM ${table} WHERE id=?${projectConstraint} LIMIT 1`,
      params: [objectId],
    });
    return row?.project_id ?? null;
  }

  async create(input: CreateAttachmentRecord): Promise<void> {
    const { record, uploadedBy, auditEventId, idempotency } = input;
    const afterJson = JSON.stringify(auditSummary(record));
    await this.database.batch([
      {
        sql: 'INSERT INTO attachments (id,project_id,object_type,object_id,r2_key,file_name,content_type,size_bytes,uploaded_by,created_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)',
        params: [record.id, record.projectId, record.objectType, record.objectId, record.storageKey, record.fileName, record.contentType, record.sizeBytes, uploadedBy, record.createdAt],
      },
      {
        sql: 'INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?)',
        params: [auditEventId, idempotency.actorId, 'attachment.create', 'attachment', record.id, null, afterJson, record.createdAt],
      },
      {
        sql: 'INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at) VALUES (?,?,?,?,?,?,?)',
        params: [idempotency.key, idempotency.actorId, idempotency.operation, idempotency.requestHash, idempotency.responseJson, idempotency.statusCode, idempotency.createdAt],
      },
    ]);
  }

  async listByObject(objectType: AttachmentObjectType, objectId: string, limit: number): Promise<readonly AttachmentRecord[]> {
    const rows = await this.database.all<AttachmentRow>({
      sql: `SELECT ${attachmentColumns} FROM attachments WHERE object_type=? AND object_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT ?`,
      params: [objectType, objectId, limit],
    });
    return rows.map(toRecord);
  }

  async findById(id: string): Promise<AttachmentRecord | null> {
    const row = await this.database.first<AttachmentRow>({
      sql: `SELECT ${attachmentColumns} FROM attachments WHERE id=? AND deleted_at IS NULL LIMIT 1`,
      params: [id],
    });
    return row ? toRecord(row) : null;
  }
}
