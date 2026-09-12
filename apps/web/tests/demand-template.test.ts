import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildDemandImportTemplate, DEMAND_TEMPLATE_HEADERS } from '../src/imports/demandTemplate';
import { parseSpreadsheet } from '../src/imports/parser';

function toArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

describe('demand import template', () => {
  it('contains the canonical demand headers in a single importable worksheet', async () => {
    const bytes = await buildDemandImportTemplate();
    const workbook = XLSX.read(bytes, { type: 'array' });
    expect(workbook.SheetNames).toEqual(['需求导入']);
    const sheet = workbook.Sheets['需求导入']!;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });
    expect(rows[0]).toEqual(DEMAND_TEMPLATE_HEADERS);
    expect(rows).toHaveLength(1);
  });

  it('round-trips a user-filled template through the existing parser with physical row provenance', async () => {
    const workbook = XLSX.read(await buildDemandImportTemplate(), { type: 'array' });
    const sheet = workbook.Sheets['需求导入']!;
    XLSX.utils.sheet_add_aoa(sheet, [[1, '220kV', '龙城线', '#10-#11', 'JX-01', 2, '套', 2026, '防断线', '张三']], { origin: 'A2' });
    sheet['!ref'] = `A1:J2`;
    const filled = toArrayBuffer(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer | Uint8Array);

    const parsed = await parseSpreadsheet({ name: '需求导入模板.xlsx', data: filled });
    expect(parsed.sheets).toHaveLength(1);
    expect(parsed.sheets[0]!.headers).toEqual(DEMAND_TEMPLATE_HEADERS);
    expect(parsed.sheets[0]!.rows).toEqual([{
      rowNumber: 2,
      cells: {
        序号: 1,
        电压等级: '220kV',
        线路名称: '龙城线',
        杆段: '#10-#11',
        物资型号: 'JX-01',
        物资数量: 2,
        单位: '套',
        年度: 2026,
        类别: '防断线',
        负责人: '张三',
      },
    }]);
  });
});
