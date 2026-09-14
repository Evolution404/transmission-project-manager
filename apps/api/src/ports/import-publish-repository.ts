import type { ImportBatchSummary, NormalizedImportRow } from '@tpm/shared';
import type { ImportValidationRow } from './import-validation-repository.ts';

export interface ExistingDemandBySource {
  sourceKey: string;
  demandId: string;
}

export interface ExistingDemandBySignature {
  businessSignature: string;
  demandId: string;
}

export interface PublishImportRow {
  rowId: string;
  demandId: string;
  createDemand: boolean;
  sourceRowId: string;
  materialRowId: string;
  sourceKey: string;
  sheetName: string;
  rowNumber: number;
  rawJson: string;
  normalized: NormalizedImportRow;
}

export interface CommitImportPublishInput {
  batchId: string;
  expectedVersion: number;
  actorId: string;
  now: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
  fileName: string;
  fileSha256: string;
  nextStatus: ImportBatchSummary['status'];
  publishedRows: number;
  publishedAt: string | null;
  auditId: string;
  beforePublishedRows: number;
  rows: PublishImportRow[];
}

export interface ImportPublishRepository {
  listValidRows(batchId: string, limit: number): Promise<readonly ImportValidationRow[]>;
  findDemandIdsBySourceKeys(sourceKeys: readonly string[]): Promise<readonly ExistingDemandBySource[]>;
  findImportDemandIdsBySignatures(batchId: string, signatures: readonly string[]): Promise<readonly ExistingDemandBySignature[]>;
  commitPublish(input: CommitImportPublishInput): Promise<void>;
}
