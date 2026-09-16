import type { DemandLocationType } from './master-data.ts';

export type ImportFileType = 'xlsx' | 'csv';
export type ImportBatchStatus = 'draft' | 'validating' | 'review' | 'ready' | 'publishing' | 'published';

export interface ImportFieldMapping {
  sequenceNo: string;
  voltage: string;
  lineName: string;
  section: string;
  materialModel: string;
  materialQuantity: string;
  unit?: string;
  year?: string;
  category?: string;
  owner?: string;
}

export interface ParsedImportRow {
  sheetName: string;
  rowNumber: number;
  cells: Record<string, string | number | boolean | null>;
}

export interface ImportIssue {
  code: string;
  message: string;
  field?: string;
}

export interface NormalizedImportRow {
  sequenceNo: string;
  voltageRaw: string;
  voltageVerified: string | null;
  voltageLevelId: string | null;
  lineName: string;
  lineId: string | null;
  section: string;
  locationType: DemandLocationType | null;
  startTowerPositionId: string | null;
  endTowerPositionId: string | null;
  materialModel: string;
  quantityScaled: number | null;
  unit: string | null;
  year: number | null;
  category: string | null;
  owner: string | null;
  materialId: string | null;
  businessSignature: string | null;
}

export interface ImportRowSummary {
  id: string;
  sheetName: string;
  rowNumber: number;
  status: 'uploaded' | 'valid' | 'error' | 'published';
  normalized: NormalizedImportRow | null;
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

export interface ImportBatchSummary {
  id: string;
  fileName: string;
  fileSha256: string;
  fileType: ImportFileType;
  mapping: ImportFieldMapping;
  status: ImportBatchStatus;
  uploadedRows: number;
  validRows: number;
  errorRows: number;
  warningRows: number;
  publishedRows: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  reused?: boolean;
}

export interface ImportChunkRequest {
  expectedVersion: number;
  chunkIndex: number;
  rows: ParsedImportRow[];
}

export interface ImportChunkResult {
  uploadedRows: number;
  chunkIndex: number;
  version: number;
}

export interface ImportValidateRequest {
  expectedVersion: number;
}

export interface ImportPublishRequest {
  expectedVersion: number;
  limit?: number;
}

export interface ImportPublishResult {
  processed: number;
  publishedRows: number;
  done: boolean;
  version: number;
}

export interface ImportMappingTemplate {
  id: string;
  name: string;
  mapping: ImportFieldMapping;
  version: number;
  createdAt: string;
  updatedAt: string;
}
