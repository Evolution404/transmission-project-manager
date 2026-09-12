import type {
  ApiResponse,
  ImportBatchStatus,
  ImportChunkResult,
  ImportFieldMapping,
  ImportFileType,
  ImportPublishResult,
  ParsedImportRow,
} from '@tpm/shared';
import { parseApiResponse } from '../api/response';
import type { ParsedSpreadsheet } from './parser';

const CHUNK_SIZE = 20;

type ProgressStage = 'creating' | 'uploading' | 'validating' | 'publishing' | 'done';

export interface ImportWorkflowProgress {
  stage: ProgressStage;
  current: number;
  total: number;
  message: string;
}

export interface ImportWorkflowInput {
  fileName: string;
  fileType: ImportFileType;
  fileSha256: string;
  mapping: ImportFieldMapping;
  rows: ParsedImportRow[];
  onProgress?: (progress: ImportWorkflowProgress) => void;
}

interface BatchState {
  id: string;
  status: ImportBatchStatus;
  version: number;
  uploadedRows?: number;
  validRows?: number;
  errorRows?: number;
  warningRows?: number;
  publishedRows?: number;
  reused?: boolean;
  done?: boolean;
}

type PublishState = ImportPublishResult;

export class ImportReviewRequiredError extends Error {
  readonly batchId: string;
  readonly errorRows: number;
  readonly warningRows: number;

  constructor(batchId: string, errorRows: number, warningRows: number) {
    super(`IMPORT_REVIEW_REQUIRED: ${errorRows} 行存在阻断错误，请处理后再发布`);
    this.name = 'ImportReviewRequiredError';
    this.batchId = batchId;
    this.errorRows = errorRows;
    this.warningRows = warningRows;
  }
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = await parseApiResponse<T>(response);
  if (!response.ok || !result.ok) {
    const code = result.ok ? 'HTTP_ERROR' : result.error.code;
    const message = result.ok ? `HTTP ${response.status}` : result.error.message;
    throw new Error(`${code}: ${message}`);
  }
  return result.data;
}

function mutation(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  };
}

export function flattenParsedSheets(parsed: ParsedSpreadsheet): ParsedImportRow[] {
  return parsed.sheets.flatMap((sheet) => sheet.rows.map((row) => ({
    sheetName: sheet.name,
    rowNumber: row.rowNumber,
    cells: row.cells,
  })));
}

export async function sha256File(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function executeImportWorkflow(input: ImportWorkflowInput): Promise<PublishState> {
  const progress = input.onProgress ?? (() => {});
  progress({ stage: 'creating', current: 0, total: input.rows.length, message: '创建或恢复导入批次' });

  let batch = await apiRequest<BatchState>('/api/imports', mutation({
    fileName: input.fileName,
    fileSha256: input.fileSha256,
    fileType: input.fileType,
    mapping: input.mapping,
  }));

  if (batch.status === 'published') {
    const result: PublishState = {
      processed: 0,
      publishedRows: batch.publishedRows ?? input.rows.length,
      done: true,
      version: batch.version,
    };
    progress({ stage: 'done', current: result.publishedRows, total: input.rows.length, message: '该文件已完成发布' });
    return result;
  }

  if (batch.status === 'draft') {
    const uploadedRows = Math.min(batch.uploadedRows ?? 0, input.rows.length);
    const remaining = input.rows.slice(uploadedRows);
    let sent = uploadedRows;
    for (let offset = 0; offset < remaining.length; offset += CHUNK_SIZE) {
      const chunkRows = remaining.slice(offset, offset + CHUNK_SIZE);
      const chunkIndex = Math.floor((uploadedRows + offset) / CHUNK_SIZE);
      const uploaded = await apiRequest<ImportChunkResult>(`/api/imports/${batch.id}/chunks`, mutation({
        expectedVersion: batch.version,
        chunkIndex,
        rows: chunkRows,
      }));
      batch.version = uploaded.version;
      sent += chunkRows.length;
      progress({ stage: 'uploading', current: sent, total: input.rows.length, message: `已上传 ${sent}/${input.rows.length} 行` });
    }
  }

  if (batch.status === 'draft' || batch.status === 'validating') {
    let done = false;
    while (!done) {
      batch = await apiRequest<BatchState>(`/api/imports/${batch.id}/validate`, mutation({ expectedVersion: batch.version }));
      done = batch.done === true;
      progress({
        stage: 'validating',
        current: (batch.validRows ?? 0) + (batch.errorRows ?? 0),
        total: input.rows.length,
        message: done ? '校验完成' : '继续分批校验',
      });
    }
  }

  if (batch.status === 'review' || (batch.errorRows ?? 0) > 0) {
    throw new ImportReviewRequiredError(batch.id, batch.errorRows ?? 0, batch.warningRows ?? 0);
  }
  if (batch.status !== 'ready' && batch.status !== 'publishing') {
    throw new Error(`IMPORT_NOT_READY: 批次当前状态为 ${batch.status}`);
  }

  let last: PublishState = {
    processed: 0,
    publishedRows: batch.publishedRows ?? 0,
    done: false,
    version: batch.version,
  };
  while (!last.done) {
    last = await apiRequest<PublishState>(`/api/imports/${batch.id}/publish`, mutation({ expectedVersion: last.version, limit: 10 }));
    progress({
      stage: 'publishing',
      current: last.publishedRows,
      total: input.rows.length,
      message: last.done ? '发布完成' : `已发布 ${last.publishedRows}/${input.rows.length} 行`,
    });
  }

  progress({ stage: 'done', current: last.publishedRows, total: input.rows.length, message: '需求已发布到需求池' });
  return last;
}
