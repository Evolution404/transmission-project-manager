import type { DatabasePort, DatabaseStatement } from '../ports/database.ts';
import type { CreateProjectTaskRecord, ProjectTaskMaterialAvailability, ProjectTaskRepository } from '../ports/project-task-repository.ts';

function auditStatement(input: { id: string; actorId: string; objectId: string; after: unknown; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?, 'project_task.create','project_task',?,NULL,?,?)`,
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

export class SqlProjectTaskRepository implements ProjectTaskRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async listLinkedDemandIds(projectId: string): Promise<readonly string[]> {
    const rows = await this.database.all<{ demand_id: string }>({
      sql: `SELECT demand_id FROM project_demand_links WHERE project_id=? ORDER BY demand_id`,
      params: [projectId],
    });
    return rows.map((row) => row.demand_id);
  }

  async listProjectMaterialAvailability(projectId: string): Promise<readonly ProjectTaskMaterialAvailability[]> {
    const rows = await this.database.all<{
      id: string; material_id: string | null; model: string; unit: string; required_quantity_scaled: number; assigned_quantity_scaled: number | string;
    }>({
      sql: `SELECT pmr.id,pmr.material_id,pmr.model,pmr.unit,pmr.required_quantity_scaled,
                   COALESCE(assigned.assigned_quantity_scaled,0) AS assigned_quantity_scaled
            FROM project_material_requirements pmr
            LEFT JOIN (
              SELECT tmr.project_material_requirement_id,COALESCE(SUM(tmr.required_quantity_scaled),0) AS assigned_quantity_scaled
              FROM task_material_requirements tmr
              INNER JOIN project_tasks pt ON pt.id=tmr.task_id
              WHERE pt.project_id=? AND tmr.project_material_requirement_id IS NOT NULL
              GROUP BY tmr.project_material_requirement_id
            ) assigned ON assigned.project_material_requirement_id=pmr.id
            WHERE pmr.project_id=? AND pmr.active=1
            ORDER BY pmr.created_at,pmr.id`,
      params: [projectId, projectId],
    });
    return rows.map((row) => ({
      id: row.id,
      materialId: row.material_id,
      model: row.model,
      unit: row.unit,
      requiredQuantityScaled: row.required_quantity_scaled,
      assignedQuantityScaled: Number(row.assigned_quantity_scaled),
    }));
  }

  async createTask(input: CreateProjectTaskRecord): Promise<void> {
    const item = input.task;
    await this.database.batch([
      {
        sql: `UPDATE projects
              SET version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END
              WHERE id=?`,
        params: [input.expectedProjectVersion, item.updatedAt, item.projectId],
      },
      {
        sql: `INSERT INTO project_tasks
              (id,project_id,project_release_id,name,description,scope_text,owner,planned_date,planned_quantity_scaled,unit,version,implementation_version,settlement_version,created_by,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,1,1,1,?,?,?)`,
        params: [item.id, item.projectId, item.projectReleaseId, item.name, item.description, item.scopeText, item.owner, item.plannedDate,
          item.plannedQuantityScaled, item.unit, input.actorId, item.createdAt, item.updatedAt],
      },
      ...item.demandScopes.map((scope) => ({
        sql: `INSERT INTO task_demand_scopes (id,task_id,demand_id,planned_quantity_scaled,created_at) VALUES (?,?,?,?,?)`,
        params: [scope.id, item.id, scope.demandId, scope.plannedQuantityScaled, item.createdAt],
      })),
      ...item.materials.map((material) => ({
        sql: `INSERT INTO task_material_requirements
              (id,task_id,project_material_requirement_id,material_id,model,unit,required_quantity_scaled,supply_version,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,1,?,?)`,
        params: [material.id, item.id, material.projectMaterialRequirementId, material.materialId, material.model, material.unit,
          material.requiredQuantityScaled, item.createdAt, item.updatedAt],
      })),
      auditStatement({ id: input.auditId, actorId: input.actorId, objectId: item.id, after: item, now: item.createdAt }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash,
        responseJson: input.responseJson, now: item.createdAt }),
    ]);
  }
}
