import type { DatabasePort, DatabaseStatement } from '../ports/database.ts';
import type { AllocationFailure, CreateProjectRecord, ProjectAllocationWrite, ProjectWriteRepository } from '../ports/project-write-repository.ts';

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
