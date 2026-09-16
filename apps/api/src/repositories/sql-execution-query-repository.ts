import type { DemandExecutionSummary, LifecycleState, ProjectTaskExecutionSummary, TaskQueueItemSummary, TaskQueueStatus } from '@tpm/shared';
import type { DatabasePort } from '../ports/database.ts';
import type { DemandExecutionAccess, ExecutionProjectHeader, ExecutionQueryRepository, TaskQueueCursor, TaskQueuePageResult } from '../ports/execution-query-repository.ts';

type ProjectTaskRow = {
  id: string; project_id: string; project_release_id: string; name: string; description: string | null; scope_text: string | null;
  owner: string | null; planned_date: string | null; planned_quantity_scaled: number; unit: string; version: number;
  implementation_version: number; settlement_version: number; created_at: string; updated_at: string;
};

type TaskDemandScopeRow = {
  id: string; task_id: string; demand_id: string; planned_quantity_scaled: number; sequence_no: string; line_name: string; section_text: string;
};

type TaskMaterialExecutionRow = {
  id: string; task_id: string; project_material_requirement_id: string | null; material_id: string | null; model: string; unit: string;
  required_quantity_scaled: number; supply_version: number; created_at: string; updated_at: string;
  reported_quantity_scaled: number | string; shipped_quantity_scaled: number | string; arrived_quantity_scaled: number | string;
};

type TaskExecutionAggregateRow = {
  task_id: string; implemented_quantity_scaled: number | string; settled_quantity_scaled: number | string; final_settlement_id: string | null;
  first_implementation_date: string | null; due_date: string | null; reminder_status: 'open' | 'closed' | null; reminder_final_settlement_id: string | null;
};

type DemandExecutionRow = {
  demand_id: string; sequence_no: string; line_name: string; section_text: string; planned_quantity_scaled: number | string;
  implemented_quantity_scaled: number | string; settled_quantity_scaled: number | string; task_count: number | string; tasks_without_final: number | string;
};

type TaskQueueRow = {
  id: string; project_id: string; project_name: string; project_year: number | null; project_owner: string | null;
  name: string; scope_text: string | null; owner: string | null; planned_date: string | null; planned_quantity_scaled: number; unit: string;
  implemented_quantity_scaled: number | string; settled_quantity_scaled: number | string; final_settlement_id: string | null;
  first_implementation_date: string | null; due_date: string | null; reminder_status: 'open' | 'closed' | null; reminder_final_settlement_id: string | null;
  created_at: string; updated_at: string;
};

type TaskQueueSupplyRow = {
  task_id: string; task_material_requirement_id: string; model: string; unit: string;
  reported_quantity_scaled: number | string; shipped_quantity_scaled: number | string; arrived_quantity_scaled: number | string;
};

function lifecycleState(implemented: boolean, settled: boolean): LifecycleState {
  if (implemented && settled) return 'implemented_settled';
  if (implemented) return 'implemented_unsettled';
  if (settled) return 'unimplemented_settled';
  return 'unimplemented_unsettled';
}

function mapDemandExecution(row: DemandExecutionRow): DemandExecutionSummary {
  const plannedQuantityScaled = Number(row.planned_quantity_scaled ?? 0);
  const implementedQuantityScaled = Number(row.implemented_quantity_scaled ?? 0);
  const settledQuantityScaled = Number(row.settled_quantity_scaled ?? 0);
  const hasTasks = Number(row.task_count ?? 0) > 0;
  const implementationComplete = hasTasks && implementedQuantityScaled >= plannedQuantityScaled;
  const settlementComplete = hasTasks && settledQuantityScaled >= plannedQuantityScaled && Number(row.tasks_without_final ?? 0) === 0;
  return {
    demandId: row.demand_id,
    sequenceNo: row.sequence_no,
    lineName: row.line_name,
    section: row.section_text,
    plannedQuantityScaled,
    implementedQuantityScaled,
    settledQuantityScaled,
    implementationProgressBasisPoints: plannedQuantityScaled > 0 ? Math.min(10000, Math.floor((implementedQuantityScaled * 10000) / plannedQuantityScaled)) : 0,
    settlementProgressBasisPoints: plannedQuantityScaled > 0 ? Math.min(10000, Math.floor((settledQuantityScaled * 10000) / plannedQuantityScaled)) : 0,
    implementationComplete,
    settlementComplete,
    state: lifecycleState(implementationComplete, settlementComplete),
  };
}

const demandExecutionSql = `
  WITH target(demand_id) AS (VALUES (?)),
  planned AS (
    SELECT tds.demand_id,SUM(tds.planned_quantity_scaled) AS total,COUNT(DISTINCT tds.task_id) AS task_count,
           COUNT(DISTINCT CASE WHEN NOT EXISTS (
             SELECT 1 FROM task_settlements ts WHERE ts.task_id=tds.task_id AND ts.final=1 AND ts.voided_at IS NULL
           ) THEN tds.task_id END) AS tasks_without_final
    FROM task_demand_scopes tds INNER JOIN target t ON t.demand_id=tds.demand_id GROUP BY tds.demand_id
  ), implemented AS (
    SELECT tds.demand_id,SUM(til.completed_quantity_scaled) AS total
    FROM task_implementation_scope_lines til
    INNER JOIN task_demand_scopes tds ON tds.id=til.task_demand_scope_id
    INNER JOIN target t ON t.demand_id=tds.demand_id
    GROUP BY tds.demand_id
  ), settled AS (
    SELECT tds.demand_id,SUM(tsl.quantity_scaled) AS total
    FROM task_settlement_scope_lines tsl
    INNER JOIN task_demand_scopes tds ON tds.id=tsl.task_demand_scope_id
    INNER JOIN task_settlements ts ON ts.id=tsl.settlement_id AND ts.voided_at IS NULL
    INNER JOIN target t ON t.demand_id=tds.demand_id
    GROUP BY tds.demand_id
  )
  SELECT d.id AS demand_id,d.sequence_no,d.line_name,d.section_text,
         COALESCE(p.total,0) AS planned_quantity_scaled,
         COALESCE(i.total,0) AS implemented_quantity_scaled,
         COALESCE(s.total,0) AS settled_quantity_scaled,
         COALESCE(p.task_count,0) AS task_count,
         COALESCE(p.tasks_without_final,0) AS tasks_without_final
  FROM demands d
  INNER JOIN target t ON t.demand_id=d.id
  LEFT JOIN planned p ON p.demand_id=d.id
  LEFT JOIN implemented i ON i.demand_id=d.id
  LEFT JOIN settled s ON s.demand_id=d.id
  LIMIT 1`;

export class SqlExecutionQueryRepository implements ExecutionQueryRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async findProjectHeader(projectId: string): Promise<ExecutionProjectHeader | null> {
    const row = await this.database.first<{ id: string; framework_id: string | null; version: number; released: number }>({
      sql: `SELECT p.id,p.framework_id,p.version,
                   CASE WHEN EXISTS (SELECT 1 FROM project_releases pr WHERE pr.project_id=p.id) THEN 1 ELSE 0 END AS released
            FROM projects p WHERE p.id=? LIMIT 1`,
      params: [projectId],
    });
    return row ? { id: row.id, frameworkId: row.framework_id, version: row.version, released: row.released === 1 } : null;
  }

  async listProjectTasks(projectId: string): Promise<readonly ProjectTaskExecutionSummary[]> {
    const [tasks, scopes, materials, aggregates] = await Promise.all([
      this.database.all<ProjectTaskRow>({
        sql: `SELECT id,project_id,project_release_id,name,description,scope_text,owner,planned_date,planned_quantity_scaled,unit,version,implementation_version,settlement_version,created_at,updated_at
              FROM project_tasks WHERE project_id=? ORDER BY created_at,id`, params: [projectId],
      }),
      this.database.all<TaskDemandScopeRow>({
        sql: `SELECT tds.id,tds.task_id,tds.demand_id,tds.planned_quantity_scaled,d.sequence_no,d.line_name,d.section_text
              FROM task_demand_scopes tds INNER JOIN project_tasks pt ON pt.id=tds.task_id INNER JOIN demands d ON d.id=tds.demand_id
              WHERE pt.project_id=? ORDER BY tds.task_id,tds.id`, params: [projectId],
      }),
      this.database.all<TaskMaterialExecutionRow>({
        sql: `WITH supply AS (
                SELECT mse.task_material_requirement_id,
                       SUM(CASE WHEN mse.stage='reported' THEN mse.quantity_scaled ELSE 0 END) AS reported_quantity_scaled,
                       SUM(CASE WHEN mse.stage='shipped' THEN mse.quantity_scaled ELSE 0 END) AS shipped_quantity_scaled,
                       SUM(CASE WHEN mse.stage='arrived' THEN mse.quantity_scaled ELSE 0 END) AS arrived_quantity_scaled
                FROM material_supply_events mse
                INNER JOIN task_material_requirements tmr0 ON tmr0.id=mse.task_material_requirement_id
                INNER JOIN project_tasks pt0 ON pt0.id=tmr0.task_id
                WHERE pt0.project_id=? GROUP BY mse.task_material_requirement_id
              )
              SELECT tmr.id,tmr.task_id,tmr.project_material_requirement_id,tmr.material_id,tmr.model,tmr.unit,tmr.required_quantity_scaled,
                     tmr.supply_version,tmr.created_at,tmr.updated_at,COALESCE(s.reported_quantity_scaled,0) AS reported_quantity_scaled,
                     COALESCE(s.shipped_quantity_scaled,0) AS shipped_quantity_scaled,COALESCE(s.arrived_quantity_scaled,0) AS arrived_quantity_scaled
              FROM task_material_requirements tmr INNER JOIN project_tasks pt ON pt.id=tmr.task_id
              LEFT JOIN supply s ON s.task_material_requirement_id=tmr.id WHERE pt.project_id=? ORDER BY tmr.task_id,tmr.id`, params: [projectId, projectId],
      }),
      this.database.all<TaskExecutionAggregateRow>({
        sql: `WITH implementation AS (
                SELECT tir.task_id,SUM(tir.completed_quantity_scaled) AS total FROM task_implementation_records tir
                INNER JOIN project_tasks pt0 ON pt0.id=tir.task_id WHERE pt0.project_id=? GROUP BY tir.task_id
              ), settlement AS (
                SELECT ts.task_id,SUM(ts.coverage_quantity_scaled) AS total FROM task_settlements ts
                INNER JOIN project_tasks pt1 ON pt1.id=ts.task_id WHERE pt1.project_id=? AND ts.voided_at IS NULL GROUP BY ts.task_id
              ), final_settlement AS (
                SELECT task_id,id,ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY settlement_date DESC,created_at DESC,id DESC) AS row_number
                FROM task_settlements WHERE final=1 AND voided_at IS NULL
              )
              SELECT pt.id AS task_id,COALESCE(i.total,0) AS implemented_quantity_scaled,COALESCE(s.total,0) AS settled_quantity_scaled,
                     fs.id AS final_settlement_id,r.first_implementation_date,r.due_date,r.status AS reminder_status,r.final_settlement_id AS reminder_final_settlement_id
              FROM project_tasks pt LEFT JOIN implementation i ON i.task_id=pt.id LEFT JOIN settlement s ON s.task_id=pt.id
              LEFT JOIN final_settlement fs ON fs.task_id=pt.id AND fs.row_number=1 LEFT JOIN task_settlement_reminders r ON r.task_id=pt.id
              WHERE pt.project_id=?`, params: [projectId, projectId, projectId],
      }),
    ]);
    const scopesByTask = new Map<string, TaskDemandScopeRow[]>();
    for (const scope of scopes) { const list = scopesByTask.get(scope.task_id) ?? []; list.push(scope); scopesByTask.set(scope.task_id, list); }
    const materialsByTask = new Map<string, TaskMaterialExecutionRow[]>();
    for (const material of materials) { const list = materialsByTask.get(material.task_id) ?? []; list.push(material); materialsByTask.set(material.task_id, list); }
    const aggregateByTask = new Map(aggregates.map((row) => [row.task_id, row]));
    return tasks.map((task) => {
      const aggregate = aggregateByTask.get(task.id);
      const implementedQuantityScaled = Number(aggregate?.implemented_quantity_scaled ?? 0);
      const settledQuantityScaled = Number(aggregate?.settled_quantity_scaled ?? 0);
      const implementationComplete = implementedQuantityScaled >= task.planned_quantity_scaled;
      const settlementComplete = settledQuantityScaled >= task.planned_quantity_scaled && Boolean(aggregate?.final_settlement_id);
      const taskMaterials = materialsByTask.get(task.id) ?? [];
      return {
        id: task.id, projectId: task.project_id, projectReleaseId: task.project_release_id, name: task.name, description: task.description,
        scopeText: task.scope_text, owner: task.owner, plannedDate: task.planned_date, plannedQuantityScaled: task.planned_quantity_scaled, unit: task.unit,
        version: task.version, implementationVersion: task.implementation_version, settlementVersion: task.settlement_version,
        demandScopes: (scopesByTask.get(task.id) ?? []).map((scope) => ({ id: scope.id, taskId: scope.task_id, demandId: scope.demand_id, plannedQuantityScaled: scope.planned_quantity_scaled, demand: { sequenceNo: scope.sequence_no, lineName: scope.line_name, section: scope.section_text } })),
        materials: taskMaterials.map((material) => ({ id: material.id, taskId: material.task_id, projectMaterialRequirementId: material.project_material_requirement_id, materialId: material.material_id, model: material.model, unit: material.unit, requiredQuantityScaled: material.required_quantity_scaled, supplyVersion: material.supply_version, createdAt: material.created_at, updatedAt: material.updated_at })),
        supplyTotals: taskMaterials.map((material) => ({ taskMaterialRequirementId: material.id, model: material.model, unit: material.unit, totals: { reportedQuantityScaled: Number(material.reported_quantity_scaled ?? 0), shippedQuantityScaled: Number(material.shipped_quantity_scaled ?? 0), arrivedQuantityScaled: Number(material.arrived_quantity_scaled ?? 0) } })),
        implementedQuantityScaled, settledQuantityScaled, implementationComplete, settlementComplete,
        state: lifecycleState(implementationComplete, settlementComplete),
        settlementReminder: aggregate?.first_implementation_date
          ? { needed: aggregate.reminder_status === 'open', firstImplementationDate: aggregate.first_implementation_date, dueDate: aggregate.due_date, finalSettlementId: aggregate.reminder_final_settlement_id }
          : { needed: false, firstImplementationDate: null, dueDate: null, finalSettlementId: aggregate?.final_settlement_id ?? null },
        createdAt: task.created_at, updatedAt: task.updated_at,
      };
    });
  }

  async listTaskQueue(input: {
    memberId: string;
    unrestricted: boolean;
    query: string;
    status: TaskQueueStatus;
    plannedBefore?: string | null;
    cursor: TaskQueueCursor | null;
    limit: number;
  }): Promise<TaskQueuePageResult> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (!input.unrestricted) {
      where.push(`EXISTS (
        SELECT 1 FROM member_scopes ms
        WHERE ms.member_id=? AND (
          ms.scope_type='all'
          OR (ms.scope_type='project' AND ms.scope_id=pt.project_id)
          OR (ms.scope_type='framework' AND ms.scope_id=p.framework_id)
        )
      )`);
      params.push(input.memberId);
    }
    const search = input.query.trim().toLowerCase();
    if (search) {
      where.push(`(
        LOWER(pt.name) LIKE ? OR LOWER(p.name) LIKE ?
        OR LOWER(COALESCE(pt.scope_text,'')) LIKE ? OR LOWER(COALESCE(pt.owner,'')) LIKE ?
      )`);
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    if (input.plannedBefore) {
      where.push(`pt.planned_date IS NOT NULL AND pt.planned_date<=?`);
      params.push(input.plannedBefore);
    }
    if (input.status === 'implementation_pending') {
      where.push(`COALESCE(implementation.total,0)<pt.planned_quantity_scaled`);
    } else if (input.status === 'settlement_pending') {
      where.push(`COALESCE(implementation.total,0)>0 AND (COALESCE(settlement.total,0)<pt.planned_quantity_scaled OR final_settlement.id IS NULL)`);
    }
    if (input.cursor) {
      where.push(`(
        COALESCE(pt.planned_date,'9999-12-31')>?
        OR (COALESCE(pt.planned_date,'9999-12-31')=? AND pt.created_at>?)
        OR (COALESCE(pt.planned_date,'9999-12-31')=? AND pt.created_at=? AND pt.id>?)
      )`);
      params.push(input.cursor.plannedKey, input.cursor.plannedKey, input.cursor.createdAt,
        input.cursor.plannedKey, input.cursor.createdAt, input.cursor.id);
    }
    params.push(input.limit + 1);
    const rows = await this.database.all<TaskQueueRow>({
      sql: `WITH implementation AS (
              SELECT task_id,SUM(completed_quantity_scaled) AS total FROM task_implementation_records GROUP BY task_id
            ), settlement AS (
              SELECT task_id,SUM(coverage_quantity_scaled) AS total FROM task_settlements WHERE voided_at IS NULL GROUP BY task_id
            ), final_settlement AS (
              SELECT task_id,id,ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY settlement_date DESC,created_at DESC,id DESC) AS row_number
              FROM task_settlements WHERE final=1 AND voided_at IS NULL
            )
            SELECT pt.id,pt.project_id,p.name AS project_name,p.year AS project_year,p.owner AS project_owner,
                   pt.name,pt.scope_text,pt.owner,pt.planned_date,pt.planned_quantity_scaled,pt.unit,
                   COALESCE(implementation.total,0) AS implemented_quantity_scaled,
                   COALESCE(settlement.total,0) AS settled_quantity_scaled,
                   final_settlement.id AS final_settlement_id,
                   reminder.first_implementation_date,reminder.due_date,reminder.status AS reminder_status,
                   reminder.final_settlement_id AS reminder_final_settlement_id,
                   pt.created_at,pt.updated_at
            FROM project_tasks pt
            INNER JOIN projects p ON p.id=pt.project_id
            LEFT JOIN implementation ON implementation.task_id=pt.id
            LEFT JOIN settlement ON settlement.task_id=pt.id
            LEFT JOIN final_settlement ON final_settlement.task_id=pt.id AND final_settlement.row_number=1
            LEFT JOIN task_settlement_reminders reminder ON reminder.task_id=pt.id
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY COALESCE(pt.planned_date,'9999-12-31'),pt.created_at,pt.id
            LIMIT ?`,
      params,
    });
    const hasMore = rows.length > input.limit;
    const selected = rows.slice(0, input.limit);
    if (!selected.length) return { items: [], nextCursor: null };
    const taskIds = selected.map((row) => row.id);
    const placeholders = taskIds.map(() => '?').join(',');
    const supplies = await this.database.all<TaskQueueSupplyRow>({
      sql: `WITH supply AS (
              SELECT task_material_requirement_id,
                     SUM(CASE WHEN stage='reported' THEN quantity_scaled ELSE 0 END) AS reported_quantity_scaled,
                     SUM(CASE WHEN stage='shipped' THEN quantity_scaled ELSE 0 END) AS shipped_quantity_scaled,
                     SUM(CASE WHEN stage='arrived' THEN quantity_scaled ELSE 0 END) AS arrived_quantity_scaled
              FROM material_supply_events
              WHERE task_material_requirement_id IN (
                SELECT id FROM task_material_requirements WHERE task_id IN (${placeholders})
              ) GROUP BY task_material_requirement_id
            )
            SELECT tmr.task_id,tmr.id AS task_material_requirement_id,tmr.model,tmr.unit,
                   COALESCE(supply.reported_quantity_scaled,0) AS reported_quantity_scaled,
                   COALESCE(supply.shipped_quantity_scaled,0) AS shipped_quantity_scaled,
                   COALESCE(supply.arrived_quantity_scaled,0) AS arrived_quantity_scaled
            FROM task_material_requirements tmr
            LEFT JOIN supply ON supply.task_material_requirement_id=tmr.id
            WHERE tmr.task_id IN (${placeholders}) ORDER BY tmr.task_id,tmr.id`,
      params: [...taskIds, ...taskIds],
    });
    const supplyByTask = new Map<string, TaskQueueSupplyRow[]>();
    for (const supply of supplies) {
      const list = supplyByTask.get(supply.task_id) ?? [];
      list.push(supply);
      supplyByTask.set(supply.task_id, list);
    }
    const items: TaskQueueItemSummary[] = selected.map((row) => {
      const implementedQuantityScaled = Number(row.implemented_quantity_scaled ?? 0);
      const settledQuantityScaled = Number(row.settled_quantity_scaled ?? 0);
      const implementationComplete = implementedQuantityScaled >= row.planned_quantity_scaled;
      const settlementComplete = settledQuantityScaled >= row.planned_quantity_scaled && Boolean(row.final_settlement_id);
      return {
        id: row.id,
        projectId: row.project_id,
        projectName: row.project_name,
        projectYear: row.project_year,
        projectOwner: row.project_owner,
        name: row.name,
        scopeText: row.scope_text,
        owner: row.owner,
        plannedDate: row.planned_date,
        plannedQuantityScaled: row.planned_quantity_scaled,
        unit: row.unit,
        supplyTotals: (supplyByTask.get(row.id) ?? []).map((supply) => ({
          taskMaterialRequirementId: supply.task_material_requirement_id,
          model: supply.model,
          unit: supply.unit,
          totals: {
            reportedQuantityScaled: Number(supply.reported_quantity_scaled ?? 0),
            shippedQuantityScaled: Number(supply.shipped_quantity_scaled ?? 0),
            arrivedQuantityScaled: Number(supply.arrived_quantity_scaled ?? 0),
          },
        })),
        implementedQuantityScaled,
        settledQuantityScaled,
        implementationComplete,
        settlementComplete,
        state: lifecycleState(implementationComplete, settlementComplete),
        settlementReminder: row.first_implementation_date
          ? { needed: row.reminder_status === 'open', firstImplementationDate: row.first_implementation_date, dueDate: row.due_date, finalSettlementId: row.reminder_final_settlement_id }
          : { needed: false, firstImplementationDate: null, dueDate: null, finalSettlementId: row.final_settlement_id },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
    const last = selected.at(-1)!;
    return {
      items,
      nextCursor: hasMore ? { plannedKey: last.planned_date ?? '9999-12-31', createdAt: last.created_at, id: last.id } : null,
    };
  }

  async findDemandExecution(demandId: string): Promise<DemandExecutionAccess | null> {
    const [row, projects] = await Promise.all([
      this.database.first<DemandExecutionRow>({ sql: demandExecutionSql, params: [demandId] }),
      this.database.all<{ id: string; framework_id: string | null }>({
        sql: `SELECT p.id,p.framework_id FROM project_demand_links pdl INNER JOIN projects p ON p.id=pdl.project_id WHERE pdl.demand_id=? ORDER BY p.id`,
        params: [demandId],
      }),
    ]);
    return row ? { summary: mapDemandExecution(row), projects: projects.map((project) => ({ id: project.id, frameworkId: project.framework_id })) } : null;
  }

  async listProjectDemands(projectId: string): Promise<readonly DemandExecutionSummary[]> {
    const rows = await this.database.all<DemandExecutionRow>({
      sql: `WITH target_demands AS (
              SELECT pdl.demand_id FROM project_demand_links pdl WHERE pdl.project_id=?
            ), planned AS (
              SELECT tds.demand_id,SUM(tds.planned_quantity_scaled) AS total,COUNT(DISTINCT tds.task_id) AS task_count,
                     COUNT(DISTINCT CASE WHEN NOT EXISTS (
                       SELECT 1 FROM task_settlements ts WHERE ts.task_id=tds.task_id AND ts.final=1 AND ts.voided_at IS NULL
                     ) THEN tds.task_id END) AS tasks_without_final
              FROM task_demand_scopes tds INNER JOIN target_demands td ON td.demand_id=tds.demand_id GROUP BY tds.demand_id
            ), implemented AS (
              SELECT tds.demand_id,SUM(til.completed_quantity_scaled) AS total FROM task_implementation_scope_lines til
              INNER JOIN task_demand_scopes tds ON tds.id=til.task_demand_scope_id INNER JOIN target_demands td ON td.demand_id=tds.demand_id GROUP BY tds.demand_id
            ), settled AS (
              SELECT tds.demand_id,SUM(tsl.quantity_scaled) AS total FROM task_settlement_scope_lines tsl
              INNER JOIN task_demand_scopes tds ON tds.id=tsl.task_demand_scope_id INNER JOIN task_settlements ts ON ts.id=tsl.settlement_id AND ts.voided_at IS NULL
              INNER JOIN target_demands td ON td.demand_id=tds.demand_id GROUP BY tds.demand_id
            )
            SELECT d.id AS demand_id,d.sequence_no,d.line_name,d.section_text,COALESCE(p.total,0) AS planned_quantity_scaled,
                   COALESCE(i.total,0) AS implemented_quantity_scaled,COALESCE(s.total,0) AS settled_quantity_scaled,
                   COALESCE(p.task_count,0) AS task_count,COALESCE(p.tasks_without_final,0) AS tasks_without_final
            FROM project_demand_links pdl INNER JOIN demands d ON d.id=pdl.demand_id
            LEFT JOIN planned p ON p.demand_id=d.id LEFT JOIN implemented i ON i.demand_id=d.id LEFT JOIN settled s ON s.demand_id=d.id
            WHERE pdl.project_id=? ORDER BY d.sequence_no COLLATE NOCASE,pdl.id`,
      params: [projectId, projectId],
    });
    return rows.map(mapDemandExecution);
  }
}
