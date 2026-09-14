import type { AgreementStatus, AgreementSummary } from '@tpm/shared';
import type { DatabasePort } from '../ports/database.ts';
import type { FinanceSummaryFacts, FinanceSummaryRepository } from '../ports/finance-summary-repository.ts';

type AgreementRow = {
  id: string;
  framework_id: string;
  code: string;
  name: string;
  amount_fen: number;
  valid_from: string;
  valid_to: string;
  status: AgreementStatus;
  version: number;
  created_at: string;
  updated_at: string;
};

type AgreementTotalRow = { agreement_id: string; total: number | string };
type AgreementUsedRow = { agreement_id: string; occurrence: number | string; actual: number | string };

function safeInteger(value: unknown): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return value;
    throw new RangeError('finance amount exceeds safe integer range');
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const integer = BigInt(value);
    if (integer <= BigInt(Number.MAX_SAFE_INTEGER) && integer >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(integer);
  }
  throw new RangeError('finance amount exceeds safe integer range');
}

function agreement(row: AgreementRow): AgreementSummary {
  return {
    id: row.id,
    frameworkId: row.framework_id,
    code: row.code,
    name: row.name,
    amountFen: row.amount_fen,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqlFinanceSummaryRepository implements FinanceSummaryRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async getFacts(frameworkId: string, asOf: string): Promise<FinanceSummaryFacts> {
    const [budget, entries, agreementRows, committedRows, usedRows] = await Promise.all([
      this.database.first<{ total: number | string }>({
        sql: `SELECT COALESCE(SUM(bv.total_amount_fen),0) AS total
              FROM project_budgets pb
              INNER JOIN budget_versions bv ON bv.budget_id=pb.id AND bv.budget_version=pb.budget_version
              WHERE bv.framework_id=?`,
        params: [frameworkId],
      }),
      this.database.first<{ budget_occurrence: number | string; actual_cost: number | string }>({
        sql: `SELECT
                COALESCE(SUM(CASE WHEN entry_type='budget_occurrence' THEN amount_fen ELSE 0 END),0) AS budget_occurrence,
                COALESCE(SUM(CASE WHEN entry_type='actual_cost' THEN amount_fen ELSE 0 END),0) AS actual_cost
              FROM financial_entries WHERE framework_id=? AND business_date<=?`,
        params: [frameworkId, asOf],
      }),
      this.database.all<AgreementRow>({
        sql: `SELECT id,framework_id,code,name,amount_fen,valid_from,valid_to,status,version,created_at,updated_at
              FROM agreements WHERE framework_id=? ORDER BY code COLLATE NOCASE,id`,
        params: [frameworkId],
      }),
      this.database.all<AgreementTotalRow>({
        sql: `SELECT bva.agreement_id,COALESCE(SUM(bva.amount_fen),0) AS total
              FROM budget_version_allocations bva
              INNER JOIN budget_versions bv ON bv.id=bva.budget_version_id
              INNER JOIN project_budgets pb ON pb.id=bv.budget_id AND pb.budget_version=bv.budget_version
              WHERE bv.framework_id=? GROUP BY bva.agreement_id`,
        params: [frameworkId],
      }),
      this.database.all<AgreementUsedRow>({
        sql: `SELECT fea.agreement_id,
                     COALESCE(SUM(CASE WHEN fe.entry_type='budget_occurrence' THEN fea.amount_fen ELSE 0 END),0) AS occurrence,
                     COALESCE(SUM(CASE WHEN fe.entry_type='actual_cost' THEN fea.amount_fen ELSE 0 END),0) AS actual
              FROM financial_entry_allocations fea
              INNER JOIN financial_entries fe ON fe.id=fea.financial_entry_id
              WHERE fe.framework_id=? AND fe.business_date<=?
              GROUP BY fea.agreement_id`,
        params: [frameworkId, asOf],
      }),
    ]);

    const committed = new Map(committedRows.map((row) => [row.agreement_id, safeInteger(row.total)]));
    const used = new Map(usedRows.map((row) => [row.agreement_id, {
      occurrence: safeInteger(row.occurrence),
      actual: safeInteger(row.actual),
    }]));

    return {
      confirmedBudgetFen: safeInteger(budget?.total ?? 0),
      budgetOccurrenceFen: safeInteger(entries?.budget_occurrence ?? 0),
      actualCostFen: safeInteger(entries?.actual_cost ?? 0),
      agreements: agreementRows.map((row) => ({
        agreement: agreement(row),
        budgetCommittedFen: committed.get(row.id) ?? 0,
        budgetOccurrenceFen: used.get(row.id)?.occurrence ?? 0,
        actualCostFen: used.get(row.id)?.actual ?? 0,
      })),
    };
  }
}
