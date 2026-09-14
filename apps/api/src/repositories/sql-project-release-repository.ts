import type { ProjectDemandLinkSummary, ProjectMaterialRequirementSummary, ProjectReleaseSummary } from '@tpm/shared';
import type { DatabasePort, DatabaseStatement } from '../ports/database.ts';
import type { CreateProjectReleaseRecord, ExecutionProjectState, ProjectReleaseRepository, ProjectReleaseSnapshot } from '../ports/project-release-repository.ts';

type ProjectRow = {
  id: string; name: string; business_year: number | null; owner: string | null; status: 'draft' | 'confirmed'; reserve_version: number;
  framework_id: string | null; version: number; created_at: string; updated_at: string;
};

type DemandLinkRow = {
  id: string; demand_id: string; sequence_no: string; business_year: number | null; voltage_raw: string; voltage_verified: string | null;
  line_name: string; section_text: string; category_key: string | null; owner: string | null; created_at: string;
};

type MaterialRow = {
  id: string; project_id: string; material_id: string | null; model: string; unit: string; required_quantity_scaled: number;
  unit_price_scaled: number | null; amount_fen: number | null; reserve_category_id: string | null; reserve_category_key: string | null;
  reserve_category_label: string | null; version: number; created_at: string; updated_at: string;
};

type ReleaseRow = {
  id: string; project_id: string; release_date: string; note: string | null; project_version_snapshot: number;
  reserve_version_snapshot: number; snapshot_json: string; created_at: string;
};

function auditStatement(input: { id: string; actorId: string; objectId: string; after: unknown; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?, 'project.release','project_release',?,NULL,?,?)`,
    params: [input.id, input.actorId, input.objectId, JSON.stringify(input.after), input.now],
  };
}

function idempotencyStatement(input: { key: string; actorId: string; operation: string; hash: string; responseJson: string; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,?,?,201,?)`,
    params: [input.key, input.actorId, input.operation, input.hash, input.responseJson, input.now],
  };
}

function project(row: ProjectRow): ExecutionProjectState {
  return {
    id: row.id,
    name: row.name,
    year: row.business_year,
    owner: row.owner,
    status: row.status,
    reserveVersion: row.reserve_version,
    frameworkId: row.framework_id,
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

function material(row: MaterialRow): ProjectMaterialRequirementSummary {
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

function release(row: ReleaseRow): ProjectReleaseSummary {
  const snapshot = JSON.parse(row.snapshot_json) as ProjectReleaseSnapshot;
  return {
    id: row.id,
    projectId: row.project_id,
    releaseDate: row.release_date,
    note: row.note,
    projectVersionSnapshot: row.project_version_snapshot,
    reserveVersionSnapshot: row.reserve_version_snapshot,
    projectVersion: row.project_version_snapshot + 1,
    snapshot,
    createdAt: row.created_at,
  };
}

export class SqlProjectReleaseRepository implements ProjectReleaseRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async findProject(id: string): Promise<ExecutionProjectState | null> {
    const row = await this.database.first<ProjectRow>({
      sql: `SELECT id,name,business_year,owner,status,reserve_version,framework_id,version,created_at,updated_at
            FROM projects WHERE id=? LIMIT 1`,
      params: [id],
    });
    return row ? project(row) : null;
  }

  async findProjectReleaseId(projectId: string): Promise<string | null> {
    const row = await this.database.first<{ id: string }>({
      sql: `SELECT id FROM project_releases WHERE project_id=? LIMIT 1`,
      params: [projectId],
    });
    return row?.id ?? null;
  }

  async loadSnapshot(projectId: string, projectVersion: number, reserveVersion: number): Promise<ProjectReleaseSnapshot> {
    const [links, materials] = await Promise.all([
      this.database.all<DemandLinkRow>({
        sql: `SELECT pdl.id,pdl.demand_id,d.sequence_no,d.business_year,d.voltage_raw,d.voltage_verified,d.line_name,d.section_text,d.category_key,d.owner,pdl.created_at
              FROM project_demand_links pdl INNER JOIN demands d ON d.id=pdl.demand_id
              WHERE pdl.project_id=? ORDER BY d.sequence_no COLLATE NOCASE,pdl.id`,
        params: [projectId],
      }),
      this.database.all<MaterialRow>({
        sql: `SELECT pmr.id,pmr.project_id,pmr.material_id,pmr.model,pmr.unit,pmr.required_quantity_scaled,pmr.unit_price_scaled,pmr.amount_fen,
                    pmr.reserve_category_id,rc.category_key AS reserve_category_key,rc.label AS reserve_category_label,pmr.version,pmr.created_at,pmr.updated_at
              FROM project_material_requirements pmr LEFT JOIN reserve_categories rc ON rc.id=pmr.reserve_category_id
              WHERE pmr.project_id=? AND pmr.active=1 ORDER BY pmr.created_at,pmr.id`,
        params: [projectId],
      }),
    ]);
    return {
      demandLinks: links.map(demandLink),
      materialRequirements: materials.map(material),
      projectVersion,
      reserveVersion,
    };
  }

  async listReleases(projectId: string): Promise<readonly ProjectReleaseSummary[]> {
    const rows = await this.database.all<ReleaseRow>({
      sql: `SELECT id,project_id,release_date,note,project_version_snapshot,reserve_version_snapshot,snapshot_json,created_at
            FROM project_releases WHERE project_id=? ORDER BY created_at DESC,id DESC`,
      params: [projectId],
    });
    return rows.map(release);
  }

  async createRelease(input: CreateProjectReleaseRecord): Promise<void> {
    const item = input.release;
    await this.database.batch([
      {
        sql: `UPDATE projects
              SET version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END
              WHERE id=?`,
        params: [input.expectedProjectVersion, item.createdAt, item.projectId],
      },
      {
        sql: `INSERT INTO project_releases
              (id,project_id,release_date,note,project_version_snapshot,reserve_version_snapshot,snapshot_json,created_by,created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`,
        params: [item.id, item.projectId, item.releaseDate, item.note, item.projectVersionSnapshot, item.reserveVersionSnapshot,
          JSON.stringify(item.snapshot), input.actorId, item.createdAt],
      },
      auditStatement({ id: input.auditId, actorId: input.actorId, objectId: item.id, after: item, now: item.createdAt }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash,
        responseJson: input.responseJson, now: item.createdAt }),
    ]);
  }
}
