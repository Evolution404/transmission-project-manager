import type { DatabasePort, DatabaseStatement } from '../ports/database.ts';
import type { AllocationFailure, ConfirmProjectRecord, CreateProjectRecord, ProjectAllocationWrite, ProjectWriteRepository, ProjectWriteState, ProtectedProjectScopeItem, ReplaceProjectAllocationsRecord, ReplaceProjectCategoryAllocationsRecord, ReplaceProjectCostsRecord } from '../ports/project-write-repository.ts';

export class SqlProjectWriteRepository implements ProjectWriteRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async create(input: CreateProjectRecord): Promise<void> {
    const project = input.project;
    const statements: DatabaseStatement[] = [{
      sql: `INSERT INTO projects (id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at)
            VALUES (?,?,?,?,'draft',0,NULL,1,?,?,?)`,
      params: [project.id, project.name, project.year, project.owner, input.actorId, project.createdAt, project.updatedAt],
    }];
    for (const allocation of input.allocations) {
      statements.push({
        sql: `INSERT INTO demand_allocations (id,project_id,demand_material_id,quantity_scaled,created_at)
              VALUES (
                ?,?,
                (SELECT dm.id FROM demand_materials dm
                 WHERE dm.id=? AND dm.quantity_scaled >= COALESCE((
                   SELECT SUM(da.quantity_scaled) FROM demand_allocations da WHERE da.demand_material_id=dm.id
                 ),0)+?),
                ?,?
              )`,
        params: [allocation.id, project.id, allocation.demandMaterialId, allocation.quantityScaled, allocation.quantityScaled, project.createdAt],
      });
    }
    statements.push({
      sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
            VALUES (?,?,'project.create','project',?,NULL,?,?)`,
      params: [input.auditId, input.actorId, project.id, JSON.stringify(project), project.createdAt],
    }, {
      sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (?,?,?,?,?,201,?)`,
      params: [input.idempotencyKey, input.actorId, input.operation, input.requestHash, input.responseJson, project.createdAt],
    });
    await this.database.batch(statements);
  }

  async findProject(id: string): Promise<ProjectWriteState | null> {
    const row = await this.database.first<{
      id: string; name: string; business_year: number | null; owner: string | null; status: 'draft' | 'confirmed';
      reserve_version: number; framework_id: string | null; version: number; created_by: string; created_at: string; updated_at: string;
    }>({
      sql: `SELECT id,name,business_year,owner,status,reserve_version,framework_id,version,created_by,created_at,updated_at
            FROM projects WHERE id=? LIMIT 1`,
      params: [id],
    });
    return row ? {
      id: row.id,
      name: row.name,
      year: row.business_year,
      owner: row.owner,
      status: row.status,
      reserveVersion: row.reserve_version,
      frameworkId: row.framework_id,
      version: row.version,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : null;
  }

  async getProtectedScope(projectId: string): Promise<readonly ProtectedProjectScopeItem[]> {
    const rows = await this.database.all<{ demand_material_id: string; protected_quantity_scaled: number }>({
      sql: `SELECT demand_material_id,MAX(total) AS protected_quantity_scaled
            FROM (
              SELECT demand_material_id,COALESCE(SUM(quantity_scaled),0) AS total
              FROM release_lines WHERE project_id=? GROUP BY demand_material_id
              UNION ALL
              SELECT demand_material_id,COALESCE(SUM(completed_quantity_scaled),0) AS total
              FROM implementation_lines WHERE project_id=? AND demand_material_id IS NOT NULL GROUP BY demand_material_id
              UNION ALL
              SELECT sc.demand_material_id,COALESCE(SUM(sc.quantity_scaled),0) AS total
              FROM settlement_coverage sc INNER JOIN settlements s ON s.id=sc.settlement_id
              WHERE sc.project_id=? AND s.voided_at IS NULL GROUP BY sc.demand_material_id
            ) protected
            GROUP BY demand_material_id
            ORDER BY demand_material_id`,
      params: [projectId, projectId, projectId],
    });
    return rows.map((row) => ({ demandMaterialId: row.demand_material_id, protectedQuantityScaled: Number(row.protected_quantity_scaled) }));
  }

  async replaceAllocations(input: ReplaceProjectAllocationsRecord): Promise<void> {
    const statements: DatabaseStatement[] = [{
      sql: `UPDATE projects
            SET status='draft',version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END
            WHERE id=?`,
      params: [input.expectedVersion, input.now, input.projectId],
    }, {
      sql: 'DELETE FROM demand_allocations WHERE project_id=?',
      params: [input.projectId],
    }];
    for (const allocation of input.allocations) {
      statements.push({
        sql: `INSERT INTO demand_allocations (id,project_id,demand_material_id,quantity_scaled,created_at)
              VALUES (
                ?,?,
                (SELECT dm.id FROM demand_materials dm
                 WHERE dm.id=? AND dm.quantity_scaled >= COALESCE((
                   SELECT SUM(da.quantity_scaled) FROM demand_allocations da WHERE da.demand_material_id=dm.id
                 ),0)+?),
                ?,?
              )`,
        params: [allocation.id, input.projectId, allocation.demandMaterialId, allocation.quantityScaled, allocation.quantityScaled, input.now],
      });
    }
    statements.push({
      sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
            VALUES (?,?,'project.allocations.replace','project',?,?,?,?)`,
      params: [
        input.auditId,
        input.actorId,
        input.projectId,
        JSON.stringify({ version: input.expectedVersion }),
        JSON.stringify({ version: input.expectedVersion + 1, allocations: input.allocations.map((item) => ({ demandMaterialId: item.demandMaterialId, quantityScaled: item.quantityScaled })) }),
        input.now,
      ],
    }, {
      sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (?,?,?,?,?,200,?)`,
      params: [input.idempotencyKey, input.actorId, input.operation, input.requestHash, input.responseJson, input.now],
    });
    await this.database.batch(statements);
  }

  async replaceCosts(input: ReplaceProjectCostsRecord): Promise<void> {
    const statements: DatabaseStatement[] = [{
      sql: `UPDATE projects
            SET status='draft',version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END
            WHERE id=?`,
      params: [input.expectedVersion, input.now, input.projectId],
    }, {
      sql: 'DELETE FROM project_cost_lines WHERE project_id=?',
      params: [input.projectId],
    }];
    for (const line of input.lines) {
      statements.push({
        sql: `INSERT INTO project_cost_lines
              (id,project_id,kind,demand_allocation_id,label,unit_price_scaled,amount_fen,price_source,price_date,tax_inclusive,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [
          line.id,
          input.projectId,
          line.kind,
          line.demandAllocationId,
          line.label,
          line.unitPriceScaled,
          line.amountFen,
          line.source,
          line.priceDate,
          line.taxInclusive === null ? null : line.taxInclusive ? 1 : 0,
          input.now,
          input.now,
        ],
      });
    }
    statements.push({
      sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
            VALUES (?,?,'project.costs.replace','project',?,?,?,?)`,
      params: [input.auditId, input.actorId, input.projectId, JSON.stringify({ version: input.expectedVersion }), JSON.stringify(input.auditAfter), input.now],
    }, {
      sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (?,?,?,?,?,200,?)`,
      params: [input.idempotencyKey, input.actorId, input.operation, input.requestHash, input.responseJson, input.now],
    });
    await this.database.batch(statements);
  }

  async replaceCategoryAllocations(input: ReplaceProjectCategoryAllocationsRecord): Promise<void> {
    const statements: DatabaseStatement[] = [{
      sql: `UPDATE projects
            SET status='draft',version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END
            WHERE id=?`,
      params: [input.expectedVersion, input.now, input.projectId],
    }, {
      sql: 'DELETE FROM category_cost_allocations WHERE project_id=?',
      params: [input.projectId],
    }];
    for (const allocation of input.allocations) {
      statements.push({
        sql: `INSERT INTO category_cost_allocations (id,project_id,cost_line_id,reserve_category_id,amount_fen,created_at)
              VALUES (?,?,?,?,?,?)`,
        params: [allocation.id, input.projectId, allocation.costLineId, allocation.reserveCategoryId, allocation.amountFen, input.now],
      });
    }
    statements.push({
      sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
            VALUES (?,?,'project.category_allocations.replace','project',?,?,?,?)`,
      params: [input.auditId, input.actorId, input.projectId, JSON.stringify({ version: input.expectedVersion }), JSON.stringify(input.auditAfter), input.now],
    }, {
      sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
            VALUES (?,?,?,?,?,200,?)`,
      params: [input.idempotencyKey, input.actorId, input.operation, input.requestHash, input.responseJson, input.now],
    });
    await this.database.batch(statements);
  }

  async confirm(input: ConfirmProjectRecord): Promise<void> {
    await this.database.batch([
      {
        sql: `UPDATE projects
              SET status='confirmed',reserve_version=reserve_version+1,version=version+1,
                  updated_at=CASE WHEN version=? THEN ? ELSE NULL END
              WHERE id=?`,
        params: [input.expectedVersion, input.now, input.projectId],
      },
      {
        sql: `INSERT INTO project_versions
              (id,project_id,reserve_version,snapshot_json,known_amount_fen,missing_price_count,completeness_basis_points,reason,confirmed_by,confirmed_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
        params: [
          input.versionId,
          input.projectId,
          input.reserveVersion,
          JSON.stringify(input.snapshot),
          input.knownAmountFen,
          input.missingPriceCount,
          input.completenessBasisPoints,
          input.reason,
          input.actorId,
          input.now,
        ],
      },
      {
        sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
              VALUES (?,?,'project.confirm','project',?,?,?,?)`,
        params: [
          input.auditId,
          input.actorId,
          input.projectId,
          JSON.stringify({ version: input.expectedVersion, reserveVersion: input.reserveVersion - 1 }),
          JSON.stringify(input.auditAfter),
          input.now,
        ],
      },
      {
        sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
              VALUES (?,?,?,?,?,200,?)`,
        params: [input.idempotencyKey, input.actorId, input.operation, input.requestHash, input.responseJson, input.now],
      },
    ]);
  }

  async findAllocationFailure(allocations: readonly Pick<ProjectAllocationWrite, 'demandMaterialId' | 'quantityScaled'>[]): Promise<AllocationFailure | null> {
    for (const allocation of allocations) {
      const row = await this.database.first<{ original_quantity_scaled: number; allocated_quantity_scaled: number }>({
        sql: `SELECT dm.quantity_scaled AS original_quantity_scaled,
                     COALESCE(SUM(da.quantity_scaled),0) AS allocated_quantity_scaled
              FROM demand_materials dm
              LEFT JOIN demand_allocations da ON da.demand_material_id=dm.id
              WHERE dm.id=? GROUP BY dm.id,dm.quantity_scaled`,
        params: [allocation.demandMaterialId],
      });
      if (!row) return { status: 404, code: 'DEMAND_MATERIAL_NOT_FOUND', message: '需求物资不存在' };
      const remaining = row.original_quantity_scaled - Number(row.allocated_quantity_scaled ?? 0);
      if (remaining < allocation.quantityScaled) {
        return {
          status: 422,
          code: 'ALLOCATION_EXCEEDS_REMAINING',
          message: '分配数量超过需求物资剩余数量',
          details: { demandMaterialId: allocation.demandMaterialId, remainingQuantityScaled: remaining },
        };
      }
    }
    return null;
  }
}
