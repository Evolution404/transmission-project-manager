import type { DemandDetail, DemandLocationType, DemandMaterialSummary, DemandSummary } from '@tpm/shared';
import type { DatabasePort, DatabaseValue } from '../ports/database.ts';
import type { DemandPage, DemandQueryRepository } from '../ports/demand-query-repository.ts';

type DemandRow = {
  id: string;
  source_type: 'import' | 'manual';
  source_key: string;
  source_batch_id: string | null;
  source_file_sha256: string | null;
  source_file_name: string | null;
  source_sheet: string | null;
  source_row_number: number | null;
  sequence_no: string;
  business_year: number | null;
  voltage_raw: string;
  voltage_verified: string | null;
  line_name: string;
  section_text: string;
  category_key: string | null;
  owner: string | null;
  raw_json: string;
  version: number;
  created_at: string;
  voltage_level_id: string | null;
  line_id: string | null;
  location_type: DemandLocationType | null;
  start_tower_id: string | null;
  end_tower_id: string | null;
};

type DemandMaterialRow = {
  id: string;
  raw_model: string;
  quantity_scaled: number;
  unit: string | null;
  material_id: string | null;
  material_code: string | null;
  material_name: string | null;
  material_model: string | null;
  material_unit: string | null;
  material_enabled: number | null;
  material_version: number | null;
};

type SourceRow = {
  file_name: string;
  file_sha256: string;
  sheet_name: string;
  source_row_number: number;
  raw_json: string;
};

const demandSelect = `id,source_type,source_key,source_batch_id,source_file_sha256,source_file_name,source_sheet,source_row_number,
  sequence_no,business_year,voltage_raw,voltage_verified,line_name,section_text,category_key,owner,raw_json,version,created_at,
  voltage_level_id,line_id,location_type,start_tower_id,end_tower_id`;

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function summary(row: DemandRow): DemandSummary {
  return {
    id: row.id,
    sequenceNo: row.sequence_no,
    year: row.business_year,
    voltageLevelId: row.voltage_level_id,
    lineId: row.line_id,
    locationType: row.location_type,
    startTowerId: row.start_tower_id,
    endTowerId: row.end_tower_id,
    voltageRaw: row.voltage_raw,
    voltageVerified: row.voltage_verified,
    lineName: row.line_name,
    section: row.section_text,
    category: row.category_key,
    owner: row.owner,
    version: row.version,
    createdAt: row.created_at,
  };
}

function materialSummary(row: DemandMaterialRow): DemandMaterialSummary {
  return {
    id: row.id,
    rawModel: row.raw_model,
    quantityScaled: row.quantity_scaled,
    unit: row.unit,
    material: row.material_id && row.material_name && row.material_model && row.material_unit && row.material_version !== null
      ? {
          id: row.material_id,
          code: row.material_code,
          name: row.material_name,
          model: row.material_model,
          unit: row.material_unit,
          enabled: row.material_enabled === 1,
          version: row.material_version,
        }
      : null,
  };
}

export class SqlDemandQueryRepository implements DemandQueryRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async list(input: { query: string; cursor: { createdAt: string; id: string } | null; limit: number }): Promise<DemandPage> {
    const where: string[] = [];
    const params: DatabaseValue[] = [];
    if (input.query) {
      where.push('(line_name LIKE ? OR section_text LIKE ? OR sequence_no LIKE ?)');
      const pattern = `%${input.query}%`;
      params.push(pattern, pattern, pattern);
    }
    if (input.cursor) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(input.cursor.createdAt, input.cursor.createdAt, input.cursor.id);
    }
    const rows = await this.database.all<DemandRow>({
      sql: `SELECT ${demandSelect} FROM demands ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY created_at DESC,id DESC LIMIT ?`,
      params: [...params, input.limit + 1],
    });
    const hasMore = rows.length > input.limit;
    const selected = hasMore ? rows.slice(0, input.limit) : rows;
    const last = selected.at(-1);
    return {
      items: selected.map(summary),
      nextCursor: hasMore && last ? { createdAt: last.created_at, id: last.id } : null,
    };
  }

  async getById(id: string): Promise<DemandDetail | null> {
    const row = await this.database.first<DemandRow>({
      sql: `SELECT ${demandSelect} FROM demands WHERE id=? LIMIT 1`,
      params: [id],
    });
    if (!row) return null;

    const materialRows = await this.database.all<DemandMaterialRow>({
      sql: `SELECT dm.id,dm.raw_model,dm.quantity_scaled,dm.unit,
                   m.id AS material_id,m.code AS material_code,m.name AS material_name,m.model AS material_model,
                   m.unit AS material_unit,m.enabled AS material_enabled,m.version AS material_version
            FROM demand_materials dm LEFT JOIN materials m ON m.id=dm.material_id
            WHERE dm.demand_id=? ORDER BY dm.id`,
      params: [id],
    });
    const raw = parseObject(row.raw_json);
    if (row.source_type === 'manual') {
      return { ...summary(row), source: { type: 'manual', raw }, materials: materialRows.map(materialSummary) };
    }

    const sourceRows = await this.database.all<SourceRow>({
      sql: `SELECT file_name,file_sha256,sheet_name,source_row_number,raw_json
            FROM demand_source_rows WHERE demand_id=? ORDER BY source_row_number,id`,
      params: [id],
    });
    return {
      ...summary(row),
      source: {
        type: 'import',
        batchId: row.source_batch_id!,
        fileName: row.source_file_name!,
        fileSha256: row.source_file_sha256!,
        sheetName: row.source_sheet!,
        rowNumber: row.source_row_number!,
        raw,
        rows: sourceRows.map((source) => ({
          fileName: source.file_name,
          fileSha256: source.file_sha256,
          sheetName: source.sheet_name,
          rowNumber: source.source_row_number,
          raw: parseObject(source.raw_json),
        })),
      },
      materials: materialRows.map(materialSummary),
    };
  }
}
