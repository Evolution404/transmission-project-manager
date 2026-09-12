import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportFieldMapping, ParsedImportRow } from '@tpm/shared';
import { ImportReviewRequiredError, executeImportWorkflow, flattenParsedSheets } from '../src/imports/workflow';
import type { ParsedSpreadsheet } from '../src/imports/parser';

const mapping: ImportFieldMapping = {
  sequenceNo: '序号', voltage: '电压等级', lineName: '线路名称', section: '杆段',
  materialModel: '物资型号', materialQuantity: '物资数量', unit: '单位',
};

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: status < 400, ...(status < 400 ? { data } : { error: data }) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('P2 browser import workflow', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('flattens worksheets while preserving sheet names and source row numbers', () => {
    const parsed: ParsedSpreadsheet = {
      fileType: 'xlsx',
      sheets: [
        { name: 'A', headers: ['序号'], rows: [{ rowNumber: 2, cells: { 序号: 1 } }] },
        { name: 'B', headers: ['序号'], rows: [{ rowNumber: 5, cells: { 序号: 2 } }] },
      ],
    };
    expect(flattenParsedSheets(parsed)).toEqual<ParsedImportRow[]>([
      { sheetName: 'A', rowNumber: 2, cells: { 序号: 1 } },
      { sheetName: 'B', rowNumber: 5, cells: { 序号: 2 } },
    ]);
  });

  it('uploads max 20 rows per chunk and loops validation/publish until done', async () => {
    const rows: ParsedImportRow[] = Array.from({ length: 45 }, (_, index) => ({
      sheetName: '需求', rowNumber: index + 2, cells: { 序号: index + 1 },
    }));
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    let validationCalls = 0;
    let publishCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, method, body });
      if (url === '/api/imports') return response({ id: 'batch-1', status: 'draft', reused: false, version: 1 });
      if (url.endsWith('/chunks')) {
        const expectedVersion = Number(body.expectedVersion);
        return response({ uploadedRows: rows.length, chunkIndex: body.chunkIndex, version: expectedVersion + 1 });
      }
      if (url.endsWith('/validate')) {
        validationCalls += 1;
        const expectedVersion = Number(body.expectedVersion);
        return response({
          id: 'batch-1',
          status: validationCalls < 3 ? 'validating' : 'ready',
          done: validationCalls >= 3,
          errorRows: 0,
          version: expectedVersion + 1,
        });
      }
      if (url.endsWith('/publish')) {
        publishCalls += 1;
        const expectedVersion = Number(body.expectedVersion);
        return response({
          processed: publishCalls < 5 ? 10 : 5,
          publishedRows: Math.min(publishCalls * 10, 45),
          done: publishCalls >= 5,
          version: expectedVersion + 1,
        });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(() => `id-${requests.length + 1}`),
      subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) },
    });

    const result = await executeImportWorkflow({
      fileName: '需求.xlsx',
      fileType: 'xlsx',
      fileSha256: 'a'.repeat(64),
      mapping,
      rows,
    });

    const chunks = requests.filter((request) => request.url.endsWith('/chunks'));
    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => (chunk.body as { rows: unknown[] }).rows.length)).toEqual([20, 20, 5]);
    expect(chunks.map((chunk) => (chunk.body as { chunkIndex: number }).chunkIndex)).toEqual([0, 1, 2]);
    expect(chunks.map((chunk) => (chunk.body as { expectedVersion: number }).expectedVersion)).toEqual([1, 2, 3]);
    const validations = requests.filter((request) => request.url.endsWith('/validate'));
    expect(validations.map((request) => (request.body as { expectedVersion: number }).expectedVersion)).toEqual([4, 5, 6]);
    const publishes = requests.filter((request) => request.url.endsWith('/publish'));
    expect(publishes.map((request) => (request.body as { expectedVersion: number }).expectedVersion)).toEqual([7, 8, 9, 10, 11]);
    expect(validationCalls).toBe(3);
    expect(publishCalls).toBe(5);
    expect(result.publishedRows).toBe(45);
    expect(result.done).toBe(true);
  });

  it('stops before publishing when server validation reports review/errors', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (url === '/api/imports') return response({ id: 'batch-review', status: 'draft', version: 1 });
      if (url.endsWith('/chunks')) return response({ uploadedRows: 1, chunkIndex: body.chunkIndex, version: Number(body.expectedVersion) + 1 });
      if (url.endsWith('/validate')) return response({ id: 'batch-review', status: 'review', done: true, errorRows: 1, version: Number(body.expectedVersion) + 1 });
      throw new Error(`publish must not be called for invalid batch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', { randomUUID: () => 'id', subtle: { digest: vi.fn() } });

    try {
      await executeImportWorkflow({
        fileName: '错误.xlsx', fileType: 'xlsx', fileSha256: 'b'.repeat(64), mapping,
        rows: [{ sheetName: '需求', rowNumber: 2, cells: { 序号: 1 } }],
      });
      throw new Error('workflow should require review');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ImportReviewRequiredError);
      expect((cause as ImportReviewRequiredError).batchId).toBe('batch-review');
      expect((cause as ImportReviewRequiredError).errorRows).toBe(1);
    }
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/publish'))).toBe(false);
  });
});
