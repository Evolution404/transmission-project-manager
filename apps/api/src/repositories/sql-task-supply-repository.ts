import type { DatabasePort, DatabaseStatement } from '../ports/database.ts';
import type { CreateSupplyEventRecord, TaskMaterialSupplyState, TaskSupplyRepository } from '../ports/task-supply-repository.ts';

function auditStatement(input: { id: string; actorId: string; objectId: string; before: unknown; after: unknown; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?, 'task_material.supply','task_material_requirement',?,?,?,?)`,
    params: [input.id, input.actorId, input.objectId, JSON.stringify(input.before), JSON.stringify(input.after), input.now],
  };
}

function idempotencyStatement(input: { key: string; actorId: string; operation: string; hash: string; responseJson: string; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,?,?,201,?)`,
    params: [input.key, input.actorId, input.operation, input.hash, input.responseJson, input.now],
  };
}

export class SqlTaskSupplyRepository implements TaskSupplyRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async findSupplyState(taskMaterialRequirementId: string): Promise<TaskMaterialSupplyState | null> {
    const row = await this.database.first<{
      id: string; task_id: string; project_id: string; framework_id: string | null; project_material_requirement_id: string | null;
      material_id: string | null; model: string; unit: string; required_quantity_scaled: number; supply_version: number;
      reported_quantity_scaled: number | string; shipped_quantity_scaled: number | string; arrived_quantity_scaled: number | string;
    }>({
      sql: `SELECT tmr.id,tmr.task_id,pt.project_id,p.framework_id,tmr.project_material_requirement_id,tmr.material_id,tmr.model,tmr.unit,
                   tmr.required_quantity_scaled,tmr.supply_version,
                   COALESCE(SUM(CASE WHEN mse.stage='reported' THEN mse.quantity_scaled ELSE 0 END),0) AS reported_quantity_scaled,
                   COALESCE(SUM(CASE WHEN mse.stage='shipped' THEN mse.quantity_scaled ELSE 0 END),0) AS shipped_quantity_scaled,
                   COALESCE(SUM(CASE WHEN mse.stage='arrived' THEN mse.quantity_scaled ELSE 0 END),0) AS arrived_quantity_scaled
            FROM task_material_requirements tmr
            INNER JOIN project_tasks pt ON pt.id=tmr.task_id
            INNER JOIN projects p ON p.id=pt.project_id
            LEFT JOIN material_supply_events mse ON mse.task_material_requirement_id=tmr.id
            WHERE tmr.id=?
            GROUP BY tmr.id,tmr.task_id,pt.project_id,p.framework_id,tmr.project_material_requirement_id,tmr.material_id,tmr.model,tmr.unit,tmr.required_quantity_scaled,tmr.supply_version
            LIMIT 1`,
      params: [taskMaterialRequirementId],
    });
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.task_id,
      projectId: row.project_id,
      frameworkId: row.framework_id,
      projectMaterialRequirementId: row.project_material_requirement_id,
      materialId: row.material_id,
      model: row.model,
      unit: row.unit,
      requiredQuantityScaled: row.required_quantity_scaled,
      supplyVersion: row.supply_version,
      totals: {
        reportedQuantityScaled: Number(row.reported_quantity_scaled),
        shippedQuantityScaled: Number(row.shipped_quantity_scaled),
        arrivedQuantityScaled: Number(row.arrived_quantity_scaled),
      },
    };
  }

  async createSupplyEvent(input: CreateSupplyEventRecord): Promise<void> {
    const item = input.event;
    await this.database.batch([
      {
        sql: `UPDATE task_material_requirements
              SET supply_version=supply_version+1,updated_at=CASE WHEN supply_version=? THEN ? ELSE NULL END
              WHERE id=?`,
        params: [input.expectedSupplyVersion, item.createdAt, item.taskMaterialRequirementId],
      },
      {
        sql: `INSERT INTO material_supply_events
              (id,task_material_requirement_id,stage,quantity_scaled,event_date,note,created_by,created_at)
              VALUES (?,?,?,?,?,?,?,?)`,
        params: [item.id, item.taskMaterialRequirementId, item.stage, item.quantityScaled, item.eventDate, item.note, input.actorId, item.createdAt],
      },
      auditStatement({ id: input.auditId, actorId: input.actorId, objectId: item.taskMaterialRequirementId, before: input.beforeTotals, after: item.totals, now: item.createdAt }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash, responseJson: input.responseJson, now: item.createdAt }),
    ]);
  }
}
