import type { ProjectDemandLinkSummary, ProjectMaterialRequirementSummary, ReserveProjectSummary } from '@tpm/shared';
import type { DatabasePort, DatabaseValue } from '../ports/database.ts';
import type {
  ProjectMaterialInputCandidate,
  ProjectMaterialRevisionSummary,
  ReserveProjectListInput,
  ReserveProjectQueryRepository,
  ReserveProjectState,
  ResolvedProjectMaterialInput,
} from '../ports/reserve-project-query-repository.ts';

type ProjectRow = {
  id: string; name: string; business_year: number | null; owner: string | null; status: 'draft' | 'confirmed'; reserve_version: number;
  framework_id: string | null; version: number; created_at: string; updated_at: string;
};

type ProjectMaterialRow = {
  id: string; project_id: string; material_id: string | null; model: string; unit: string; required_quantity_scaled: number;
  unit_price_scaled: number | null; amount_fen: number | null; reserve_category_id: string | null; reserve_category_key: string | null;
  reserve_category_label: string | null; version: number; created_at: string; updated_at: string;
};

type DemandLinkRow = {
  project_id: string; id: string; demand_id: string; sequence_no: string; business_year: number | null; voltage_raw: string; voltage_verified: string | null;
  line_name: string; section_text: string; category_key: string | null; owner: string | null; created_at: string;
};

function amountFen(quantityScaled: number, unitPriceScaled: number | null): number | null {
  if (unitPriceScaled === null) return null;
  const rounded = (BigInt(quantityScaled) * BigInt(unitPriceScaled) + 500000n) / 1000000n;
  return rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : null;
}

function materialSummary(row: ProjectMaterialRow): ProjectMaterialRequirementSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    materialId: row.material_id,
    model: row.model,
    unit: row.unit,
    requiredQuantityScaled: row.required_quantity_scaled,
    unitPriceScaled: row.unit_price_scaled,
    amountFen: row.amount_fen,
    reserveCategoryId: row.reserve_category_id,
    reserveCategory: row.reserve_category_id && row.reserve_category_key && row.reserve_category_label
      ? { id: row.reserve_category_id, key: row.reserve_category_key, label: row.reserve_category_label }
      : null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function demandLink(row: DemandLinkRow): ProjectDemandLinkSummary {
  return {
    id: row.id,
    demandId: row.demand_id,
    sequenceNo: row.sequence_no,
    year: row.business_year,
    voltage: row.voltage_verified ?? row.voltage_raw,
    lineName: row.line_name,
    section: row.section_text,
    category: row.category_key,
    owner: row.owner,
    createdAt: row.created_at,
  };
}

function summary(project: ProjectRow, links: readonly ProjectDemandLinkSummary[], materials: readonly ProjectMaterialRequirementSummary[]): ReserveProjectSummary {
  const knownMaterialAmountFen = materials.reduce((sum, item) => sum + (item.amountFen ?? 0), 0);
  const missingPriceCount = materials.filter((item) => item.amountFen === null).length;
  return {
    id: project.id,
    name: project.name,
    year: project.business_year,
    owner: project.owner,
    status: project.status,
    reserveVersion: project.reserve_version,
    frameworkId: project.framework_id,
    version: project.version,
    demandLinks: [...links],
    materialRequirements: [...materials],
    knownMaterialAmountFen,
    missingPriceCount,
    materialPriceCompletenessBasisPoints: materials.length === 0 ? 10000 : Math.floor(((materials.length - missingPriceCount) * 10000) / materials.length),
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
}

export class SqlReserveProjectQueryRepository implements ReserveProjectQueryRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async list(input: ReserveProjectListInput): Promise<readonly ReserveProjectSummary[]> {
    const filters: string[] = [];
    const params: DatabaseValue[] = [];
    if (input.access) {
      const accessParts: string[] = [];
      if (input.access.projectIds.length) {
        accessParts.push(`p.id IN (${input.access.projectIds.map(() => '?').join(',')})`);
        params.push(...input.access.projectIds);
      }
      if (input.access.frameworkIds.length) {
        accessParts.push(`p.framework_id IN (${input.access.frameworkIds.map(() => '?').join(',')})`);
        params.push(...input.access.frameworkIds);
      }
      filters.push(accessParts.length ? `(${accessParts.join(' OR ')})` : '0=1');
    }
    if (input.stage === 'reserve') filters.push('NOT EXISTS (SELECT 1 FROM project_releases pr WHERE pr.project_id=p.id)');
    if (input.cursor) {
      filters.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?))');
      params.push(input.cursor.createdAt, input.cursor.createdAt, input.cursor.id);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    params.push(input.limit);
    const projects = await this.database.all<ProjectRow>({
      sql: `SELECT p.id,p.name,p.business_year,p.owner,p.status,p.reserve_version,p.framework_id,p.version,p.created_at,p.updated_at
            FROM projects p ${where} ORDER BY p.created_at DESC,p.id DESC LIMIT ?`,
      params,
    });
    if (!projects.length) return [];
    const ids = projects.map((project) => project.id);
    const placeholders = ids.map(() => '?').join(',');
    const [links, materials] = await Promise.all([
      this.database.all<DemandLinkRow>({
        sql: `SELECT pdl.project_id,pdl.id,pdl.demand_id,d.sequence_no,d.business_year,d.voltage_raw,d.voltage_verified,d.line_name,d.section_text,d.category_key,d.owner,pdl.created_at
              FROM project_demand_links pdl INNER JOIN demands d ON d.id=pdl.demand_id
              WHERE pdl.project_id IN (${placeholders}) ORDER BY pdl.project_id,d.sequence_no COLLATE NOCASE,pdl.id`, params: ids,
      }),
      this.database.all<ProjectMaterialRow>({
        sql: `SELECT pmr.id,pmr.project_id,pmr.material_id,pmr.model,pmr.unit,pmr.required_quantity_scaled,pmr.unit_price_scaled,pmr.amount_fen,
                     pmr.reserve_category_id,rc.category_key AS reserve_category_key,rc.label AS reserve_category_label,pmr.version,pmr.created_at,pmr.updated_at
              FROM project_material_requirements pmr LEFT JOIN reserve_categories rc ON rc.id=pmr.reserve_category_id
              WHERE pmr.project_id IN (${placeholders}) AND pmr.active=1 ORDER BY pmr.project_id,pmr.created_at,pmr.id`, params: ids,
      }),
    ]);
    const linksByProject = new Map<string, ProjectDemandLinkSummary[]>();
    for (const row of links) { const list = linksByProject.get(row.project_id) ?? []; list.push(demandLink(row)); linksByProject.set(row.project_id, list); }
    const materialsByProject = new Map<string, ProjectMaterialRequirementSummary[]>();
    for (const row of materials) { const list = materialsByProject.get(row.project_id) ?? []; list.push(materialSummary(row)); materialsByProject.set(row.project_id, list); }
    return projects.map((project) => summary(project, linksByProject.get(project.id) ?? [], materialsByProject.get(project.id) ?? []));
  }

  async find(projectId: string): Promise<ReserveProjectSummary | null> {
    const project = await this.database.first<ProjectRow>({
      sql: `SELECT id,name,business_year,owner,status,reserve_version,framework_id,version,created_at,updated_at FROM projects WHERE id=? LIMIT 1`, params: [projectId],
    });
    if (!project) return null;
    const [links, materials] = await Promise.all([
      this.database.all<DemandLinkRow>({
        sql: `SELECT pdl.project_id,pdl.id,pdl.demand_id,d.sequence_no,d.business_year,d.voltage_raw,d.voltage_verified,d.line_name,d.section_text,d.category_key,d.owner,pdl.created_at
              FROM project_demand_links pdl INNER JOIN demands d ON d.id=pdl.demand_id WHERE pdl.project_id=? ORDER BY d.sequence_no COLLATE NOCASE,pdl.id`, params: [projectId],
      }),
      this.listCurrentMaterials(projectId),
    ]);
    return summary(project, links.map(demandLink), materials);
  }

  async findState(projectId: string): Promise<ReserveProjectState | null> {
    const row = await this.database.first<{ id: string; framework_id: string | null; status: 'draft' | 'confirmed'; reserve_version: number; version: number }>({
      sql: `SELECT id,framework_id,status,reserve_version,version FROM projects WHERE id=? LIMIT 1`, params: [projectId],
    });
    return row ? { id: row.id, frameworkId: row.framework_id, status: row.status, reserveVersion: row.reserve_version, version: row.version } : null;
  }

  async validateDemandIds(ids: readonly string[]): Promise<boolean> {
    if (!ids.length) return true;
    const rows = await this.database.all<{ id: string }>({ sql: `SELECT id FROM demands WHERE id IN (${ids.map(() => '?').join(',')})`, params: ids });
    const existing = new Set(rows.map((row) => row.id));
    return ids.every((id) => existing.has(id));
  }

  async resolveMaterials(items: readonly ProjectMaterialInputCandidate[]): Promise<readonly ResolvedProjectMaterialInput[] | null> {
    const materialIds = [...new Set(items.flatMap((item) => item.materialId ? [item.materialId] : []))];
    const categoryIds = [...new Set(items.flatMap((item) => item.reserveCategoryId ? [item.reserveCategoryId] : []))];
    const [materialRows, categoryRows] = await Promise.all([
      materialIds.length ? this.database.all<{ id: string; model: string; unit: string; enabled: number }>({ sql: `SELECT id,model,unit,enabled FROM materials WHERE id IN (${materialIds.map(() => '?').join(',')})`, params: materialIds }) : Promise.resolve([]),
      categoryIds.length ? this.database.all<{ id: string }>({ sql: `SELECT id FROM reserve_categories WHERE enabled=1 AND id IN (${categoryIds.map(() => '?').join(',')})`, params: categoryIds }) : Promise.resolve([]),
    ]);
    const materialMap = new Map(materialRows.map((row) => [row.id, row]));
    const categories = new Set(categoryRows.map((row) => row.id));
    const out: ResolvedProjectMaterialInput[] = [];
    for (const item of items) {
      let model = item.model, unit = item.unit;
      if (item.materialId) {
        const material = materialMap.get(item.materialId);
        if (!material || material.enabled !== 1) return null;
        if (!model) model = material.model;
        if (!unit) unit = material.unit;
      }
      if (!model || model.length > 160 || !unit || unit.length > 40) return null;
      if (item.reserveCategoryId && !categories.has(item.reserveCategoryId)) return null;
      const computed = amountFen(item.requiredQuantityScaled, item.unitPriceScaled);
      if (item.unitPriceScaled !== null && computed === null) return null;
      out.push({ ...item, model, unit, amountFen: computed });
    }
    return out;
  }

  async listMaterialRevisions(projectId: string): Promise<readonly ProjectMaterialRevisionSummary[]> {
    const rows = await this.database.all<{ id: string; project_version: number; reason: string; before_json: string; after_json: string; created_at: string }>({
      sql: `SELECT id,project_version,reason,before_json,after_json,created_at FROM project_material_revisions WHERE project_id=? ORDER BY created_at DESC,id DESC`, params: [projectId],
    });
    return rows.map((row) => ({ id: row.id, projectId, projectVersion: row.project_version, reason: row.reason, before: JSON.parse(row.before_json), after: JSON.parse(row.after_json), createdAt: row.created_at }));
  }

  async listUsedDemandIds(projectId: string): Promise<readonly string[]> {
    const rows = await this.database.all<{ demand_id: string }>({
      sql: `SELECT DISTINCT tds.demand_id FROM task_demand_scopes tds INNER JOIN project_tasks pt ON pt.id=tds.task_id WHERE pt.project_id=? ORDER BY tds.demand_id`, params: [projectId],
    });
    return rows.map((row) => row.demand_id);
  }

  async getAssignedMaterialQuantities(projectId: string): Promise<ReadonlyMap<string, number>> {
    const rows = await this.database.all<{ id: string; total: number | string }>({
      sql: `SELECT tmr.project_material_requirement_id AS id,COALESCE(SUM(tmr.required_quantity_scaled),0) AS total
            FROM task_material_requirements tmr INNER JOIN project_tasks pt ON pt.id=tmr.task_id
            WHERE pt.project_id=? AND tmr.project_material_requirement_id IS NOT NULL GROUP BY tmr.project_material_requirement_id`, params: [projectId],
    });
    return new Map(rows.map((row) => [row.id, Number(row.total)]));
  }

  async listCurrentMaterials(projectId: string): Promise<readonly ProjectMaterialRequirementSummary[]> {
    const rows = await this.database.all<ProjectMaterialRow>({
      sql: `SELECT pmr.id,pmr.project_id,pmr.material_id,pmr.model,pmr.unit,pmr.required_quantity_scaled,pmr.unit_price_scaled,pmr.amount_fen,
                   pmr.reserve_category_id,rc.category_key AS reserve_category_key,rc.label AS reserve_category_label,pmr.version,pmr.created_at,pmr.updated_at
            FROM project_material_requirements pmr LEFT JOIN reserve_categories rc ON rc.id=pmr.reserve_category_id
            WHERE pmr.project_id=? AND pmr.active=1 ORDER BY pmr.created_at,pmr.id`, params: [projectId],
    });
    return rows.map(materialSummary);
  }
}
