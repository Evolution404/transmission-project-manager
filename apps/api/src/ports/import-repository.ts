import type { ImportBatchSummary } from '@tpm/shared';

export interface CreateImportBatchRecord {
  batch: ImportBatchSummary;
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
}

export interface RecordImportReuseInput {
  idempotencyKey: string;
  actorId: string;
  operation: string;
  requestHash: string;
  responseJson: string;
  now: string;
}

export interface ImportChunkWriteRow {
  id: string;
  sheetName: string;
  rowNumber: number;
  sourceKey: string;
  rawJson: string;
}

export interface UploadImportChunkInput {
  batchId: string;
  expectedVersion: number;
  chunkIndex: number;
  actorId: string;
  now: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
  rows: ImportChunkWriteRow[];
}

export interface ImportRepository {
  findById(id: string): Promise<ImportBatchSummary | null>;
  findByFileHash(fileSha256: string): Promise<ImportBatchSummary | null>;
  create(input: CreateImportBatchRecord): Promise<void>;
  recordReuse(input: RecordImportReuseInput): Promise<void>;
  uploadChunk(input: UploadImportChunkInput): Promise<void>;
}
