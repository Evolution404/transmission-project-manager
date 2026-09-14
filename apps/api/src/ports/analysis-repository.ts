import type {
  AnalysisLagMode,
  AnalysisRuleSummary,
  MilestoneDatePrecision,
  MilestoneStatus,
  MilestoneSummary,
  MonthlyPlanSummary,
  MonthlyReportSummary,
} from '@tpm/shared';

export interface AnalysisFrameworkFacts {
  id: string;
  code: string;
  name: string;
  totalAmountFen: number;
  annualTargetFen: number | null;
  startDate: string;
  endDate: string;
}

export interface AnalysisPlanMeta {
  countAll: number;
  cumulativeFen: number;
}

export interface AnalysisProjectGapFacts {
  projectId: string;
  projectName: string;
  plannedToDateFen: number;
  actualToDateFen: number;
}

export interface AnalysisProjectState {
  id: string;
  frameworkId: string | null;
}

export interface AnalysisAccessScope {
  memberId: string;
  unrestricted: boolean;
}

export interface ReserveMaterialFact {
  requiredQuantityScaled: number;
  amountFen: number | null;
  reserveCategoryId: string | null;
  categoryKey: string | null;
  label: string | null;
}

export interface AnalysisDashboardFacts {
  projectCount: number;
  demandCount: number;
  unreleasedProjectCount: number;
  pendingSettlementCount: number;
}

export interface ActiveAlertReference {
  objectType: string;
  objectId: string;
  milestoneProjectId: string | null;
}

export interface AnalysisWriteMeta {
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
  statusCode: number;
  now: string;
}

export interface AnalysisRepository {
  currentRule(): Promise<AnalysisRuleSummary | null>;
  createRule(input: { current: AnalysisRuleSummary; next: AnalysisRuleSummary; meta: AnalysisWriteMeta }): Promise<void>;
  findFramework(id: string): Promise<AnalysisFrameworkFacts | null>;
  listFrameworkIds(): Promise<readonly string[]>;
  planMeta(frameworkId: string, businessYear: number, throughMonth: number): Promise<AnalysisPlanMeta>;
  actualFrameworkOccurrence(frameworkId: string, businessYear: number, asOf: string): Promise<number>;
  projectGapFacts(frameworkId: string, businessYear: number, throughMonth: number, asOf: string): Promise<readonly AnalysisProjectGapFacts[]>;
  listPlans(frameworkId: string, businessYear: number): Promise<readonly MonthlyPlanSummary[]>;
  findProject(id: string): Promise<AnalysisProjectState | null>;
  findPlan(projectId: string, businessYear: number, month: number): Promise<MonthlyPlanSummary | null>;
  putPlan(input: { previous: MonthlyPlanSummary | null; next: MonthlyPlanSummary; meta: AnalysisWriteMeta }): Promise<void>;
  nextReportRevision(frameworkId: string, businessMonth: string): Promise<number>;
  createReport(input: { report: MonthlyReportSummary; meta: AnalysisWriteMeta }): Promise<void>;
  listReports(frameworkId: string, businessMonth: string): Promise<readonly MonthlyReportSummary[]>;
  createMilestone(input: { milestone: MilestoneSummary; meta: AnalysisWriteMeta }): Promise<void>;
  listMilestones(): Promise<readonly MilestoneSummary[]>;
  listOpenMilestones(): Promise<readonly MilestoneSummary[]>;
  findMilestone(id: string): Promise<MilestoneSummary | null>;
  updateMilestoneStatus(input: { current: MilestoneSummary; status: MilestoneStatus; next: MilestoneSummary; meta: AnalysisWriteMeta }): Promise<void>;
  reserveMaterialFacts(access: AnalysisAccessScope): Promise<readonly ReserveMaterialFact[]>;
  releasedProjectCount(access: AnalysisAccessScope): Promise<number>;
  dashboardFacts(access: AnalysisAccessScope): Promise<AnalysisDashboardFacts>;
  activeAlertReferences(): Promise<readonly ActiveAlertReference[]>;
}

export interface CreateAnalysisRuleInput {
  id: string;
  version: number;
  mode: AnalysisLagMode;
  thresholdBasisPoints: number;
  effectiveFrom: string;
  createdAt: string;
}

export interface CreateMilestoneInput {
  id: string;
  businessYear: number;
  title: string;
  owner: string | null;
  projectId: string | null;
  datePrecision: MilestoneDatePrecision;
  month: number | null;
  specificDate: string | null;
  leadDays: readonly number[];
}
