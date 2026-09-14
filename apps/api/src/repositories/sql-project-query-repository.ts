import type { MaterialSummary, ReserveCandidate } from '@tpm/shared';
import type { DatabasePort } from '../ports/database.ts';
import type { ProjectQueryRepository, ProjectSuggestionGroup, ReserveCandidatePage } from '../ports/project-query-repository.ts';

type CandidateRow = {
  demand_material_id: string;
  demand_id: string;
  sequence_no: string;
  business_year: number | null;
  category_key: string | null;
  voltage_raw: string;
  voltage_verified: string | null;
  line_name: string;
  section_text: string;
  raw_model: string;
  unit: string | null;
  quantity_scaled: number;
  allocated_quantity_scaled: number;
  remaining_quantity_scaled: number;
  material_id: string | null;
  material_code: string | null;
  material_name: string | null;
  material_model: string | null;
  material_unit: string | null;
  material_enabled: number | null;
  material_version: number | null;
  source_type: 'import' | 'manual';
  source_file_name: string | null;
  source_sheet: string | null;
  source_row_number: number | null;
};

type SuggestionRow = {
  business_year: number | null;
  category_key: string | null;
  voltage: string;
  line_name: string;
  item_count: number;
};

function material(row: CandidateRow): MaterialSummary | null {
  if (!row.material_id || !row.material_name || !row.material_model || !row.material_unit || row.material_version === null) return null;
  return {
    id: row.material_id,
    code: row.material_code,
    name: row.material_name,
    model: row.material_model,
    unit: row.material_unit,
    enabled: row.material_enabled === 1,
    version: row.material_version,
  };
}

function candidate(row: CandidateRow): ReserveCandidate {
  return {
    demandMaterialId: row.demand_material_id,
    demandId: row.demand_id,
    sequenceNo: row.sequence_no,
    year: row.business_year,
    category: row.category_key,
    voltage: row.voltage_verified ?? row.voltage_raw,
    lineName: row.line_name,
    section: row.section_text,
    rawModel: row.raw_model,
    unit: row.unit,
    material: material(row),
    originalQuantityScaled: row.quantity_scaled,
    allocatedQuantityScaled: Number(row.allocated_quantity_scaled),
    remainingQuantityScaled: Number(row.remaining_quantity_scaled),
    source: row.source_type === 'manual'
      ? { type: 'manual' }
      : { type: 'import', fileName: row.source_file_name!, sheetName: row.source_sheet!, rowNumber: row.source_row_number! },
  };
}

export class SqlProjectQueryRepository implements ProjectQueryRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async listCandidates(input: { limit: number; cursor: string | null }): Promise<ReserveCandidatePage> {
    const rows = await this.database.all<CandidateRow>({
      sql: `SELECT dm.id AS demand_material_id,d.id AS demand_id,d.sequence_no,d.business_year,d.category_key,d.voltage_raw,d.voltage_verified,
                   d.line_name,d.section_text,dm.raw_model,dm.unit,dm.quantity_scaled,
                   COALESCE(SUM(da.quantity_scaled),0) AS allocated_quantity_scaled,
                   dm.quantity_scaled-COALESCE(SUM(da.quantity_scaled),0) AS remaining_quantity_scaled,
                   m.id AS material_id,m.code AS material_code,m.name AS material_name,m.model AS material_model,m.unit AS material_unit,
                   m.enabled AS material_enabled,m.version AS material_version,
                   d.source_type,d.source_file_name,d.source_sheet,d.source_row_number
            FROM demand_materials dm
            INNER JOIN demands d ON d.id=dm.demand_id
            LEFT JOIN demand_allocations da ON da.demand_material_id=dm.id
            LEFT JOIN materials m ON m.id=dm.material_id
            WHERE (? IS NULL OR dm.id>?)
            GROUP BY dm.id,d.id,d.sequence_no,d.business_year,d.category_key,d.voltage_raw,d.voltage_verified,d.line_name,d.section_text,
                     dm.raw_model,dm.unit,dm.quantity_scaled,m.id,m.code,m.name,m.model,m.unit,m.enabled,m.version,
                     d.source_type,d.source_file_name,d.source_sheet,d.source_row_number
            HAVING dm.quantity_scaled-COALESCE(SUM(da.quantity_scaled),0)>0
            ORDER BY dm.id ASC LIMIT ?`,
      params: [input.cursor, input.cursor, input.limit + 1],
    });
    const hasMore = rows.length > input.limit;
    const selected = hasMore ? rows.slice(0, input.limit) : rows;
    const last = selected.at(-1);
    return {
      items: selected.map(candidate),
      nextCursor: hasMore && last ? last.demand_material_id : null,
    };
  }

  async listSuggestions(limit: number): Promise<readonly ProjectSuggestionGroup[]> {
    const rows = await this.database.all<SuggestionRow>({
      sql: `SELECT d.business_year,d.category_key,COALESCE(d.voltage_verified,d.voltage_raw) AS voltage,d.line_name,
                   COUNT(*) AS item_count
            FROM demand_materials dm
            INNER JOIN demands d ON d.id=dm.demand_id
            LEFT JOIN (
              SELECT demand_material_id,SUM(quantity_scaled) AS allocated_quantity_scaled
              FROM demand_allocations GROUP BY demand_material_id
            ) allocated ON allocated.demand_material_id=dm.id
            WHERE dm.quantity_scaled-COALESCE(allocated.allocated_quantity_scaled,0)>0
            GROUP BY d.business_year,d.category_key,COALESCE(d.voltage_verified,d.voltage_raw),d.line_name
            ORDER BY d.business_year DESC,d.category_key COLLATE NOCASE,voltage COLLATE NOCASE,d.line_name COLLATE NOCASE
            LIMIT ?`,
      params: [limit],
    });
    return rows.map((row) => ({
      year: row.business_year,
      category: row.category_key,
      voltage: row.voltage,
      lineName: row.line_name,
      itemCount: Number(row.item_count),
    }));
  }
}
