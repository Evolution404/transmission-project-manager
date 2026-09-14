import type {
  AnalysisRuleSummary,
  MilestoneSummary,
  MonthlyPlanSummary,
  MonthlyReportSummary,
} from '@tpm/shared';
import type { DatabasePort, DatabaseStatement } from '../ports/database';
import type {
  ActiveAlertReference,
  AnalysisAccessScope,
  AnalysisDashboardFacts,
  AnalysisFrameworkFacts,
  AnalysisPlanMeta,
  AnalysisProjectGapFacts,
  AnalysisProjectState,
  AnalysisRepository,
  AnalysisWriteMeta,
  ReserveMaterialFact,
} from '../ports/analysis-repository';

function audit(meta: AnalysisWriteMeta, action: string, objectType: string, objectId: string, before: unknown, after: unknown): DatabaseStatement {
  return {
    sql: `INSERT INTO audit_events (id,actor_member_id,action,object_type,object_id,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?)`,
    params: [meta.auditId, meta.actorId, action, objectType, objectId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), meta.now],
  };
}

function idempotency(meta: AnalysisWriteMeta): DatabaseStatement {
  return {
    sql: `INSERT INTO idempotency_records (idempotency_key,actor_member_id,operation,request_hash,response_json,status_code,created_at) VALUES (?,?,?,?,?,?,?)`,
    params: [meta.idempotencyKey, meta.actorId, meta.operation, meta.requestHash, meta.responseJson, meta.statusCode, meta.now],
  };
}

function rule(row: { id: string; version: number; mode: 'ratio' | 'gap'; threshold_basis_points: number; effective_from: string; created_at: string }): AnalysisRuleSummary {
  return { id: row.id, version: row.version, mode: row.mode, thresholdBasisPoints: row.threshold_basis_points, effectiveFrom: row.effective_from, createdAt: row.created_at };
}

function plan(row: { id: string; project_id: string; business_year: number; month: number; target_amount_fen: number; version: number; created_at: string; updated_at: string }): MonthlyPlanSummary {
  return { id: row.id, projectId: row.project_id, businessYear: row.business_year, month: row.month, targetAmountFen: row.target_amount_fen, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}

function milestone(row: { id: string; business_year: number; title: string; owner: string | null; project_id: string | null; date_precision: 'month' | 'day' | 'unknown'; month: number | null; specific_date: string | null; lead_days_json: string; status: 'open' | 'completed'; version: number; created_at: string; updated_at: string }): MilestoneSummary {
  let leadDays: number[] = [];
  try { leadDays = JSON.parse(row.lead_days_json) as number[]; } catch { leadDays = []; }
  return { id: row.id, businessYear: row.business_year, title: row.title, owner: row.owner, projectId: row.project_id, datePrecision: row.date_precision, month: row.month, specificDate: row.specific_date, leadDays, status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}

function report(row: { id: string; framework_id: string; business_month: string; revision: number; data_cutoff_date: string; rule_version: number; rule_json: string; snapshot_json: string; created_at: string }): MonthlyReportSummary {
  return { id: row.id, frameworkId: row.framework_id, businessMonth: row.business_month, revision: row.revision, dataCutoffDate: row.data_cutoff_date, ruleVersion: row.rule_version, rule: JSON.parse(row.rule_json) as AnalysisRuleSummary, snapshot: JSON.parse(row.snapshot_json) as MonthlyReportSummary['snapshot'], createdAt: row.created_at };
}

function projectAccess(alias: string, access: AnalysisAccessScope) {
  if (access.unrestricted) return { sql: '1=1', params: [] as string[] };
  return {
    sql: `EXISTS (SELECT 1 FROM member_scopes ms WHERE ms.member_id=? AND (ms.scope_type='all' OR (ms.scope_type='project' AND ms.scope_id=${alias}.id) OR (ms.scope_type='framework' AND ms.scope_id=${alias}.framework_id)))`,
    params: [access.memberId],
  };
}

export class SqlAnalysisRepository implements AnalysisRepository {
  private readonly database: DatabasePort;

  constructor(database: DatabasePort) { this.database = database; }

  async currentRule(): Promise<AnalysisRuleSummary | null> {
    const row = await this.database.first<{ id: string; version: number; mode: 'ratio' | 'gap'; threshold_basis_points: number; effective_from: string; created_at: string }>({ sql: `SELECT id,version,mode,threshold_basis_points,effective_from,created_at FROM analysis_rules ORDER BY version DESC LIMIT 1` });
    return row ? rule(row) : null;
  }

  async createRule(input: { current: AnalysisRuleSummary; next: AnalysisRuleSummary; meta: AnalysisWriteMeta }): Promise<void> {
    await this.database.batch([
      { sql: `INSERT INTO analysis_rules (id,version,mode,threshold_basis_points,effective_from,created_by,created_at) VALUES (?,?,?,?,?,?,?)`, params: [input.next.id, input.next.version, input.next.mode, input.next.thresholdBasisPoints, input.next.effectiveFrom, input.meta.actorId, input.next.createdAt] },
      audit(input.meta, 'analysis.rule.create', 'analysis_rule', input.next.id, input.current, input.next),
      idempotency(input.meta),
    ]);
  }

  async findFramework(id: string): Promise<AnalysisFrameworkFacts | null> {
    const row = await this.database.first<{ id: string; code: string; name: string; total_amount_fen: number; annual_target_fen: number | null; start_date: string; end_date: string }>({ sql: `SELECT id,code,name,total_amount_fen,annual_target_fen,start_date,end_date FROM frameworks WHERE id=? LIMIT 1`, params: [id] });
    return row ? { id: row.id, code: row.code, name: row.name, totalAmountFen: row.total_amount_fen, annualTargetFen: row.annual_target_fen, startDate: row.start_date, endDate: row.end_date } : null;
  }

  async listFrameworkIds(): Promise<readonly string[]> {
    const rows = await this.database.all<{ id: string }>({ sql: `SELECT id FROM frameworks ORDER BY id` });
    return rows.map((row) => row.id);
  }

  async planMeta(frameworkId: string, businessYear: number, throughMonth: number): Promise<AnalysisPlanMeta> {
    const row = await this.database.first<{ count_all: number | string; cumulative: number | string }>({
      sql: `SELECT COUNT(*) AS count_all,COALESCE(SUM(CASE WHEN mp.month<=? THEN mp.target_amount_fen ELSE 0 END),0) AS cumulative FROM monthly_plans mp INNER JOIN projects p ON p.id=mp.project_id WHERE p.framework_id=? AND mp.business_year=?`,
      params: [throughMonth, frameworkId, businessYear],
    });
    return { countAll: Number(row?.count_all ?? 0), cumulativeFen: Number(row?.cumulative ?? 0) };
  }

  async actualFrameworkOccurrence(frameworkId: string, businessYear: number, asOf: string): Promise<number> {
    const row = await this.database.first<{ total: number | string }>({ sql: `SELECT COALESCE(SUM(amount_fen),0) AS total FROM financial_entries WHERE framework_id=? AND entry_type='budget_occurrence' AND business_date<=? AND substr(business_date,1,4)=?`, params: [frameworkId, asOf, String(businessYear)] });
    return Number(row?.total ?? 0);
  }

  async projectGapFacts(frameworkId: string, businessYear: number, throughMonth: number, asOf: string): Promise<readonly AnalysisProjectGapFacts[]> {
    const rows = await this.database.all<{ id: string; name: string; planned: number | string; actual: number | string }>({
      sql: `SELECT p.id,p.name,COALESCE((SELECT SUM(mp.target_amount_fen) FROM monthly_plans mp WHERE mp.project_id=p.id AND mp.business_year=? AND mp.month<=?),0) AS planned,COALESCE((SELECT SUM(fe.amount_fen) FROM financial_entries fe WHERE fe.project_id=p.id AND fe.entry_type='budget_occurrence' AND fe.business_date<=? AND substr(fe.business_date,1,4)=?),0) AS actual FROM projects p WHERE p.framework_id=? ORDER BY p.name COLLATE NOCASE,p.id`,
      params: [businessYear, throughMonth, asOf, String(businessYear), frameworkId],
    });
    return rows.map((row) => ({ projectId: row.id, projectName: row.name, plannedToDateFen: Number(row.planned), actualToDateFen: Number(row.actual) }));
  }

  async listPlans(frameworkId: string, businessYear: number): Promise<readonly MonthlyPlanSummary[]> {
    const rows = await this.database.all<{ id: string; project_id: string; business_year: number; month: number; target_amount_fen: number; version: number; created_at: string; updated_at: string }>({ sql: `SELECT mp.id,mp.project_id,mp.business_year,mp.month,mp.target_amount_fen,mp.version,mp.created_at,mp.updated_at FROM monthly_plans mp INNER JOIN projects p ON p.id=mp.project_id WHERE p.framework_id=? AND mp.business_year=? ORDER BY mp.project_id,mp.month`, params: [frameworkId, businessYear] });
    return rows.map(plan);
  }

  async findProject(id: string): Promise<AnalysisProjectState | null> {
    const row = await this.database.first<{ id: string; framework_id: string | null }>({ sql: `SELECT id,framework_id FROM projects WHERE id=? LIMIT 1`, params: [id] });
    return row ? { id: row.id, frameworkId: row.framework_id } : null;
  }

  async findPlan(projectId: string, businessYear: number, month: number): Promise<MonthlyPlanSummary | null> {
    const row = await this.database.first<{ id: string; project_id: string; business_year: number; month: number; target_amount_fen: number; version: number; created_at: string; updated_at: string }>({ sql: `SELECT id,project_id,business_year,month,target_amount_fen,version,created_at,updated_at FROM monthly_plans WHERE project_id=? AND business_year=? AND month=? LIMIT 1`, params: [projectId, businessYear, month] });
    return row ? plan(row) : null;
  }

  async putPlan(input: { previous: MonthlyPlanSummary | null; next: MonthlyPlanSummary; meta: AnalysisWriteMeta }): Promise<void> {
    const write: DatabaseStatement = input.previous
      ? { sql: `UPDATE monthly_plans SET target_amount_fen=?,version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END WHERE id=?`, params: [input.next.targetAmountFen, input.previous.version, input.meta.now, input.previous.id] }
      : { sql: `INSERT INTO monthly_plans (id,project_id,business_year,month,target_amount_fen,version,created_by,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?)`, params: [input.next.id, input.next.projectId, input.next.businessYear, input.next.month, input.next.targetAmountFen, input.meta.actorId, input.meta.now, input.meta.now] };
    await this.database.batch([write, audit(input.meta, 'analysis.plan.put', 'monthly_plan', input.next.id, input.previous, input.next), idempotency(input.meta)]);
  }

  async nextReportRevision(frameworkId: string, businessMonth: string): Promise<number> {
    const row = await this.database.first<{ next_revision: number | string }>({ sql: `SELECT COALESCE(MAX(revision),0)+1 AS next_revision FROM report_snapshots WHERE framework_id=? AND business_month=?`, params: [frameworkId, businessMonth] });
    return Number(row?.next_revision ?? 1);
  }

  async createReport(input: { report: MonthlyReportSummary; meta: AnalysisWriteMeta }): Promise<void> {
    const r = input.report;
    await this.database.batch([
      { sql: `INSERT INTO report_snapshots (id,framework_id,business_month,revision,data_cutoff_date,rule_version,rule_json,snapshot_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, params: [r.id, r.frameworkId, r.businessMonth, r.revision, r.dataCutoffDate, r.ruleVersion, JSON.stringify(r.rule), JSON.stringify(r.snapshot), input.meta.actorId, r.createdAt] },
      audit(input.meta, 'report.monthly.create', 'report_snapshot', r.id, null, { frameworkId: r.frameworkId, businessMonth: r.businessMonth, revision: r.revision, ruleVersion: r.ruleVersion }),
      idempotency(input.meta),
    ]);
  }

  async listReports(frameworkId: string, businessMonth: string): Promise<readonly MonthlyReportSummary[]> {
    const rows = await this.database.all<{ id: string; framework_id: string; business_month: string; revision: number; data_cutoff_date: string; rule_version: number; rule_json: string; snapshot_json: string; created_at: string }>({ sql: `SELECT id,framework_id,business_month,revision,data_cutoff_date,rule_version,rule_json,snapshot_json,created_at FROM report_snapshots WHERE framework_id=? AND business_month=? ORDER BY revision DESC`, params: [frameworkId, businessMonth] });
    return rows.map(report);
  }

  async createMilestone(input: { milestone: MilestoneSummary; meta: AnalysisWriteMeta }): Promise<void> {
    const m = input.milestone;
    await this.database.batch([
      { sql: `INSERT INTO annual_milestones (id,business_year,title,owner,project_id,date_precision,month,specific_date,lead_days_json,status,version,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'open',1,?,?,?)`, params: [m.id, m.businessYear, m.title, m.owner, m.projectId, m.datePrecision, m.month, m.specificDate, JSON.stringify(m.leadDays), input.meta.actorId, m.createdAt, m.updatedAt] },
      audit(input.meta, 'milestone.create', 'milestone', m.id, null, m), idempotency(input.meta),
    ]);
  }

  async listMilestones(): Promise<readonly MilestoneSummary[]> {
    const rows = await this.database.all<{ id: string; business_year: number; title: string; owner: string | null; project_id: string | null; date_precision: 'month' | 'day' | 'unknown'; month: number | null; specific_date: string | null; lead_days_json: string; status: 'open' | 'completed'; version: number; created_at: string; updated_at: string }>({ sql: `SELECT id,business_year,title,owner,project_id,date_precision,month,specific_date,lead_days_json,status,version,created_at,updated_at FROM annual_milestones ORDER BY business_year DESC,month,specific_date,title LIMIT 200` });
    return rows.map(milestone);
  }

  async listOpenMilestones(): Promise<readonly MilestoneSummary[]> {
    const rows = await this.database.all<{ id: string; business_year: number; title: string; owner: string | null; project_id: string | null; date_precision: 'month' | 'day' | 'unknown'; month: number | null; specific_date: string | null; lead_days_json: string; status: 'open' | 'completed'; version: number; created_at: string; updated_at: string }>({ sql: `SELECT id,business_year,title,owner,project_id,date_precision,month,specific_date,lead_days_json,status,version,created_at,updated_at FROM annual_milestones WHERE status='open' ORDER BY id` });
    return rows.map(milestone);
  }

  async findMilestone(id: string): Promise<MilestoneSummary | null> {
    const row = await this.database.first<{ id: string; business_year: number; title: string; owner: string | null; project_id: string | null; date_precision: 'month' | 'day' | 'unknown'; month: number | null; specific_date: string | null; lead_days_json: string; status: 'open' | 'completed'; version: number; created_at: string; updated_at: string }>({ sql: `SELECT id,business_year,title,owner,project_id,date_precision,month,specific_date,lead_days_json,status,version,created_at,updated_at FROM annual_milestones WHERE id=? LIMIT 1`, params: [id] });
    return row ? milestone(row) : null;
  }

  async updateMilestoneStatus(input: { current: MilestoneSummary; status: 'open' | 'completed'; next: MilestoneSummary; meta: AnalysisWriteMeta }): Promise<void> {
    await this.database.batch([
      { sql: `UPDATE annual_milestones SET status=?,version=version+1,updated_at=CASE WHEN version=? THEN ? ELSE NULL END WHERE id=?`, params: [input.status, input.current.version, input.meta.now, input.current.id] },
      audit(input.meta, 'milestone.status', 'milestone', input.current.id, input.current, input.next), idempotency(input.meta),
    ]);
  }

  async reserveMaterialFacts(access: AnalysisAccessScope): Promise<readonly ReserveMaterialFact[]> {
    const filter = projectAccess('p', access);
    const rows = await this.database.all<{ required_quantity_scaled: number; amount_fen: number | null; reserve_category_id: string | null; category_key: string | null; label: string | null }>({
      sql: `SELECT pmr.required_quantity_scaled,pmr.amount_fen,pmr.reserve_category_id,rc.category_key,rc.label
            FROM project_material_requirements pmr
            INNER JOIN projects p ON p.id=pmr.project_id
            LEFT JOIN reserve_categories rc ON rc.id=pmr.reserve_category_id
            WHERE pmr.active=1 AND NOT EXISTS (SELECT 1 FROM project_releases pr WHERE pr.project_id=p.id) AND ${filter.sql}
            ORDER BY pmr.project_id,pmr.id`,
      params: filter.params,
    });
    return rows.map((row) => ({ requiredQuantityScaled: row.required_quantity_scaled, amountFen: row.amount_fen, reserveCategoryId: row.reserve_category_id, categoryKey: row.category_key, label: row.label }));
  }

  async releasedProjectCount(access: AnalysisAccessScope): Promise<number> {
    const filter = projectAccess('p', access);
    const row = await this.database.first<{ count: number | string }>({ sql: `SELECT COUNT(*) AS count FROM projects p WHERE ${filter.sql} AND EXISTS (SELECT 1 FROM project_releases pr WHERE pr.project_id=p.id)`, params: filter.params });
    return Number(row?.count ?? 0);
  }

  async dashboardFacts(access: AnalysisAccessScope): Promise<AnalysisDashboardFacts> {
    const filter = projectAccess('p', access);
    const [projectCount, demandCount, unreleased, pendingSettlement] = await Promise.all([
      this.database.first<{ count: number | string }>({ sql: `SELECT COUNT(*) AS count FROM projects p WHERE ${filter.sql}`, params: filter.params }),
      this.database.first<{ count: number | string }>({ sql: `SELECT COUNT(DISTINCT pdl.demand_id) AS count FROM project_demand_links pdl INNER JOIN projects p ON p.id=pdl.project_id WHERE ${filter.sql}`, params: filter.params }),
      this.database.first<{ count: number | string }>({ sql: `SELECT COUNT(*) AS count FROM projects p WHERE ${filter.sql} AND NOT EXISTS (SELECT 1 FROM project_releases pr WHERE pr.project_id=p.id)`, params: filter.params }),
      this.database.first<{ count: number | string }>({ sql: `SELECT COUNT(*) AS count FROM projects p WHERE ${filter.sql} AND EXISTS (SELECT 1 FROM project_tasks pt INNER JOIN task_implementation_records tir ON tir.task_id=pt.id WHERE pt.project_id=p.id AND NOT EXISTS (SELECT 1 FROM task_settlements ts WHERE ts.task_id=pt.id AND ts.final=1 AND ts.voided_at IS NULL))`, params: filter.params }),
    ]);
    return { projectCount: Number(projectCount?.count ?? 0), demandCount: Number(demandCount?.count ?? 0), unreleasedProjectCount: Number(unreleased?.count ?? 0), pendingSettlementCount: Number(pendingSettlement?.count ?? 0) };
  }

  async activeAlertReferences(): Promise<readonly ActiveAlertReference[]> {
    const rows = await this.database.all<{ object_type: string; object_id: string; milestone_project_id: string | null }>({ sql: `SELECT ae.object_type,ae.object_id,am.project_id AS milestone_project_id FROM alert_events ae LEFT JOIN annual_milestones am ON ae.object_type='milestone' AND am.id=ae.object_id WHERE ae.state='active'` });
    return rows.map((row) => ({ objectType: row.object_type, objectId: row.object_id, milestoneProjectId: row.milestone_project_id }));
  }
}
