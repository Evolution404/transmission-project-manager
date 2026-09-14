import type {
  AgreementStatus,
  AgreementSummary,
  AgreementVersionSummary,
  BudgetAllocationInput,
  BudgetAllocationSummary,
  FinanceProjectSummary,
  FrameworkSummary,
  FrameworkVersionSummary,
} from '@tpm/shared';
import type { DatabasePort } from '../ports/database.ts';
import type { AgreementAllocationValidation, FinanceQueryRepository } from '../ports/finance-query-repository.ts';

type FrameworkRow = {
  id: string; code: string; name: string; total_amount_fen: number; annual_target_fen: number | null;
  start_date: string; end_date: string; version: number; created_at: string; updated_at: string;
};
type FrameworkVersionRow = FrameworkRow & { framework_id: string; reason: string | null };
type AgreementRow = {
  id: string; framework_id: string; code: string; name: string; amount_fen: number; valid_from: string; valid_to: string;
  status: AgreementStatus; version: number; created_at: string; updated_at: string;
};
type AgreementVersionRow = AgreementRow & { agreement_id: string; reason: string | null };
type ProjectRow = {
  id: string; name: string; business_year: number | null; status: 'draft' | 'confirmed'; framework_id: string | null; version: number;
};

function project(row: ProjectRow): FinanceProjectSummary {
  return {
    id: row.id,
    name: row.name,
    year: row.business_year,
    status: row.status,
    frameworkId: row.framework_id,
    version: row.version,
  };
}

function framework(row: FrameworkRow): FrameworkSummary {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    totalAmountFen: row.total_amount_fen,
    annualTargetFen: row.annual_target_fen,
    startDate: row.start_date,
    endDate: row.end_date,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

export class SqlFinanceQueryRepository implements FinanceQueryRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) {
    this.database = database;
  }

  async listProjects(): Promise<readonly FinanceProjectSummary[]> {
    const rows = await this.database.all<ProjectRow>({
      sql: `SELECT id,name,business_year,status,framework_id,version
            FROM projects ORDER BY updated_at DESC,id DESC LIMIT 100`,
    });
    return rows.map(project);
  }

  async findProject(id: string): Promise<FinanceProjectSummary | null> {
    const row = await this.database.first<ProjectRow>({
      sql: `SELECT id,name,business_year,status,framework_id,version FROM projects WHERE id=? LIMIT 1`,
      params: [id],
    });
    return row ? project(row) : null;
  }

  async hasProjectFinanceHistory(id: string): Promise<boolean> {
    const row = await this.database.first<{ count: number }>({
      sql: `SELECT (SELECT COUNT(*) FROM budget_versions WHERE project_id=?) +
                   (SELECT COUNT(*) FROM financial_entries WHERE project_id=?) AS count`,
      params: [id, id],
    });
    return (row?.count ?? 0) > 0;
  }

  async listFrameworks(): Promise<readonly FrameworkSummary[]> {
    const rows = await this.database.all<FrameworkRow>({
      sql: `SELECT id,code,name,total_amount_fen,annual_target_fen,start_date,end_date,version,created_at,updated_at
            FROM frameworks ORDER BY code COLLATE NOCASE,id LIMIT 100`,
    });
    return rows.map(framework);
  }

  async findFramework(id: string): Promise<FrameworkSummary | null> {
    const row = await this.database.first<FrameworkRow>({
      sql: `SELECT id,code,name,total_amount_fen,annual_target_fen,start_date,end_date,version,created_at,updated_at
            FROM frameworks WHERE id=? LIMIT 1`,
      params: [id],
    });
    return row ? framework(row) : null;
  }

  async getFrameworkHistory(id: string): Promise<readonly FrameworkVersionSummary[] | null> {
    if (!(await this.findFramework(id))) return null;
    const rows = await this.database.all<FrameworkVersionRow>({
      sql: `SELECT id,framework_id,version,code,name,total_amount_fen,annual_target_fen,start_date,end_date,reason,created_at
            FROM framework_versions WHERE framework_id=? ORDER BY version DESC`,
      params: [id],
    });
    return rows.map((row) => ({
      id: row.id,
      frameworkId: row.framework_id,
      version: row.version,
      code: row.code,
      name: row.name,
      totalAmountFen: row.total_amount_fen,
      annualTargetFen: row.annual_target_fen,
      startDate: row.start_date,
      endDate: row.end_date,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  async listAgreements(frameworkId: string | null): Promise<readonly AgreementSummary[]> {
    const rows = frameworkId
      ? await this.database.all<AgreementRow>({
          sql: `SELECT id,framework_id,code,name,amount_fen,valid_from,valid_to,status,version,created_at,updated_at
                FROM agreements WHERE framework_id=? ORDER BY code COLLATE NOCASE,id LIMIT 100`,
          params: [frameworkId],
        })
      : await this.database.all<AgreementRow>({
          sql: `SELECT id,framework_id,code,name,amount_fen,valid_from,valid_to,status,version,created_at,updated_at
                FROM agreements ORDER BY code COLLATE NOCASE,id LIMIT 100`,
        });
    return rows.map(agreement);
  }

  async findAgreement(id: string): Promise<AgreementSummary | null> {
    const row = await this.database.first<AgreementRow>({
      sql: `SELECT id,framework_id,code,name,amount_fen,valid_from,valid_to,status,version,created_at,updated_at
            FROM agreements WHERE id=? LIMIT 1`,
      params: [id],
    });
    return row ? agreement(row) : null;
  }

  async getAgreementHistory(id: string): Promise<readonly AgreementVersionSummary[] | null> {
    if (!(await this.findAgreement(id))) return null;
    const rows = await this.database.all<AgreementVersionRow>({
      sql: `SELECT id,agreement_id,version,framework_id,code,name,amount_fen,valid_from,valid_to,status,reason,created_at
            FROM agreement_versions WHERE agreement_id=? ORDER BY version DESC`,
      params: [id],
    });
    return rows.map((row) => ({
      id: row.id,
      agreementId: row.agreement_id,
      version: row.version,
      frameworkId: row.framework_id,
      code: row.code,
      name: row.name,
      amountFen: row.amount_fen,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      status: row.status,
      reason: row.reason,
      createdAt: row.created_at,
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
      sql: `SELECT id,framework_id,code,name,amount_fen,valid_from,valid_to,status,version,created_at,updated_at
            FROM agreements WHERE id IN (${placeholders})`,
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
}
