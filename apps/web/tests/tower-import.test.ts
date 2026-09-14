import { describe, expect, it } from 'vitest';
import type { TransmissionTowerSummary } from '@tpm/shared';
import {
  buildTowerImportPreview,
  parseTowerPaste,
  towerImportChunks,
  towerRowsFromSpreadsheet,
} from '../src/imports/towerImport';

const existing = (overrides: Partial<TransmissionTowerSummary> = {}): TransmissionTowerSummary => ({
  id: 'tower-10', lineId: 'line-1', lineName: '甲线', towerNo: '#010', sortRank: 1000,
  towerType: '角钢塔', enabled: true, version: 3, ...overrides,
});

describe('tower import parsing and preview', () => {
  it('accepts pasted business columns without exposing sort ranks', () => {
    expect(parseTowerPaste('杆塔编号\t杆塔类型\t状态\n10\t钢管杆\t启用\n10-1\t\t停用')).toEqual([
      { source: '粘贴', rowNumber: 2, towerNoInput: '10', towerType: '钢管杆', enabled: true, parseError: null },
      { source: '粘贴', rowNumber: 3, towerNoInput: '10-1', towerType: null, enabled: false, parseError: null },
    ]);
    expect(parseTowerPaste('11\t角钢塔\t启用')).toEqual([
      { source: '粘贴', rowNumber: 1, towerNoInput: '11', towerType: '角钢塔', enabled: true, parseError: null },
    ]);
  });

  it('reads spreadsheet aliases and preserves physical source rows', () => {
    expect(towerRowsFromSpreadsheet({
      fileType: 'xlsx',
      sheets: [{ name: '杆塔', headers: ['杆塔号', '类型', '启用状态'], rows: [
        { rowNumber: 5, cells: { 杆塔号: 9, 类型: '角钢塔', 启用状态: '启用' } },
        { rowNumber: 6, cells: { 杆塔号: '10-1', 类型: null, 启用状态: '0' } },
      ] }],
    })).toEqual([
      { source: '杆塔', rowNumber: 5, towerNoInput: '9', towerType: '角钢塔', enabled: true, parseError: null },
      { source: '杆塔', rowNumber: 6, towerNoInput: '10-1', towerType: null, enabled: false, parseError: null },
    ]);
  });

  it('keeps invalid status text as a blocking row error instead of silently enabling it', () => {
    const rows = parseTowerPaste('10\t角钢塔\t已拆除');
    const preview = buildTowerImportPreview(rows, []);
    expect(preview.counts.error).toBe(1);
    expect(preview.rows[0]?.message).toContain('状态');
  });

  it('classifies create/update/unchanged and blocks invalid, duplicate and ambiguous identities', () => {
    const preview = buildTowerImportPreview([
      { source: '粘贴', rowNumber: 1, towerNoInput: '10', towerType: '钢管杆', enabled: true },
      { source: '粘贴', rowNumber: 2, towerNoInput: '11', towerType: null, enabled: true },
      { source: '粘贴', rowNumber: 3, towerNoInput: '12', towerType: null, enabled: true },
      { source: '粘贴', rowNumber: 4, towerNoInput: '#012', towerType: null, enabled: true },
      { source: '粘贴', rowNumber: 5, towerNoInput: '10A', towerType: null, enabled: true },
      { source: '粘贴', rowNumber: 6, towerNoInput: '20', towerType: null, enabled: true },
      { source: '粘贴', rowNumber: 7, towerNoInput: '30', towerType: '角钢塔', enabled: true },
    ], [
      existing(),
      existing({ id: 'tower-20-a', towerNo: '#020' }),
      existing({ id: 'tower-20-b', towerNo: '#020', sortRank: 2000 }),
      existing({ id: 'tower-30', towerNo: '#030', sortRank: 3000 }),
    ]);

    expect(preview.counts).toEqual({ total: 7, create: 1, update: 1, unchanged: 1, error: 4 });
    expect(preview.rows.find((row) => row.rowNumber === 1)?.action).toBe('update');
    expect(preview.rows.find((row) => row.rowNumber === 7)?.action).toBe('unchanged');
    expect(preview.rows.find((row) => row.rowNumber === 2)?.action).toBe('create');
    expect(preview.rows.find((row) => row.rowNumber === 5)?.message).toContain('无法识别');
    expect(preview.rows.find((row) => row.rowNumber === 6)?.message).toContain('多个');
  });

  it('splits actionable rows into hidden safe chunks without a user-facing row cap', () => {
    const rows = Array.from({ length: 65 }, (_, index) => ({
      source: '粘贴', rowNumber: index + 1, towerNoInput: String(index + 1), towerType: null, enabled: true,
    }));
    const preview = buildTowerImportPreview(rows, []);
    expect(preview.counts).toEqual({ total: 65, create: 65, update: 0, unchanged: 0, error: 0 });
    expect(towerImportChunks(preview.rows).map((chunk) => chunk.length)).toEqual([20, 20, 20, 5]);
  });
});
