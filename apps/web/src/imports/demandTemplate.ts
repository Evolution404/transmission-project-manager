export const DEMAND_TEMPLATE_HEADERS = [
  '序号',
  '电压等级',
  '线路名称',
  '杆段',
  '物资型号',
  '物资数量',
  '单位',
  '年度',
  '类别',
  '负责人',
] as const;

export const DEMAND_TEMPLATE_FILE_NAME = '项目需求导入模板.xlsx';

export async function buildDemandImportTemplate(): Promise<ArrayBuffer> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([[...DEMAND_TEMPLATE_HEADERS]]);
  sheet['!cols'] = [
    { wch: 10 },
    { wch: 14 },
    { wch: 24 },
    { wch: 20 },
    { wch: 24 },
    { wch: 14 },
    { wch: 10 },
    { wch: 10 },
    { wch: 18 },
    { wch: 14 },
  ];
  sheet['!autofilter'] = { ref: 'A1:J1' };
  XLSX.utils.book_append_sheet(workbook, sheet, '需求导入');
  const output = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer | Uint8Array;
  if (output instanceof ArrayBuffer) return output;
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
}

export async function downloadDemandImportTemplate(): Promise<void> {
  const bytes = await buildDemandImportTemplate();
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = DEMAND_TEMPLATE_FILE_NAME;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
