import type { DatabasePort, DatabaseStatement } from '../ports/database.ts';
import type {
  ConfirmReserveProjectRecord,
  CreateReserveProjectRecord,
  ReplaceReserveProjectDemandsRecord,
  ReplaceReserveProjectMaterialsRecord,
  ReserveProjectWriteRepository,
} from '../ports/reserve-project-write-repository.ts';

function projectGuard(projectId: string, version: number, now: string, status: 'draft' | 'confirmed' | null, incrementReserve: boolean): DatabaseStatement {
  return {
    sql: `UPDATE projects
          SET version=version+1,status=COALESCE(?,status),reserve_version=reserve_version+?,
              updated_at=CASE WHEN version=? THEN ? ELSE NULL END
          WHERE id=?`,
    params: [status, incrementReserve ? 1 : 0, version, now, projectId],
  };
}

function auditStatement(input: { id: string; actorId: string; action: string; objectId: string; before: unknown; after: unknown; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?,?,'project',?,?,?,?)`,
    params: [input.id, input.actorId, input.action, input.objectId, input.before === null ? null : JSON.stringify(input.before), input.after === null ? null : JSON.stringify(input.after), input.now],
  };
}

function idempotencyStatement(input: { key: string; actorId: string; operation: string; hash: string; responseJson: string; status: number; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,?,?,?,?)`,
    params: [input.key, input.actorId, input.operation, input.hash, input.responseJson, input.status, input.now],
  };
}

export class SqlReserveProjectWriteRepository implements ReserveProjectWriteRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async create(input: CreateReserveProjectRecord): Promise<void> {
    const project = input.project;
    await this.database.batch([
      {
        sql: `INSERT INTO projects (id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at)
              VALUES (?,?,?,?,'draft',0,NULL,1,?,?,?)`,
        params: [project.id, project.name, project.year, project.owner, input.actorId, input.now, input.now],
      },
      ...input.demandLinks.map((link) => ({
        sql: `INSERT INTO project_demand_links (id,project_id,demand_id,created_by,created_at) VALUES (?,?,?,?,?)`,
        params: [link.id, project.id, link.demandId, input.actorId, input.now],
      })),
      ...input.materials.map(({ id, item }) => ({
        sql: `INSERT INTO project_material_requirements
              (id,project_id,material_id,model,unit,required_quantity_scaled,unit_price_scaled,amount_fen,reserve_category_id,active,version,created_by,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?,?)`,
        params: [id, project.id, item.materialId, item.model, item.unit, item.requiredQuantityScaled, item.unitPriceScaled, item.amountFen, item.reserveCategoryId, input.actorId, input.now, input.now],
      })),
      auditStatement({ id: input.auditId, actorId: input.actorId, action: 'reserve_project.create', objectId: project.id, before: null, after: input.auditAfter, now: input.now }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash, responseJson: input.responseJson, status: 201, now: input.now }),
    ]);
  }

  async replaceDemands(input: ReplaceReserveProjectDemandsRecord): Promise<void> {
    await this.database.batch([
      projectGuard(input.projectId, input.expectedVersion, input.now, 'draft', false),
      { sql: `DELETE FROM project_demand_links WHERE project_id=?`, params: [input.projectId] },
      ...input.demandLinks.map((link) => ({
        sql: `INSERT INTO project_demand_links (id,project_id,demand_id,created_by,created_at) VALUES (?,?,?,?,?)`,
        params: [link.id, input.projectId, link.demandId, input.actorId, input.now],
      })),
      auditStatement({ id: input.auditId, actorId: input.actorId, action: 'reserve_project.demands.replace', objectId: input.projectId, before: { demandIds: input.beforeDemandIds }, after: { demandIds: input.demandLinks.map((link) => link.demandId) }, now: input.now }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash, responseJson: input.responseJson, status: 200, now: input.now }),
    ]);
  }

  async replaceMaterials(input: ReplaceReserveProjectMaterialsRecord): Promise<void> {
    const statements: DatabaseStatement[] = [
      projectGuard(input.projectId, input.expectedVersion, input.now, 'draft', false),
      { sql: `UPDATE project_material_requirements SET active=0,updated_at=? WHERE project_id=? AND active=1`, params: [input.now, input.projectId] },
    ];
    for (const row of input.materials) {
      if (row.existing) {
        statements.push({
          sql: `UPDATE project_material_requirements
                SET material_id=?,model=?,unit=?,required_quantity_scaled=?,unit_price_scaled=?,amount_fen=?,reserve_category_id=?,active=1,version=version+1,updated_at=?
                WHERE id=? AND project_id=?`,
          params: [row.item.materialId, row.item.model, row.item.unit, row.item.requiredQuantityScaled, row.item.unitPriceScaled, row.item.amountFen, row.item.reserveCategoryId, input.now, row.id, input.projectId],
        });
      } else {
        statements.push({
          sql: `INSERT INTO project_material_requirements
                (id,project_id,material_id,model,unit,required_quantity_scaled,unit_price_scaled,amount_fen,reserve_category_id,active,version,created_by,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?,?)`,
          params: [row.id, input.projectId, row.item.materialId, row.item.model, row.item.unit, row.item.requiredQuantityScaled, row.item.unitPriceScaled, row.item.amountFen, row.item.reserveCategoryId, input.actorId, input.now, input.now],
        });
      }
    }
    statements.push(
      {
        sql: `INSERT INTO project_material_revisions (id,project_id,project_version,reason,before_json,after_json,created_by,created_at)
              VALUES (?,?,?,?,?,?,?,?)`,
        params: [input.revisionId, input.projectId, input.expectedVersion + 1, input.reason, JSON.stringify(input.before), JSON.stringify(input.after), input.actorId, input.now],
      },
      auditStatement({ id: input.auditId, actorId: input.actorId, action: 'reserve_project.materials.replace', objectId: input.projectId, before: input.before, after: input.after, now: input.now }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash, responseJson: input.responseJson, status: 200, now: input.now }),
    );
    await this.database.batch(statements);
  }

  async confirm(input: ConfirmReserveProjectRecord): Promise<void> {
    await this.database.batch([
      projectGuard(input.projectId, input.expectedVersion, input.now, 'confirmed', true),
      {
        sql: `INSERT INTO project_versions
              (id,project_id,reserve_version,snapshot_json,known_amount_fen,missing_price_count,completeness_basis_points,reason,confirmed_by,confirmed_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
        params: [input.versionId, input.projectId, input.reserveVersion, JSON.stringify(input.snapshot), input.snapshot.knownMaterialAmountFen, input.snapshot.missingPriceCount, input.snapshot.materialPriceCompletenessBasisPoints, input.reason, input.actorId, input.now],
      },
      auditStatement({ id: input.auditId, actorId: input.actorId, action: 'reserve_project.confirm', objectId: input.projectId, before: { version: input.expectedVersion, reserveVersion: input.previousReserveVersion }, after: input.auditAfter, now: input.now }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash, responseJson: input.responseJson, status: 200, now: input.now }),
    ]);
  }
}
