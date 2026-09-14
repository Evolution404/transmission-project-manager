import type { DatabasePort, DatabaseStatement } from '../ports/database.ts';
import type {
  CreateTaskImplementationRecord,
  TaskImplementationHeader,
  TaskImplementationRepository,
  TaskImplementationValidationState,
} from '../ports/task-implementation-repository.ts';

function auditStatement(input: { id: string; actorId: string; taskId: string; beforeVersion: number; afterVersion: number; completedQuantityScaled: number; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?, 'project_task.implementation','project_task',?,?,?,?)`,
    params: [
      input.id,
      input.actorId,
      input.taskId,
      JSON.stringify({ implementationVersion: input.beforeVersion }),
      JSON.stringify({ implementationVersion: input.afterVersion, completedQuantityScaled: input.completedQuantityScaled }),
      input.now,
    ],
  };
}

function idempotencyStatement(input: { key: string; actorId: string; operation: string; hash: string; responseJson: string; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,?,?,201,?)`,
    params: [input.key, input.actorId, input.operation, input.hash, input.responseJson, input.now],
  };
}

export class SqlTaskImplementationRepository implements TaskImplementationRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async findTaskHeader(taskId: string): Promise<TaskImplementationHeader | null> {
    const row = await this.database.first<{
      id: string; project_id: string; framework_id: string | null; planned_quantity_scaled: number; implementation_version: number;
    }>({
      sql: `SELECT pt.id,pt.project_id,p.framework_id,pt.planned_quantity_scaled,pt.implementation_version
            FROM project_tasks pt INNER JOIN projects p ON p.id=pt.project_id
            WHERE pt.id=? LIMIT 1`,
      params: [taskId],
    });
    return row ? {
      id: row.id,
      projectId: row.project_id,
      frameworkId: row.framework_id,
      plannedQuantityScaled: row.planned_quantity_scaled,
      implementationVersion: row.implementation_version,
    } : null;
  }

  async loadValidationState(taskId: string): Promise<TaskImplementationValidationState> {
    const [aggregate, scopeRows, materialRows] = await Promise.all([
      this.database.first<{
        previous_completed_quantity_scaled: number | string;
        final_settlement_id: string | null;
        first_implementation_date: string | null;
      }>({
        sql: `SELECT
                COALESCE((SELECT SUM(tir.completed_quantity_scaled) FROM task_implementation_records tir WHERE tir.task_id=?),0) AS previous_completed_quantity_scaled,
                (SELECT ts.id FROM task_settlements ts WHERE ts.task_id=? AND ts.final=1 AND ts.voided_at IS NULL ORDER BY ts.id LIMIT 1) AS final_settlement_id,
                (SELECT tsr.first_implementation_date FROM task_settlement_reminders tsr WHERE tsr.task_id=? LIMIT 1) AS first_implementation_date`,
        params: [taskId, taskId, taskId],
      }),
      this.database.all<{
        id: string; planned_quantity_scaled: number; used_quantity_scaled: number | string;
      }>({
        sql: `SELECT tds.id,tds.planned_quantity_scaled,COALESCE(SUM(tisl.completed_quantity_scaled),0) AS used_quantity_scaled
              FROM task_demand_scopes tds
              LEFT JOIN task_implementation_scope_lines tisl ON tisl.task_demand_scope_id=tds.id
              WHERE tds.task_id=?
              GROUP BY tds.id,tds.planned_quantity_scaled
              ORDER BY tds.id`,
        params: [taskId],
      }),
      this.database.all<{
        id: string; required_quantity_scaled: number; used_quantity_scaled: number | string;
      }>({
        sql: `SELECT tmr.id,tmr.required_quantity_scaled,COALESCE(SUM(tmul.quantity_scaled),0) AS used_quantity_scaled
              FROM task_material_requirements tmr
              LEFT JOIN task_material_usage_lines tmul ON tmul.task_material_requirement_id=tmr.id
              WHERE tmr.task_id=?
              GROUP BY tmr.id,tmr.required_quantity_scaled
              ORDER BY tmr.id`,
        params: [taskId],
      }),
    ]);
    return {
      previousCompletedQuantityScaled: Number(aggregate?.previous_completed_quantity_scaled ?? 0),
      finalSettlementId: aggregate?.final_settlement_id ?? null,
      firstImplementationDate: aggregate?.first_implementation_date ?? null,
      scopes: scopeRows.map((row) => ({
        id: row.id,
        plannedQuantityScaled: row.planned_quantity_scaled,
        usedQuantityScaled: Number(row.used_quantity_scaled),
      })),
      materials: materialRows.map((row) => ({
        id: row.id,
        requiredQuantityScaled: row.required_quantity_scaled,
        usedQuantityScaled: Number(row.used_quantity_scaled),
      })),
    };
  }

  async createImplementation(input: CreateTaskImplementationRecord): Promise<void> {
    const item = input.event;
    await this.database.batch([
      {
        sql: `UPDATE project_tasks
              SET implementation_version=implementation_version+1,
                  updated_at=CASE WHEN implementation_version=? THEN ? ELSE NULL END
              WHERE id=?`,
        params: [input.expectedImplementationVersion, item.createdAt, item.taskId],
      },
      {
        sql: `INSERT INTO task_implementation_records
              (id,task_id,record_date,completed_quantity_scaled,note,created_by,created_at)
              VALUES (?,?,?,?,?,?,?)`,
        params: [item.id, item.taskId, item.recordDate, item.completedQuantityScaled, item.note, input.actorId, item.createdAt],
      },
      ...input.scopeWrites.map((line) => ({
        sql: `INSERT INTO task_implementation_scope_lines
              (id,implementation_id,task_demand_scope_id,completed_quantity_scaled,created_at)
              VALUES (?,?,?,?,?)`,
        params: [line.id, item.id, line.taskDemandScopeId, line.completedQuantityScaled, item.createdAt],
      })),
      ...input.usageWrites.map((line) => ({
        sql: `INSERT INTO task_material_usage_lines
              (id,implementation_id,task_material_requirement_id,quantity_scaled,created_at)
              VALUES (?,?,?,?,?)`,
        params: [line.id, item.id, line.taskMaterialRequirementId, line.quantityScaled, item.createdAt],
      })),
      {
        sql: `INSERT INTO task_settlement_reminders (task_id,first_implementation_date,due_date,status,final_settlement_id,updated_at)
              VALUES (?,?,?,?,?,?)
              ON CONFLICT(task_id) DO UPDATE SET
                first_implementation_date=excluded.first_implementation_date,
                due_date=excluded.due_date,
                status=excluded.status,
                final_settlement_id=excluded.final_settlement_id,
                updated_at=excluded.updated_at`,
        params: [item.taskId, input.reminder.firstImplementationDate, input.reminder.dueDate, input.reminder.status, input.reminder.finalSettlementId, item.createdAt],
      },
      auditStatement({
        id: input.auditId,
        actorId: input.actorId,
        taskId: item.taskId,
        beforeVersion: input.expectedImplementationVersion,
        afterVersion: item.implementationVersion,
        completedQuantityScaled: item.completedQuantityScaled,
        now: item.createdAt,
      }),
      idempotencyStatement({
        key: input.idempotencyKey,
        actorId: input.actorId,
        operation: input.operation,
        hash: input.requestHash,
        responseJson: input.responseJson,
        now: item.createdAt,
      }),
    ]);
  }
}
