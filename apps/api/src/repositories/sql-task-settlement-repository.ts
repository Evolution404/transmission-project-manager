import type { DatabasePort, DatabaseStatement } from '../ports/database.ts';
import type {
  CreateTaskSettlementRecord,
  TaskSettlementHeader,
  TaskSettlementRepository,
  TaskSettlementValidationState,
  TaskSettlementVoidState,
  VoidTaskSettlementRecord,
} from '../ports/task-settlement-repository.ts';

function auditStatement(input: { id: string; actorId: string; action: string; objectType: string; objectId: string; before: unknown; after: unknown; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    params: [input.id, input.actorId, input.action, input.objectType, input.objectId, input.before === null ? null : JSON.stringify(input.before), input.after === null ? null : JSON.stringify(input.after), input.now],
  };
}

function idempotencyStatement(input: { key: string; actorId: string; operation: string; hash: string; responseJson: string; status: number; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,?,?,?,?)`,
    params: [input.key, input.actorId, input.operation, input.hash, input.responseJson, input.status, input.now],
  };
}

export class SqlTaskSettlementRepository implements TaskSettlementRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async findTaskHeader(taskId: string): Promise<TaskSettlementHeader | null> {
    const row = await this.database.first<{
      id: string; project_id: string; framework_id: string | null; planned_quantity_scaled: number; settlement_version: number;
    }>({
      sql: `SELECT pt.id,pt.project_id,p.framework_id,pt.planned_quantity_scaled,pt.settlement_version
            FROM project_tasks pt INNER JOIN projects p ON p.id=pt.project_id
            WHERE pt.id=? LIMIT 1`,
      params: [taskId],
    });
    return row ? {
      id: row.id,
      projectId: row.project_id,
      frameworkId: row.framework_id,
      plannedQuantityScaled: row.planned_quantity_scaled,
      settlementVersion: row.settlement_version,
    } : null;
  }

  async loadValidationState(taskId: string): Promise<TaskSettlementValidationState> {
    const [aggregate, scopes] = await Promise.all([
      this.database.first<{ total: number | string }>({
        sql: `SELECT COALESCE(SUM(coverage_quantity_scaled),0) AS total
              FROM task_settlements WHERE task_id=? AND voided_at IS NULL`,
        params: [taskId],
      }),
      this.database.all<{ id: string; planned_quantity_scaled: number; settled_quantity_scaled: number | string }>({
        sql: `SELECT tds.id,tds.planned_quantity_scaled,
                     COALESCE(SUM(CASE WHEN ts.id IS NOT NULL THEN tsl.quantity_scaled ELSE 0 END),0) AS settled_quantity_scaled
              FROM task_demand_scopes tds
              LEFT JOIN task_settlement_scope_lines tsl ON tsl.task_demand_scope_id=tds.id
              LEFT JOIN task_settlements ts ON ts.id=tsl.settlement_id AND ts.voided_at IS NULL
              WHERE tds.task_id=?
              GROUP BY tds.id,tds.planned_quantity_scaled
              ORDER BY tds.id`,
        params: [taskId],
      }),
    ]);
    return {
      previousCoverageQuantityScaled: Number(aggregate?.total ?? 0),
      scopes: scopes.map((row) => ({ id: row.id, plannedQuantityScaled: row.planned_quantity_scaled, settledQuantityScaled: Number(row.settled_quantity_scaled) })),
    };
  }

  async createSettlement(input: CreateTaskSettlementRecord): Promise<void> {
    const item = input.event;
    const statements: DatabaseStatement[] = [
      {
        sql: `UPDATE project_tasks
              SET settlement_version=settlement_version+1,
                  updated_at=CASE WHEN settlement_version=? THEN ? ELSE NULL END
              WHERE id=?`,
        params: [input.expectedSettlementVersion, item.createdAt, item.taskId],
      },
      {
        sql: `INSERT INTO task_settlements
              (id,task_id,settlement_date,coverage_quantity_scaled,amount_fen,final,note,version,voided_at,voided_by,void_reason,created_by,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,1,NULL,NULL,NULL,?,?,?)`,
        params: [item.id, item.taskId, item.settlementDate, item.coverageQuantityScaled, item.amountFen, item.final ? 1 : 0, item.note, input.actorId, item.createdAt, item.updatedAt],
      },
      ...input.coverageWrites.map((line) => ({
        sql: `INSERT INTO task_settlement_scope_lines (id,settlement_id,task_demand_scope_id,quantity_scaled,created_at) VALUES (?,?,?,?,?)`,
        params: [line.id, item.id, line.taskDemandScopeId, line.quantityScaled, item.createdAt],
      })),
      ...input.allocationWrites.map((line) => ({
        sql: `INSERT INTO task_settlement_agreement_allocations (id,settlement_id,agreement_id,amount_fen,created_at) VALUES (?,?,?,?,?)`,
        params: [line.id, item.id, line.agreementId, line.amountFen, item.createdAt],
      })),
    ];
    if (item.final) {
      statements.push({
        sql: `UPDATE task_settlement_reminders SET status='closed',final_settlement_id=?,updated_at=? WHERE task_id=?`,
        params: [item.id, item.createdAt, item.taskId],
      });
    }
    statements.push(
      auditStatement({ id: input.auditId, actorId: input.actorId, action: 'project_task.settlement', objectType: 'project_task', objectId: item.taskId, before: { settlementVersion: input.expectedSettlementVersion }, after: { settlementVersion: item.settlementVersion, coverageQuantityScaled: item.coverageQuantityScaled, final: item.final }, now: item.createdAt }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash, responseJson: input.responseJson, status: 201, now: item.createdAt }),
    );
    await this.database.batch(statements);
  }

  async findVoidState(settlementId: string): Promise<TaskSettlementVoidState | null> {
    const row = await this.database.first<{
      id: string; task_id: string; project_id: string; framework_id: string | null; version: number; settlement_version: number;
      voided_at: string | null; final: number; first_implementation_date: string | null; replacement_final_id: string | null;
    }>({
      sql: `SELECT ts.id,ts.task_id,pt.project_id,p.framework_id,ts.version,pt.settlement_version,ts.voided_at,ts.final,
                   (SELECT MIN(tir.record_date) FROM task_implementation_records tir WHERE tir.task_id=ts.task_id) AS first_implementation_date,
                   (SELECT ts2.id FROM task_settlements ts2 WHERE ts2.task_id=ts.task_id AND ts2.final=1 AND ts2.voided_at IS NULL AND ts2.id<>ts.id ORDER BY ts2.created_at DESC,ts2.id DESC LIMIT 1) AS replacement_final_id
            FROM task_settlements ts
            INNER JOIN project_tasks pt ON pt.id=ts.task_id
            INNER JOIN projects p ON p.id=pt.project_id
            WHERE ts.id=? LIMIT 1`,
      params: [settlementId],
    });
    return row ? {
      id: row.id,
      taskId: row.task_id,
      projectId: row.project_id,
      frameworkId: row.framework_id,
      recordVersion: row.version,
      settlementVersion: row.settlement_version,
      voidedAt: row.voided_at,
      final: row.final === 1,
      firstImplementationDate: row.first_implementation_date,
      replacementFinalId: row.replacement_final_id,
    } : null;
  }

  async voidSettlement(input: VoidTaskSettlementRecord): Promise<void> {
    const statements: DatabaseStatement[] = [
      {
        sql: `UPDATE project_tasks
              SET settlement_version=settlement_version+1,
                  updated_at=CASE WHEN settlement_version=? THEN ? ELSE NULL END
              WHERE id=?`,
        params: [input.expectedSettlementVersion, input.now, input.taskId],
      },
      {
        sql: `UPDATE task_settlements
              SET voided_at=?,voided_by=?,void_reason=?,version=version+1,
                  updated_at=CASE WHEN version=? THEN ? ELSE NULL END
              WHERE id=? AND voided_at IS NULL`,
        params: [input.now, input.actorId, input.reason, input.expectedRecordVersion, input.now, input.settlementId],
      },
    ];
    if (input.final && input.firstImplementationDate) {
      statements.push({
        sql: `UPDATE task_settlement_reminders SET status=?,final_settlement_id=?,updated_at=? WHERE task_id=?`,
        params: [input.replacementFinalId ? 'closed' : 'open', input.replacementFinalId, input.now, input.taskId],
      });
    }
    statements.push(
      auditStatement({ id: input.auditId, actorId: input.actorId, action: 'project_task.settlement.void', objectType: 'task_settlement', objectId: input.settlementId, before: { voidedAt: null }, after: input.responseData, now: input.now }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash, responseJson: input.responseJson, status: 200, now: input.now }),
    );
    await this.database.batch(statements);
  }
}
