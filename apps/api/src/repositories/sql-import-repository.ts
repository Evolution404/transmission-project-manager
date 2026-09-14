import type { ImportBatchSummary, ImportFieldMapping } from '@tpm/shared';
import type { DatabasePort } from '../ports/database.ts';
import type { CreateImportBatchRecord, ImportRepository, RecordImportReuseInput } from '../ports/import-repository.ts';

type ImportBatchRow = {
  id: string;
  file_name: string;
  file_sha256: string;
  file_type: ImportBatchSummary['fileType'];
  mapping_json: string;
  status: ImportBatchSummary['status'];
  uploaded_rows: number;
  valid_rows: number;
  error_rows: number;
  warning_rows: number;
  published_rows: number;
  version: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
};

const batchSelect = `id,file_name,file_sha256,file_type,mapping_json,status,uploaded_rows,valid_rows,error_rows,
  warning_rows,published_rows,version,created_at,updated_at,published_at`;

function parseMapping(value: string): ImportFieldMapping {
  return JSON.parse(value) as ImportFieldMapping;
}

function summary(row: ImportBatchRow): ImportBatchSummary {
  return {
    id: row.id,
    fileName: row.file_name,
    fileSha256: row.file_sha256,
    fileType: row.file_type,
    mapping: parseMapping(row.mapping_json),
    status: row.status,
    uploadedRows: row.uploaded_rows,
    validRows: row.valid_rows,
    errorRows: row.error_rows,
    warningRows: row.warning_rows,
    publishedRows: row.published_rows,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

export class SqlImportRepository implements ImportRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async findById(id: string): Promise<ImportBatchSummary | null> {
    const row = await this.database.first<ImportBatchRow>({
      sql: `SELECT ${batchSelect} FROM import_batches WHERE id=? LIMIT 1`,
      params: [id],
    });
    return row ? summary(row) : null;
  }

  async findByFileHash(fileSha256: string): Promise<ImportBatchSummary | null> {
    const row = await this.database.first<ImportBatchRow>({
      sql: `SELECT ${batchSelect} FROM import_batches WHERE file_sha256=? LIMIT 1`,
      params: [fileSha256],
    });
    return row ? summary(row) : null;
  }

  async create(input: CreateImportBatchRecord): Promise<void> {
    const item = input.batch;
    await this.database.batch([
      {
        sql: `INSERT INTO import_batches
              (id,file_name,file_sha256,file_type,mapping_json,status,uploaded_rows,valid_rows,error_rows,warning_rows,
               published_rows,version,created_by,created_at,updated_at,published_at)
              VALUES (?,?,?,?,?,'draft',0,0,0,0,0,1,?,?,?,NULL)`,
        params: [item.id, item.fileName, item.fileSha256, item.fileType, JSON.stringify(item.mapping), input.actorId, item.createdAt, item.updatedAt],
      },
      {
        sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
              VALUES (?,?,'import.create','import_batch',?,NULL,?,?)`,
        params: [input.auditId, input.actorId, item.id, JSON.stringify(item), item.createdAt],
      },
      {
        sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
              VALUES (?,?,?,?,?,201,?)`,
        params: [input.idempotencyKey, input.actorId, input.operation, input.requestHash, input.responseJson, item.createdAt],
      },
    ]);
  }

  async recordReuse(input: RecordImportReuseInput): Promise<void> {
    await this.database.run({
      sql: `INSERT INTO idempotency_records
            (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (?,?,?,?,?,200,?)`,
      params: [input.idempotencyKey, input.actorId, input.operation, input.requestHash, input.responseJson, input.now],
    });
  }
}
