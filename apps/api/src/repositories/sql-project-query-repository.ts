import type {
  MaterialSummary,
  ProjectAllocationDetail,
  ProjectCategorySummary,
  ProjectCostLine,
  ProjectCostSummary,
  ProjectDetail,
  ProjectMaterialSummary,
  ProjectSummary,
  ReserveCandidate,
} from '@tpm/shared';
import type { DatabasePort, DatabaseValue } from '../ports/database.ts';
import type { ProjectPage, ProjectPageCursor, ProjectQueryRepository, ProjectSuggestionGroup, ReserveCandidatePage } from '../ports/project-query-repository.ts';

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

type ProjectRow = {
  id: string;
  name: string;
  business_year: number | null;
  owner: string | null;
  status: 'draft' | 'confirmed';
  reserve_version: number;
  framework_id: string | null;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type ProjectListRow = ProjectRow & {
  known_amount_fen: number;
  allocation_count: number;
  priced_material_count: number;
};

type AllocationRow = {
  id: string;
  project_id: string;
  demand_material_id: string;
  quantity_scaled: number;
  raw_model: string;
  unit: string | null;
  material_id: string | null;
  material_code: string | null;
  material_name: string | null;
  material_model: string | null;
  material_unit: string | null;
  material_enabled: number | null;
  material_version: number | null;
  demand_id: string;
  sequence_no: string;
  business_year: number | null;
  category_key: string | null;
  voltage_raw: string;
  voltage_verified: string | null;
  line_name: string;
  section_text: string;
  source_type: 'import' | 'manual';
  source_file_name: string | null;
  source_sheet: string | null;
  source_row_number: number | null;
};

type CostLineRow = {
  id: string;
  project_id: string;
  kind: 'material' | 'construction' | 'other';
  demand_allocation_id: string | null;
  label: string;
  unit_price_scaled: number | null;
  amount_fen: number | null;
  price_source: string | null;
  price_date: string | null;
  tax_inclusive: number | null;
  suggested_reserve_category_id: string | null;
};

type MaterialColumns = {
  material_id: string | null;
  material_code: string | null;
  material_name: string | null;
  material_model: string | null;
  material_unit: string | null;
  material_enabled: number | null;
  material_version: number | null;
};

function material(row: MaterialColumns): MaterialSummary | null {
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

function projectCostSummary(knownAmountFen: number, allocationCount: number, pricedMaterialCount: number): ProjectCostSummary {
  const missingPriceCount = Math.max(0, allocationCount - pricedMaterialCount);
  return {
    knownAmountFen,
    missingPriceCount,
    completenessBasisPoints: allocationCount === 0 ? 0 : Math.floor(((allocationCount - missingPriceCount) * 10000) / allocationCount),
  };
}

function projectSummary(row: ProjectRow, summary: ProjectCostSummary): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    year: row.business_year,
    owner: row.owner,
    status: row.status,
    reserveVersion: row.reserve_version,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...summary,
  };
}

function allocationDetail(row: AllocationRow): ProjectAllocationDetail {
  return {
    id: row.id,
    demandMaterialId: row.demand_material_id,
    quantityScaled: row.quantity_scaled,
    rawModel: row.raw_model,
    unit: row.unit,
    material: material(row),
    demand: {
      id: row.demand_id,
      sequenceNo: row.sequence_no,
      year: row.business_year,
      category: row.category_key,
      voltage: row.voltage_verified ?? row.voltage_raw,
      lineName: row.line_name,
      section: row.section_text,
    },
    source: row.source_type === 'manual'
      ? { type: 'manual' }
      : { type: 'import', fileName: row.source_file_name!, sheetName: row.source_sheet!, rowNumber: row.source_row_number! },
  };
}

function projectMaterialSummary(rows: readonly AllocationRow[]): ProjectMaterialSummary[] {
  const groups = new Map<string, ProjectMaterialSummary>();
  for (const row of rows) {
    const resolved = material(row);
    const model = resolved?.model ?? row.raw_model;
    const unit = resolved?.unit ?? row.unit;
    const key = `${resolved?.id ?? `raw:${model.toLowerCase()}`}\u0000${(unit ?? '').toLowerCase()}`;
    const current = groups.get(key);
    if (current) current.quantityScaled += row.quantity_scaled;
    else groups.set(key, {
      materialId: resolved?.id ?? null,
      rawModel: row.raw_model,
      model,
      name: resolved?.name ?? null,
      unit,
      quantityScaled: row.quantity_scaled,
    });
  }
  return [...groups.values()].sort((a, b) => `${a.model}\u0000${a.unit ?? ''}`.localeCompare(`${b.model}\u0000${b.unit ?? ''}`, 'zh-CN'));
}

function costLine(row: CostLineRow): ProjectCostLine {
  return {
    id: row.id,
    kind: row.kind,
    demandAllocationId: row.demand_allocation_id,
    label: row.label,
    unitPriceScaled: row.unit_price_scaled,
    amountFen: row.amount_fen,
    source: row.price_source,
    priceDate: row.price_date,
    taxInclusive: row.tax_inclusive === null ? null : row.tax_inclusive === 1,
    suggestedReserveCategoryId: row.suggested_reserve_category_id,
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

  async listProjects(input: { allowedProjectIds: readonly string[] | null; cursor: ProjectPageCursor | null; limit: number }): Promise<ProjectPage> {
    if (input.allowedProjectIds && input.allowedProjectIds.length === 0) return { items: [], nextCursor: null };
    const where: string[] = [];
    const params: DatabaseValue[] = [];
    if (input.allowedProjectIds) {
      where.push(`p.id IN (${input.allowedProjectIds.map(() => '?').join(',')})`);
      params.push(...input.allowedProjectIds);
    }
    if (input.cursor) {
      where.push('(p.created_at<? OR (p.created_at=? AND p.id<?))');
      params.push(input.cursor.createdAt, input.cursor.createdAt, input.cursor.id);
    }
    const rows = await this.database.all<ProjectListRow>({
      sql: `SELECT p.id,p.name,p.business_year,p.owner,p.status,p.reserve_version,p.framework_id,p.version,p.created_by,p.created_at,p.updated_at,
                   COALESCE((SELECT SUM(pcl.amount_fen) FROM project_cost_lines pcl WHERE pcl.project_id=p.id AND pcl.amount_fen IS NOT NULL),0) AS known_amount_fen,
                   (SELECT COUNT(*) FROM demand_allocations da WHERE da.project_id=p.id) AS allocation_count,
                   (SELECT COUNT(*) FROM project_cost_lines pcl WHERE pcl.project_id=p.id AND pcl.kind='material' AND pcl.unit_price_scaled IS NOT NULL) AS priced_material_count
            FROM projects p ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY p.created_at DESC,p.id DESC LIMIT ?`,
      params: [...params, input.limit + 1],
    });
    const hasMore = rows.length > input.limit;
    const selected = hasMore ? rows.slice(0, input.limit) : rows;
    const last = selected.at(-1);
    return {
      items: selected.map((row) => projectSummary(row, projectCostSummary(Number(row.known_amount_fen), Number(row.allocation_count), Number(row.priced_material_count)))),
      nextCursor: hasMore && last ? { createdAt: last.created_at, id: last.id } : null,
    };
  }

  async getProjectDetail(id: string): Promise<ProjectDetail | null> {
    const project = await this.database.first<ProjectRow>({
      sql: `SELECT id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at
            FROM projects WHERE id=? LIMIT 1`,
      params: [id],
    });
    if (!project) return null;
    const allocations = await this.database.all<AllocationRow>({
      sql: `SELECT da.id,da.project_id,da.demand_material_id,da.quantity_scaled,
                   dm.raw_model,dm.unit,
                   m.id AS material_id,m.code AS material_code,m.name AS material_name,m.model AS material_model,
                   m.unit AS material_unit,m.enabled AS material_enabled,m.version AS material_version,
                   d.id AS demand_id,d.sequence_no,d.business_year,d.category_key,d.voltage_raw,d.voltage_verified,
                   d.line_name,d.section_text,d.source_type,d.source_file_name,d.source_sheet,d.source_row_number
            FROM demand_allocations da
            INNER JOIN demand_materials dm ON dm.id=da.demand_material_id
            INNER JOIN demands d ON d.id=dm.demand_id
            LEFT JOIN materials m ON m.id=dm.material_id
            WHERE da.project_id=?
            ORDER BY d.source_file_name,d.source_sheet,d.source_row_number,da.id`,
      params: [id],
    });
    const costs = await this.database.all<CostLineRow>({
      sql: `SELECT pcl.id,pcl.project_id,pcl.kind,pcl.demand_allocation_id,pcl.label,pcl.unit_price_scaled,pcl.amount_fen,
                   pcl.price_source,pcl.price_date,pcl.tax_inclusive,cm.reserve_category_id AS suggested_reserve_category_id
            FROM project_cost_lines pcl
            LEFT JOIN demand_allocations da ON da.id=pcl.demand_allocation_id
            LEFT JOIN demand_materials dm ON dm.id=da.demand_material_id
            LEFT JOIN demands d ON d.id=dm.demand_id
            LEFT JOIN category_mappings cm ON cm.demand_category_key=d.category_key COLLATE NOCASE
            WHERE pcl.project_id=?
            ORDER BY CASE pcl.kind WHEN 'material' THEN 1 WHEN 'construction' THEN 2 ELSE 3 END,pcl.id`,
      params: [id],
    });
    const categoryAllocations = await this.database.all<{ id: string; cost_line_id: string; reserve_category_id: string; amount_fen: number }>({
      sql: `SELECT id,cost_line_id,reserve_category_id,amount_fen
            FROM category_cost_allocations WHERE project_id=? ORDER BY cost_line_id,reserve_category_id`,
      params: [id],
    });
    const categoryRows = await this.database.all<{ reserve_category_id: string; category_key: string; label: string; amount_fen: number }>({
      sql: `SELECT rc.id AS reserve_category_id,rc.category_key,rc.label,COALESCE(SUM(cca.amount_fen),0) AS amount_fen
            FROM category_cost_allocations cca
            INNER JOIN reserve_categories rc ON rc.id=cca.reserve_category_id
            WHERE cca.project_id=?
            GROUP BY rc.id,rc.category_key,rc.label
            ORDER BY rc.label COLLATE NOCASE,rc.id`,
      params: [id],
    });
    const knownAmountFen = costs.reduce((sum, line) => sum + (line.amount_fen ?? 0), 0);
    const pricedMaterialCount = costs.filter((line) => line.kind === 'material' && line.unit_price_scaled !== null).length;
    const summary = projectCostSummary(knownAmountFen, allocations.length, pricedMaterialCount);
    const categories: ProjectCategorySummary[] = categoryRows.map((row) => ({
      reserveCategoryId: row.reserve_category_id,
      key: row.category_key,
      label: row.label,
      amountFen: Number(row.amount_fen),
    }));
    const classifiedAmountFen = categories.reduce((sum, item) => sum + item.amountFen, 0);
    return {
      ...projectSummary(project, summary),
      allocations: allocations.map(allocationDetail),
      materialSummary: projectMaterialSummary(allocations),
      costLines: costs.map(costLine),
      categoryAllocations: categoryAllocations.map((row) => ({
        id: row.id,
        costLineId: row.cost_line_id,
        reserveCategoryId: row.reserve_category_id,
        amountFen: row.amount_fen,
      })),
      categories,
      classifiedAmountFen,
      unclassifiedAmountFen: Math.max(0, summary.knownAmountFen - classifiedAmountFen),
    };
  }
}
