import type {
  BudgetAllocationInput,
  BudgetAllocationSummary,
  BudgetVersionSummary,
  ProjectBudgetSummary,
} from '@tpm/shared';
import type { DatabasePort, DatabaseStatement } from '../ports/database.ts';
import type {
  AgreementAllocationValidation,
  ConfirmBudgetRecord,
  CreateBudgetRecord,
  FinanceBudgetRepository,
  UpdateBudgetRecord,
} from '../ports/finance-budget-repository.ts';

type BudgetRow = {
  id: string;
  project_id: string;
  project_name: string;
  framework_id: string | null;
  total_amount_fen: number;
  note: string | null;
  status: 'draft' | 'confirmed';
  budget_version: number;
  version: number;
  created_at: string;
  updated_at: string;
};

type AllocationRow = {
  budget_id: string;
  agreement_id: string;
  amount_fen: number;
  code: string;
  name: string;
};

type AgreementRow = {
  id: string;
  framework_id: string;
  code: string;
  name: string;
  valid_from: string;
  valid_to: string;
  status: 'active' | 'paused' | 'expired';
};

type BudgetVersionRow = {
  id: string;
  budget_id: string;
  project_id: string;
  framework_id: string;
  budget_version: number;
  total_amount_fen: number;
  note: string | null;
  confirmed_at: string;
};

type BudgetVersionAllocationRow = {
  budget_version_id: string;
  agreement_id: string;
  amount_fen: number;
  code: string;
  name: string;
};

function auditStatement(input: { id: string; actorId: string; action: string; objectId: string; before: unknown; after: unknown; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    params: [
      input.id,
      input.actorId,
      input.action,
      'budget',
      input.objectId,
      input.before === null ? null : JSON.stringify(input.before),
      input.after === null ? null : JSON.stringify(input.after),
      input.now,
    ],
  };
}

function idempotencyStatement(input: { key: string; actorId: string; operation: string; hash: string; responseJson: string; status: number; now: string }): DatabaseStatement {
  return {
    sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at)
          VALUES (?,?,?,?,?,?,?)`,
    params: [input.key, input.actorId, input.operation, input.hash, input.responseJson, input.status, input.now],
  };
}

function allocationSummary(row: Pick<AllocationRow, 'agreement_id' | 'amount_fen' | 'code' | 'name'>): BudgetAllocationSummary {
  return {
    agreementId: row.agreement_id,
    amountFen: row.amount_fen,
    agreementCode: row.code,
    agreementName: row.name,
  };
}

function buildAllocationMap(rows: readonly AllocationRow[]): Map<string, BudgetAllocationSummary[]> {
  const map = new Map<string, BudgetAllocationSummary[]>();
  for (const row of rows) {
    const list = map.get(row.budget_id) ?? [];
    list.push(allocationSummary(row));
    map.set(row.budget_id, list);
  }
  return map;
}

function budgetSummary(row: BudgetRow, allocations: readonly BudgetAllocationSummary[]): ProjectBudgetSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    frameworkId: row.framework_id,
    totalAmountFen: row.total_amount_fen,
    note: row.note,
    status: row.status,
    budgetVersion: row.budget_version,
    version: row.version,
    allocations: [...allocations],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqlFinanceBudgetRepository implements FinanceBudgetRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async listBudgets(projectId: string | null): Promise<readonly ProjectBudgetSummary[]> {
    const rows = await this.database.all<BudgetRow>({
      sql: `SELECT pb.id,pb.project_id,p.name AS project_name,p.framework_id,pb.total_amount_fen,pb.note,pb.status,
                   pb.budget_version,pb.version,pb.created_at,pb.updated_at
            FROM project_budgets pb INNER JOIN projects p ON p.id=pb.project_id
            WHERE (? IS NULL OR pb.project_id=?)
            ORDER BY pb.updated_at DESC,pb.id DESC LIMIT 100`,
      params: [projectId, projectId],
    });
    if (!rows.length) return [];
    const allocations = await this.database.all<AllocationRow>({
      sql: `SELECT ba.budget_id,ba.agreement_id,ba.amount_fen,a.code,a.name
            FROM budget_allocations ba
            INNER JOIN agreements a ON a.id=ba.agreement_id
            INNER JOIN (
              SELECT id FROM project_budgets
              WHERE (? IS NULL OR project_id=?)
              ORDER BY updated_at DESC,id DESC LIMIT 100
            ) selected ON selected.id=ba.budget_id
            ORDER BY ba.budget_id,a.code COLLATE NOCASE,a.id`,
      params: [projectId, projectId],
    });
    const allocationMap = buildAllocationMap(allocations);
    return rows.map((row) => budgetSummary(row, allocationMap.get(row.id) ?? []));
  }

  async findBudget(id: string): Promise<ProjectBudgetSummary | null> {
    const row = await this.database.first<BudgetRow>({
      sql: `SELECT pb.id,pb.project_id,p.name AS project_name,p.framework_id,pb.total_amount_fen,pb.note,pb.status,
                   pb.budget_version,pb.version,pb.created_at,pb.updated_at
            FROM project_budgets pb INNER JOIN projects p ON p.id=pb.project_id
            WHERE pb.id=? LIMIT 1`,
      params: [id],
    });
    if (!row) return null;
    const allocations = await this.database.all<AllocationRow>({
      sql: `SELECT ba.budget_id,ba.agreement_id,ba.amount_fen,a.code,a.name
            FROM budget_allocations ba INNER JOIN agreements a ON a.id=ba.agreement_id
            WHERE ba.budget_id=? ORDER BY a.code COLLATE NOCASE,a.id`,
      params: [id],
    });
    return budgetSummary(row, allocations.map(allocationSummary));
  }

  async getBudgetHistory(id: string): Promise<readonly BudgetVersionSummary[] | null> {
    const exists = await this.database.first<{ id: string }>({ sql: `SELECT id FROM project_budgets WHERE id=? LIMIT 1`, params: [id] });
    if (!exists) return null;
    const versions = await this.database.all<BudgetVersionRow>({
      sql: `SELECT id,budget_id,project_id,framework_id,budget_version,total_amount_fen,note,confirmed_at
            FROM budget_versions WHERE budget_id=? ORDER BY budget_version DESC`,
      params: [id],
    });
    if (!versions.length) return [];
    const allocationRows = await this.database.all<BudgetVersionAllocationRow>({
      sql: `SELECT bva.budget_version_id,bva.agreement_id,bva.amount_fen,a.code,a.name
            FROM budget_version_allocations bva
            INNER JOIN agreements a ON a.id=bva.agreement_id
            INNER JOIN budget_versions bv ON bv.id=bva.budget_version_id
            WHERE bv.budget_id=?
            ORDER BY bv.budget_version DESC,a.code COLLATE NOCASE,a.id`,
      params: [id],
    });
    const allocations = new Map<string, BudgetAllocationSummary[]>();
    for (const row of allocationRows) {
      const list = allocations.get(row.budget_version_id) ?? [];
      list.push(allocationSummary(row));
      allocations.set(row.budget_version_id, list);
    }
    return versions.map((row) => ({
      id: row.id,
      budgetId: row.budget_id,
      projectId: row.project_id,
      frameworkId: row.framework_id,
      budgetVersion: row.budget_version,
      totalAmountFen: row.total_amount_fen,
      note: row.note,
      confirmedAt: row.confirmed_at,
      allocations: allocations.get(row.id) ?? [],
    }));
  }

  async validateAgreementAllocations(
    frameworkId: string,
    allocations: readonly BudgetAllocationInput[],
    effectiveDate: string | null,
    requireActive: boolean,
  ): Promise<AgreementAllocationValidation> {
    if (!allocations.length) return { ok: true, summaries: [] };
    const placeholders = allocations.map(() => '?').join(',');
    const rows = await this.database.all<AgreementRow>({
      sql: `SELECT id,framework_id,code,name,valid_from,valid_to,status FROM agreements WHERE id IN (${placeholders})`,
      params: allocations.map((item) => item.agreementId),
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const summaries: BudgetAllocationSummary[] = [];
    for (const item of allocations) {
      const agreement = byId.get(item.agreementId);
      if (!agreement) return { ok: false, reason: 'not_found' };
      if (agreement.framework_id !== frameworkId) return { ok: false, reason: 'framework_mismatch' };
      if (requireActive && (agreement.status !== 'active' || (effectiveDate !== null && (effectiveDate < agreement.valid_from || effectiveDate > agreement.valid_to)))) {
        return { ok: false, reason: 'not_effective' };
      }
      summaries.push({ agreementId: agreement.id, amountFen: item.amountFen, agreementCode: agreement.code, agreementName: agreement.name });
    }
    return { ok: true, summaries };
  }

  async createBudget(input: CreateBudgetRecord): Promise<void> {
    const item = input.budget;
    await this.database.batch([
      {
        sql: `INSERT INTO project_budgets
              (id,project_id,total_amount_fen,note,status,budget_version,version,created_by,created_at,updated_at)
              VALUES (?,?,?,?,'draft',0,1,?,?,?)`,
        params: [item.id, item.projectId, item.totalAmountFen, item.note, input.actorId, item.createdAt, item.updatedAt],
      },
      ...input.allocations.map((allocation) => ({
        sql: `INSERT INTO budget_allocations (id,budget_id,agreement_id,amount_fen,created_at) VALUES (?,?,?,?,?)`,
        params: [allocation.id, item.id, allocation.agreementId, allocation.amountFen, item.createdAt],
      })),
      auditStatement({ id: input.auditId, actorId: input.actorId, action: 'budget.create', objectId: item.id, before: null, after: item, now: item.createdAt }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash, responseJson: input.responseJson, status: 201, now: item.createdAt }),
    ]);
  }

  async updateBudget(input: UpdateBudgetRecord): Promise<void> {
    const item = input.next;
    await this.database.batch([
      {
        sql: `UPDATE project_budgets
              SET total_amount_fen=?,note=?,status='draft',version=version+1,
                  updated_at=CASE WHEN version=? THEN ? ELSE NULL END
              WHERE id=?`,
        params: [item.totalAmountFen, item.note, input.expectedVersion, item.updatedAt, item.id],
      },
      { sql: `DELETE FROM budget_allocations WHERE budget_id=?`, params: [item.id] },
      ...input.allocations.map((allocation) => ({
        sql: `INSERT INTO budget_allocations (id,budget_id,agreement_id,amount_fen,created_at) VALUES (?,?,?,?,?)`,
        params: [allocation.id, item.id, allocation.agreementId, allocation.amountFen, item.updatedAt],
      })),
      auditStatement({ id: input.auditId, actorId: input.actorId, action: 'budget.update', objectId: item.id, before: { version: input.expectedVersion, totalAmountFen: input.before.totalAmountFen }, after: item, now: item.updatedAt }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash, responseJson: input.responseJson, status: 200, now: item.updatedAt }),
    ]);
  }

  async confirmBudget(input: ConfirmBudgetRecord): Promise<void> {
    const item = input.next;
    await this.database.batch([
      {
        sql: `UPDATE project_budgets
              SET total_amount_fen=?,note=?,status='confirmed',budget_version=budget_version+1,version=version+1,
                  updated_at=CASE WHEN version=? THEN ? ELSE NULL END
              WHERE id=?`,
        params: [item.totalAmountFen, item.note, input.expectedVersion, item.updatedAt, item.id],
      },
      {
        sql: `INSERT INTO budget_versions
              (id,budget_id,project_id,framework_id,budget_version,total_amount_fen,note,confirmed_by,confirmed_at)
              VALUES (?,?,?,?,?,?,?,?,?)`,
        params: [input.budgetVersionId, item.id, item.projectId, item.frameworkId, item.budgetVersion, item.totalAmountFen, item.note, input.actorId, item.updatedAt],
      },
      ...input.allocations.map((allocation) => ({
        sql: `INSERT INTO budget_version_allocations (id,budget_version_id,agreement_id,amount_fen,created_at) VALUES (?,?,?,?,?)`,
        params: [allocation.id, input.budgetVersionId, allocation.agreementId, allocation.amountFen, item.updatedAt],
      })),
      auditStatement({
        id: input.auditId,
        actorId: input.actorId,
        action: 'budget.confirm',
        objectId: item.id,
        before: { version: input.expectedVersion, budgetVersion: input.before.budgetVersion },
        after: { version: item.version, budgetVersion: item.budgetVersion },
        now: item.updatedAt,
      }),
      idempotencyStatement({ key: input.idempotencyKey, actorId: input.actorId, operation: input.operation, hash: input.requestHash, responseJson: input.responseJson, status: 200, now: item.updatedAt }),
    ]);
  }
}
