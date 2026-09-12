import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseSpreadsheet } from '../src/imports/parser';

const rows = [
  ['序号', '电压等级', '线路名称', '杆段', '物资型号', '物资数量', '单位'],
  [1, '220kV', '龙城线', '#10-#11', 'JX-01', 2, '套'],
  [2, '110kV', '江北线', '#20', 'JX-02', 1.25, '只'],
];

function toArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function xlsxBuffer(sheetRows = rows, sheetName = '需求') {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheetRows), sheetName);
  return toArrayBuffer(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer | Uint8Array);
}

function csvBuffer() {
  const text = rows.map((row) => row.join(',')).join('\n');
  return new TextEncoder().encode(text).buffer;
}

describe('P2 browser spreadsheet parser', () => {
  it('normalizes XLSX and CSV into the same row structure', async () => {
    const xlsx = await parseSpreadsheet({ name: '需求.xlsx', data: xlsxBuffer() });
    const csv = await parseSpreadsheet({ name: '需求.csv', data: csvBuffer() });

    expect(xlsx.fileType).toBe('xlsx');
    expect(csv.fileType).toBe('csv');
    expect(xlsx.sheets).toHaveLength(1);
    expect(csv.sheets).toHaveLength(1);
    const xlsxSheet = xlsx.sheets[0]!;
    const csvSheet = csv.sheets[0]!;
    expect(xlsxSheet.headers).toEqual(rows[0]!);
    expect(csvSheet.headers).toEqual(rows[0]!);
    expect(xlsxSheet.rows).toEqual(csvSheet.rows);
    expect(xlsxSheet.rows[0]!).toEqual({
      rowNumber: 2,
      cells: {
        序号: 1,
        电压等级: '220kV',
        线路名称: '龙城线',
        杆段: '#10-#11',
        物资型号: 'JX-01',
        物资数量: 2,
        单位: '套',
      },
    });
  });

  it('preserves multiple XLSX worksheets and source row numbers', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '第一批');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([rows[0]!, [3, '500kV', '长江线', '#1', 'JX-03', 4, '套']]), '第二批');
    const data = toArrayBuffer(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer | Uint8Array);

    const parsed = await parseSpreadsheet({ name: '多表.xlsx', data });
    expect(parsed.sheets.map((sheet) => sheet.name)).toEqual(['第一批', '第二批']);
    const secondSheet = parsed.sheets[1]!;
    expect(secondSheet.rows[0]!.rowNumber).toBe(2);
    expect(secondSheet.rows[0]!.cells.线路名称).toBe('长江线');
  });

  it('keeps physical source rows across blank rows in XLSX and CSV', async () => {
    const spaced = [rows[0]!, rows[1]!, [], rows[2]!];
    for (const input of [
      { name: 'blank.xlsx', data: xlsxBuffer(spaced) },
      { name: 'blank.csv', data: new TextEncoder().encode(spaced.map((row) => row.join(',')).join('\n')).buffer },
    ]) {
      const parsed = await parseSpreadsheet(input);
      expect(parsed.sheets[0]!.rows.map((row) => row.rowNumber)).toEqual([2, 4]);
      expect(parsed.sheets[0]!.rows[1]!.cells.线路名称).toBe('江北线');
    }
  });

  it('honors the worksheet used-range starting row', async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([]);
    XLSX.utils.sheet_add_aoa(sheet, rows, { origin: 'A4' });
    sheet['!ref'] = 'A4:G6';
    XLSX.utils.book_append_sheet(workbook, sheet, '偏移');
    const parsed = await parseSpreadsheet({ name: 'offset.xlsx', data: toArrayBuffer(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer) });
    expect(parsed.sheets[0]!.rows.map((row) => row.rowNumber)).toEqual([5, 6]);
  });

  it('rejects legacy XLS explicitly instead of silently parsing it', async () => {
    await expect(parseSpreadsheet({ name: '旧表.xls', data: new ArrayBuffer(8) }))
      .rejects.toThrow(/XLS_UNSUPPORTED.*另存为.*\.xlsx/i);
  });

  it('rejects unsupported extensions before parsing arbitrary bytes', async () => {
    await expect(parseSpreadsheet({ name: '需求.pdf', data: new ArrayBuffer(8) }))
      .rejects.toThrow(/UNSUPPORTED_FILE_TYPE/);
  });
});
