import type { ImportBatchSummary, ImportIssue, ImportRowSummary, NormalizedImportRow } from '@tpm/shared';

export interface ImportValidationRow {
  id: string;
  batchId: string;
  chunkIndex: number;
  sheetName: string;
  rowNumber: number;
  sourceKey: string;
  rawJson: string;
  normalizedJson: string | null;
  errorsJson: string;
  warningsJson: string;
  status: ImportRowSummary['status'];
  publishedDemandId: string | null;
}

export interface ImportVoltageLookup { id: string; displayName: string }
export interface ImportLineLookup { id: string; lineName: string }
export interface ImportTowerLookup { id: string; towerNo: string; sortIndex: number }
export interface ImportMaterialLookup { id: string; model: string; unit: string }

export interface CommitValidationRow {
  id: string;
  normalizedJson: string;
  errorsJson: string;
  warningsJson: string;
  status: 'valid' | 'error';
}

export interface CommitImportValidationInput {
  batchId: string;
  expectedVersion: number;
  actorId: string;
  now: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
  nextStatus: ImportBatchSummary['status'];
  validRows: number;
  errorRows: number;
  warningRows: number;
  rows: CommitValidationRow[];
}

export interface ImportValidationRepository {
  listUploadedRows(batchId: string, limit: number): Promise<readonly ImportValidationRow[]>;
  findVoltageByName(displayName: string): Promise<ImportVoltageLookup | null>;
  findLineByName(voltageLevelId: string, lineName: string): Promise<ImportLineLookup | null>;
  findTowersByNumbers(lineId: string, towerNos: readonly string[]): Promise<readonly ImportTowerLookup[]>;
  findMaterials(pairs: readonly { model: string; unit: string }[]): Promise<readonly ImportMaterialLookup[]>;
  findExistingBusinessSignatures(signatures: readonly string[]): Promise<readonly string[]>;
  commitValidation(input: CommitImportValidationInput): Promise<void>;
}
