import { normalizeTowerNo, type LineTowerPositionSummary } from '@tpm/shared';
import type { ParsedSpreadsheet, ParsedSpreadsheetRow } from './parser';

export interface TowerImportSourceRow {
  source: string;
  rowNumber: number;
  towerNoInput: string;
  positionLabel: string | null;
  enabled: boolean;
  parseError?: string | null;
}

export type TowerImportAction = 'create' | 'update' | 'unchanged' | 'error';

export interface TowerImportPreviewRow extends TowerImportSourceRow {
  towerNo: string | null;
  action: TowerImportAction;
  message: string | null;
  id?: string;
  expectedVersion?: number;
}

export interface TowerImportPreview {
  counts: { total: number; create: number; update: number; unchanged: number; error: number };
  rows: TowerImportPreviewRow[];
}

const towerHeaders = ['杆塔编号', '杆塔号', '塔号'];
const positionHeaders = ['位置标识', '挂点', '同塔位置'];
const stateHeaders = ['状态', '启用状态', '是否启用'];

function clean(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function parseEnabled(value: unknown): { enabled: boolean; error: string | null } {
  const text = clean(value);
  if (!text || ['启用', '是', '1', 'true', 'TRUE'].includes(text)) return { enabled: true, error: null };
  if (['停用', '否', '0', 'false', 'FALSE'].includes(text)) return { enabled: false, error: null };
  return { enabled: true, error: `状态“${text}”无法识别，仅支持启用/停用` };
}

export function parseTowerPaste(text: string): TowerImportSourceRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const matrix = lines.map((line) => line.split('\t').map((cell) => cell.trim()));
  const first = matrix[0] ?? [];
  const hasHeader = first.some((cell) => towerHeaders.includes(cell));
  const towerColumn = hasHeader ? first.findIndex((cell) => towerHeaders.includes(cell)) : 0;
  const positionColumn = hasHeader ? first.findIndex((cell) => positionHeaders.includes(cell)) : 1;
  const stateColumn = hasHeader ? first.findIndex((cell) => stateHeaders.includes(cell)) : 2;
  return matrix.slice(hasHeader ? 1 : 0).map((cells, index) => {
    const state = parseEnabled(stateColumn >= 0 ? cells[stateColumn] : '');
    return {
      source: '粘贴',
      rowNumber: index + (hasHeader ? 2 : 1),
      towerNoInput: clean(cells[towerColumn]),
      positionLabel: positionColumn >= 0 ? clean(cells[positionColumn]) || null : null,
      enabled: state.enabled,
      parseError: state.error,
    };
  });
}

function columnName(headers: readonly string[], aliases: readonly string[]): string | null {
  return headers.find((header) => aliases.includes(header.trim())) ?? null;
}

function fromSpreadsheetRow(source: string, row: ParsedSpreadsheetRow, towerColumn: string, positionColumn: string | null, stateColumn: string | null): TowerImportSourceRow {
  const state = parseEnabled(stateColumn ? row.cells[stateColumn] : null);
  return {
    source,
    rowNumber: row.rowNumber,
    towerNoInput: clean(row.cells[towerColumn]),
    positionLabel: positionColumn ? clean(row.cells[positionColumn]) || null : null,
    enabled: state.enabled,
    parseError: state.error,
  };
}

export function towerRowsFromSpreadsheet(spreadsheet: ParsedSpreadsheet): TowerImportSourceRow[] {
  const rows: TowerImportSourceRow[] = [];
  for (const sheet of spreadsheet.sheets) {
    const towerColumn = columnName(sheet.headers, towerHeaders);
    if (!towerColumn) continue;
    const positionColumn = columnName(sheet.headers, positionHeaders);
    const stateColumn = columnName(sheet.headers, stateHeaders);
    rows.push(...sheet.rows.map((row) => fromSpreadsheetRow(sheet.name, row, towerColumn, positionColumn, stateColumn)));
  }
  if (!rows.length) throw new Error('未找到“杆塔编号/杆塔号”列');
  return rows;
}

export function buildTowerImportPreview(sourceRows: readonly TowerImportSourceRow[], existing: readonly LineTowerPositionSummary[]): TowerImportPreview {
  const existingByNo = new Map<string, LineTowerPositionSummary[]>();
  for (const tower of existing) {
    const group = existingByNo.get(tower.towerNo) ?? [];
    group.push(tower);
    existingByNo.set(tower.towerNo, group);
  }
  const sourceCounts = new Map<string, number>();
  for (const row of sourceRows) {
    const towerNo = normalizeTowerNo(row.towerNoInput);
    if (towerNo) sourceCounts.set(towerNo, (sourceCounts.get(towerNo) ?? 0) + 1);
  }
  const rows: TowerImportPreviewRow[] = sourceRows.map((row) => {
    if (row.parseError) return { ...row, towerNo: normalizeTowerNo(row.towerNoInput), action: 'error', message: row.parseError };
    const towerNo = normalizeTowerNo(row.towerNoInput);
    if (!towerNo) return { ...row, towerNo: null, action: 'error', message: `杆塔编号“${row.towerNoInput}”无法识别` };
    if ((sourceCounts.get(towerNo) ?? 0) > 1) return { ...row, towerNo, action: 'error', message: `${towerNo} 在导入数据中重复，无法自动判断实体` };
    const matches = existingByNo.get(towerNo) ?? [];
    if (matches.length > 1) return { ...row, towerNo, action: 'error', message: `${towerNo} 当前对应多个杆塔对象，请人工选择具体对象` };
    if (!matches.length) return { ...row, towerNo, action: 'create', message: '新增' };
    const current = matches[0]!;
    if ((current.positionLabel ?? null) === row.positionLabel && current.enabled === row.enabled) {
      return { ...row, towerNo, action: 'unchanged', message: '无变化', id: current.id, expectedVersion: current.version };
    }
    return { ...row, towerNo, action: 'update', message: '更新属性', id: current.id, expectedVersion: current.version };
  });
  const counts = { total: rows.length, create: 0, update: 0, unchanged: 0, error: 0 };
  for (const row of rows) counts[row.action] += 1;
  return { counts, rows };
}

export function towerImportChunks(rows: readonly TowerImportPreviewRow[], size = 20): TowerImportPreviewRow[][] {
  const actionable = rows.filter((row) => row.action === 'create' || row.action === 'update');
  const chunks: TowerImportPreviewRow[][] = [];
  for (let index = 0; index < actionable.length; index += size) chunks.push(actionable.slice(index, index + size));
  return chunks;
}

export function completeTowerCoverageErrors(preview: TowerImportPreview, existing: readonly LineTowerPositionSummary[]): string[] {
  const matched = new Set(preview.rows.filter((row) => row.id && row.action !== 'error').map((row) => row.id!));
  const missing = existing.filter((tower) => !matched.has(tower.id));
  if (!missing.length) return [];
  const sample = missing.slice(0, 5).map((tower) => tower.towerNo).join('、');
  return [`完整清单缺少当前线路 ${missing.length} 个杆塔对象${sample ? `（如 ${sample}）` : ''}，不能整体重排`];
}

export function towerIdsInSourceOrder(preview: TowerImportPreview, current: readonly LineTowerPositionSummary[]): string[] | null {
  const byNo = new Map<string, LineTowerPositionSummary[]>();
  for (const tower of current) {
    const group = byNo.get(tower.towerNo) ?? [];
    group.push(tower); byNo.set(tower.towerNo, group);
  }
  const result: string[] = [];
  for (const row of preview.rows) {
    if (!row.towerNo || row.action === 'error') return null;
    const matches = byNo.get(row.towerNo) ?? [];
    if (matches.length !== 1) return null;
    result.push(matches[0]!.id);
  }
  return new Set(result).size === current.length && result.length === current.length ? result : null;
}
