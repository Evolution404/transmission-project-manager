import * as XLSX from 'xlsx';

export type ParsedCell = string | number | boolean | null;

export interface ParsedSpreadsheetRow {
  rowNumber: number;
  cells: Record<string, ParsedCell>;
}

export interface ParsedSpreadsheetSheet {
  name: string;
  headers: string[];
  rows: ParsedSpreadsheetRow[];
}

export interface ParsedSpreadsheet {
  fileType: 'xlsx' | 'csv';
  sheets: ParsedSpreadsheetSheet[];
}

function extension(name: string) {
  const match = name.trim().toLowerCase().match(/\.([^.]+)$/);
  return match?.[1] ?? '';
}

function headerName(value: unknown, index: number) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text || `未命名列${index + 1}`;
}

function toCell(value: unknown): ParsedCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

function parseSheet(name: string, worksheet: XLSX.WorkSheet): ParsedSpreadsheetSheet {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
  const rawHeaders = matrix[0] ?? [];
  const headers = rawHeaders.map(headerName);
  const duplicateCheck = new Set<string>();
  for (const header of headers) {
    const key = header.toLocaleLowerCase();
    if (duplicateCheck.has(key)) throw new Error(`DUPLICATE_HEADER: 工作表“${name}”存在重复列名“${header}”`);
    duplicateCheck.add(key);
  }

  const rows = matrix.slice(1).map((values, index) => {
    const cells: Record<string, ParsedCell> = {};
    for (let column = 0; column < headers.length; column += 1) {
      cells[headers[column]!] = toCell(values[column]);
    }
    return { rowNumber: index + 2, cells };
  });
  return { name, headers, rows };
}

export async function parseSpreadsheet(input: { name: string; data: ArrayBuffer }): Promise<ParsedSpreadsheet> {
  const ext = extension(input.name);
  if (ext === 'xls') throw new Error('XLS_UNSUPPORTED: 旧版 .xls 暂不支持，请另存为 .xlsx 后再导入');
  if (ext !== 'xlsx' && ext !== 'csv') throw new Error('UNSUPPORTED_FILE_TYPE: 仅支持 .xlsx 和 .csv');
  if (!(input.data instanceof ArrayBuffer) || input.data.byteLength === 0) throw new Error('EMPTY_FILE: 文件内容为空');

  let workbook: XLSX.WorkBook;
  try {
    workbook = ext === 'csv'
      ? XLSX.read(new TextDecoder('utf-8').decode(input.data), {
          type: 'string',
          raw: false,
          dense: true,
          WTF: false,
        })
      : XLSX.read(input.data, {
          type: 'array',
          raw: true,
          dense: true,
          WTF: false,
        });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '未知解析错误';
    throw new Error(`SPREADSHEET_PARSE_FAILED: ${message}`);
  }
  if (!workbook.SheetNames.length) throw new Error('EMPTY_WORKBOOK: 文件中没有工作表');

  return {
    fileType: ext,
    sheets: workbook.SheetNames.map((name) => parseSheet(name, workbook.Sheets[name]!)),
  };
}
