export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export type HealthResponse = ApiSuccess<{
  service: 'transmission-project-manager';
  stage: 'p6';
}>;

export const MEMBER_ROLES = [
  'admin',
  'project_manager',
  'implementation',
  'finance',
  'readonly',
] as const;

export type MemberRole = (typeof MEMBER_ROLES)[number];
export type ScopeType = 'all' | 'framework' | 'project';

export interface MemberScope {
  type: ScopeType;
  id: string | null;
}

export type MemberLifecycleStatus = 'pending_first_login' | 'active' | 'disabled';

export interface MemberSummary {
  id: string;
  username: string;
  displayName: string;
  role: MemberRole;
  enabled: boolean;
  version: number;
  scopes: MemberScope[];
  invitedAt: string | null;
  firstLoginAt: string | null;
  lastLoginAt: string | null;
  lifecycleStatus: MemberLifecycleStatus;
  mustChangePassword: boolean;
}

export interface CurrentUser extends MemberSummary {
  authSource: 'session';
}

export interface SettingVersion<T = unknown> {
  id: string;
  key: string;
  version: number;
  value: T;
  effectiveFrom: string;
  createdBy: string | null;
  createdAt: string;
}

export interface DictionaryItem<T = unknown> {
  id: string;
  dictionaryKey: string;
  itemKey: string;
  label: string;
  value: T | null;
  enabled: boolean;
  sortOrder: number;
  version: number;
}

export interface UpdateSettingRequest {
  expectedVersion: number | null;
  value: unknown;
  effectiveFrom?: string;
}

export const CREDENTIAL_KDF = {
  algorithm: 'argon2id-v1',
  memoryCostKiB: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
  version: 19,
  saltLength: 16,
} as const;

export interface CredentialKdfDescriptor {
  algorithm: typeof CREDENTIAL_KDF.algorithm;
  salt: string;
  memoryCostKiB: typeof CREDENTIAL_KDF.memoryCostKiB;
  timeCost: typeof CREDENTIAL_KDF.timeCost;
  parallelism: typeof CREDENTIAL_KDF.parallelism;
  hashLength: typeof CREDENTIAL_KDF.hashLength;
  version: typeof CREDENTIAL_KDF.version;
}

export interface DerivedCredentialInput {
  salt: string;
  credential: string;
}

export interface CreateMemberRequest extends DerivedCredentialInput {
  username: string;
  displayName: string;
  role: MemberRole;
  enabled?: boolean;
  scopes: MemberScope[];
}

export interface UpdateMemberRequest {
  expectedVersion: number;
  displayName?: string;
  role?: MemberRole;
  enabled?: boolean;
  scopes?: MemberScope[];
}

export interface BootstrapAdminRequest extends DerivedCredentialInput {
  username: string;
  displayName: string;
}

export interface LoginKdfRequest {
  username: string;
}

export interface LoginRequest {
  username: string;
  credential: string;
}

export interface ChangePasswordRequest {
  currentCredential: string;
  next: DerivedCredentialInput;
}

export type ResetPasswordRequest = DerivedCredentialInput;

export type ImportFileType = 'xlsx' | 'csv';
export type ImportBatchStatus = 'draft' | 'validating' | 'review' | 'ready' | 'publishing' | 'published';

export interface ImportFieldMapping {
  sequenceNo: string;
  voltage: string;
  lineName: string;
  section: string;
  materialModel: string;
  materialQuantity: string;
  unit?: string;
  year?: string;
  category?: string;
  owner?: string;
}

export interface ParsedImportRow {
  sheetName: string;
  rowNumber: number;
  cells: Record<string, string | number | boolean | null>;
}

export interface ImportIssue {
  code: string;
  message: string;
  field?: string;
}

export interface NormalizedImportRow {
  sequenceNo: string;
  voltageRaw: string;
  voltageVerified: string | null;
  lineName: string;
  section: string;
  materialModel: string;
  quantityScaled: number | null;
  unit: string | null;
  year: number | null;
  category: string | null;
  owner: string | null;
  materialId: string | null;
  businessSignature: string | null;
}

export interface ImportRowSummary {
  id: string;
  sheetName: string;
  rowNumber: number;
  status: 'uploaded' | 'valid' | 'error' | 'published';
  normalized: NormalizedImportRow | null;
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

export interface ImportBatchSummary {
  id: string;
  fileName: string;
  fileSha256: string;
  fileType: ImportFileType;
  mapping: ImportFieldMapping;
  status: ImportBatchStatus;
  uploadedRows: number;
  validRows: number;
  errorRows: number;
  warningRows: number;
  publishedRows: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  reused?: boolean;
}

export interface ImportChunkRequest {
  expectedVersion: number;
  chunkIndex: number;
  rows: ParsedImportRow[];
}

export interface ImportChunkResult {
  uploadedRows: number;
  chunkIndex: number;
  version: number;
}

export interface ImportValidateRequest {
  expectedVersion: number;
}

export interface ImportPublishRequest {
  expectedVersion: number;
  limit?: number;
}

export interface ImportPublishResult {
  processed: number;
  publishedRows: number;
  done: boolean;
  version: number;
}

export interface ImportMappingTemplate {
  id: string;
  name: string;
  mapping: ImportFieldMapping;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MaterialSummary {
  id: string;
  code: string | null;
  name: string;
  model: string;
  unit: string;
  enabled: boolean;
  version: number;
}

export interface DemandSummary {
  id: string;
  sequenceNo: string;
  year: number | null;
  voltageRaw: string;
  voltageVerified: string | null;
  lineName: string;
  section: string;
  category: string | null;
  owner: string | null;
  version: number;
  createdAt: string;
}

export interface DemandMaterialInput {
  rawModel: string;
  materialId?: string | null;
  quantityScaled: number;
  unit?: string | null;
}

export interface CreateDemandRequest {
  sequenceNo: string;
  voltage: string;
  lineName: string;
  section: string;
  materials?: DemandMaterialInput[];
  materialModel?: string;
  materialQuantity?: string | number;
  unit?: string | null;
  year?: number | string | null;
  category?: string | null;
  owner?: string | null;
}

export type DemandSourceSummary =
  | {
      type: 'import';
      batchId: string;
      fileName: string;
      fileSha256: string;
      sheetName: string;
      rowNumber: number;
      raw: Record<string, unknown>;
      rows?: Array<{
        fileName: string;
        fileSha256: string;
        sheetName: string;
        rowNumber: number;
        raw: Record<string, unknown>;
      }>;
    }
  | {
      type: 'manual';
      raw: Record<string, unknown>;
    };

export interface DemandMaterialSummary {
  id: string;
  rawModel: string;
  quantityScaled: number;
  unit: string | null;
  material: MaterialSummary | null;
  version?: number;
}

export interface DemandDetail extends DemandSummary {
  source: DemandSourceSummary;
  materials: DemandMaterialSummary[];
}

export interface ProjectDemandLinkSummary {
  id: string;
  demandId: string;
  sequenceNo: string;
  year: number | null;
  voltage: string;
  lineName: string;
  section: string;
  category: string | null;
  owner: string | null;
  createdAt: string;
}

export interface ProjectMaterialRequirementSummary {
  id: string;
  projectId: string;
  materialId: string | null;
  model: string;
  unit: string;
  requiredQuantityScaled: number;
  unitPriceScaled: number | null;
  amountFen: number | null;
  reserveCategoryId: string | null;
  reserveCategory: { id: string; key: string; label: string } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReserveProjectSummary {
  id: string;
  name: string;
  year: number | null;
  owner: string | null;
  status: 'draft' | 'confirmed';
  reserveVersion: number;
  frameworkId: string | null;
  version: number;
  demandLinks: ProjectDemandLinkSummary[];
  materialRequirements: ProjectMaterialRequirementSummary[];
  knownMaterialAmountFen: number;
  missingPriceCount: number;
  materialPriceCompletenessBasisPoints: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectReleaseSummary {
  id: string;
  projectId: string;
  releaseDate: string;
  note: string | null;
  projectVersionSnapshot: number;
  reserveVersionSnapshot: number;
  projectVersion: number;
  snapshot: {
    demandLinks: ProjectDemandLinkSummary[];
    materialRequirements: ProjectMaterialRequirementSummary[];
    projectVersion: number;
    reserveVersion: number;
  };
  createdAt: string;
}

export interface TaskDemandScopeSummary {
  id: string;
  taskId: string;
  demandId: string;
  plannedQuantityScaled: number;
  demand?: { sequenceNo: string; lineName: string; section: string };
}

export interface TaskMaterialRequirementSummary {
  id: string;
  taskId: string;
  projectMaterialRequirementId: string | null;
  materialId: string | null;
  model: string;
  unit: string;
  requiredQuantityScaled: number;
  supplyVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskMaterialSupplyTotals {
  taskMaterialRequirementId: string;
  model: string;
  unit: string;
  totals: {
    reportedQuantityScaled: number;
    shippedQuantityScaled: number;
    arrivedQuantityScaled: number;
  };
}

export interface DemandExecutionSummary {
  demandId: string;
  sequenceNo: string;
  lineName: string;
  section: string;
  plannedQuantityScaled: number;
  implementedQuantityScaled: number;
  settledQuantityScaled: number;
  implementationProgressBasisPoints: number;
  settlementProgressBasisPoints: number;
  implementationComplete: boolean;
  settlementComplete: boolean;
  state: LifecycleState;
}

export interface ProjectTaskExecutionSummary {
  id: string;
  projectId: string;
  projectReleaseId: string;
  name: string;
  description: string | null;
  scopeText: string | null;
  owner: string | null;
  plannedDate: string | null;
  plannedQuantityScaled: number;
  unit: string;
  version: number;
  implementationVersion: number;
  settlementVersion: number;
  demandScopes: TaskDemandScopeSummary[];
  materials: TaskMaterialRequirementSummary[];
  supplyTotals: TaskMaterialSupplyTotals[];
  implementedQuantityScaled: number;
  settledQuantityScaled: number;
  implementationComplete: boolean;
  settlementComplete: boolean;
  state: LifecycleState;
  settlementReminder: {
    needed: boolean;
    firstImplementationDate: string | null;
    dueDate: string | null;
    finalSettlementId: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ProjectExecutionSummary {
  projectId: string;
  projectVersion: number;
  released: boolean;
  tasks: ProjectTaskExecutionSummary[];
  demands: DemandExecutionSummary[];
  implementationComplete: boolean;
  settlementComplete: boolean;
  projectState: LifecycleState;
}

export type ProjectStatus = 'draft' | 'confirmed';
export type ProjectCostKind = 'material' | 'construction' | 'other';

export interface ProjectAllocationInput {
  demandMaterialId: string;
  quantityScaled: number;
}

export interface CreateProjectRequest {
  name: string;
  year: number | null;
  owner: string | null;
  allocations: ProjectAllocationInput[];
}

export interface ReplaceProjectAllocationsRequest {
  expectedVersion: number;
  allocations: ProjectAllocationInput[];
}

export interface MaterialPriceInput {
  demandAllocationId: string;
  unitPriceScaled: number | null;
  source: string | null;
  priceDate: string | null;
  taxInclusive: boolean | null;
}

export interface FixedCostInput {
  kind: Exclude<ProjectCostKind, 'material'>;
  label: string;
  amountFen: number;
  source: string | null;
  priceDate: string | null;
  taxInclusive: boolean | null;
}

export interface ReplaceProjectCostsRequest {
  expectedVersion: number;
  materialPrices: MaterialPriceInput[];
  fixedCosts: FixedCostInput[];
}

export interface ProjectCostSummary {
  knownAmountFen: number;
  missingPriceCount: number;
  completenessBasisPoints: number;
}

export interface ProjectSummary extends ProjectCostSummary {
  id: string;
  name: string;
  year: number | null;
  owner: string | null;
  status: ProjectStatus;
  reserveVersion: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReserveCandidate {
  demandMaterialId: string;
  demandId: string;
  sequenceNo: string;
  year: number | null;
  category: string | null;
  voltage: string;
  lineName: string;
  section: string;
  rawModel: string;
  unit: string | null;
  material: MaterialSummary | null;
  originalQuantityScaled: number;
  allocatedQuantityScaled: number;
  remainingQuantityScaled: number;
  source: { type: 'import'; fileName: string; sheetName: string; rowNumber: number } | { type: 'manual' };
}

export interface ProjectAllocationDetail {
  id: string;
  demandMaterialId: string;
  quantityScaled: number;
  rawModel: string;
  unit: string | null;
  material: MaterialSummary | null;
  demand: {
    id: string;
    sequenceNo: string;
    year: number | null;
    category: string | null;
    voltage: string;
    lineName: string;
    section: string;
  };
  source: { type: 'import'; fileName: string; sheetName: string; rowNumber: number } | { type: 'manual' };
}

export interface ProjectMaterialSummary {
  materialId: string | null;
  rawModel: string;
  model: string;
  name: string | null;
  unit: string | null;
  quantityScaled: number;
}

export interface ProjectCostLine {
  id: string;
  kind: ProjectCostKind;
  demandAllocationId: string | null;
  label: string;
  unitPriceScaled: number | null;
  amountFen: number | null;
  source: string | null;
  priceDate: string | null;
  taxInclusive: boolean | null;
  suggestedReserveCategoryId: string | null;
}

export interface ReserveCategorySummary {
  id: string;
  key: string;
  label: string;
  enabled: boolean;
  version: number;
}

export interface ProjectCategorySummary {
  reserveCategoryId: string;
  key: string;
  label: string;
  amountFen: number;
}

export interface ProjectCategoryAllocationDetail {
  id: string;
  costLineId: string;
  reserveCategoryId: string;
  amountFen: number;
}

export interface ProjectDetail extends ProjectSummary {
  allocations: ProjectAllocationDetail[];
  materialSummary: ProjectMaterialSummary[];
  costLines: ProjectCostLine[];
  categoryAllocations: ProjectCategoryAllocationDetail[];
  categories: ProjectCategorySummary[];
  classifiedAmountFen: number;
  unclassifiedAmountFen: number;
}

export interface CategoryCostAllocationInput {
  costLineId: string;
  reserveCategoryId: string;
  amountFen: number;
}

export interface ReplaceCategoryAllocationsRequest {
  expectedVersion: number;
  allocations: CategoryCostAllocationInput[];
}

export interface ConfirmProjectRequest {
  expectedVersion: number;
  reason: string | null;
}

export interface ProjectVersionSummary extends ProjectCostSummary {
  id: string;
  projectId: string;
  reserveVersion: number;
  reason: string | null;
  confirmedAt: string;
}

export interface CategoryMappingSummary {
  id: string;
  demandCategory: string;
  reserveCategoryId: string;
  version: number;
}

export type AgreementStatus = 'active' | 'paused' | 'expired';
export type FinancialEntryType = 'budget_occurrence' | 'actual_cost';

export interface FrameworkSummary {
  id: string;
  code: string;
  name: string;
  totalAmountFen: number;
  annualTargetFen: number | null;
  startDate: string;
  endDate: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface FrameworkVersionSummary {
  id: string;
  frameworkId: string;
  version: number;
  code: string;
  name: string;
  totalAmountFen: number;
  annualTargetFen: number | null;
  startDate: string;
  endDate: string;
  reason: string | null;
  createdAt: string;
}

export interface AgreementSummary {
  id: string;
  frameworkId: string;
  code: string;
  name: string;
  amountFen: number;
  validFrom: string;
  validTo: string;
  status: AgreementStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgreementVersionSummary {
  id: string;
  agreementId: string;
  version: number;
  frameworkId: string;
  code: string;
  name: string;
  amountFen: number;
  validFrom: string;
  validTo: string;
  status: AgreementStatus;
  reason: string | null;
  createdAt: string;
}

export interface BindProjectFrameworkRequest {
  expectedVersion: number;
  frameworkId: string;
}

export interface BudgetAllocationInput {
  agreementId: string;
  amountFen: number;
}

export interface BudgetAllocationSummary extends BudgetAllocationInput {
  agreementCode: string;
  agreementName: string;
}

export interface ProjectBudgetSummary {
  id: string;
  projectId: string;
  projectName: string;
  frameworkId: string | null;
  totalAmountFen: number;
  note: string | null;
  status: 'draft' | 'confirmed';
  budgetVersion: number;
  version: number;
  allocations: BudgetAllocationSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateBudgetRequest {
  projectId: string;
  totalAmountFen: number;
  allocations: BudgetAllocationInput[];
  note: string | null;
}

export interface UpdateBudgetRequest {
  expectedVersion: number;
  totalAmountFen: number;
  allocations: BudgetAllocationInput[];
  note: string | null;
}

export interface ConfirmBudgetRequest {
  expectedVersion: number;
}

export interface BudgetVersionSummary {
  id: string;
  budgetId: string;
  projectId: string;
  frameworkId: string;
  budgetVersion: number;
  totalAmountFen: number;
  note: string | null;
  confirmedAt: string;
  allocations: BudgetAllocationSummary[];
}

export interface FinancialEntryAllocationInput {
  agreementId: string;
  amountFen: number;
}

export interface FinancialEntryAllocationSummary extends FinancialEntryAllocationInput {
  agreementCode: string;
  agreementName: string;
}

export interface CreateFinancialEntryRequest {
  type: FinancialEntryType;
  projectId: string;
  amountFen: number;
  businessDate: string;
  allocations: FinancialEntryAllocationInput[];
  note: string | null;
}

export interface FinancialEntrySummary {
  id: string;
  frameworkId: string;
  projectId: string;
  projectName: string;
  type: FinancialEntryType;
  businessDate: string;
  amountFen: number;
  note: string | null;
  reversesEntryId: string | null;
  allocations: FinancialEntryAllocationSummary[];
  createdAt: string;
}

export interface FinancialEntryPage {
  items: FinancialEntrySummary[];
  nextCursor: string | null;
}

export interface FinanceAgreementMetric {
  id: string;
  code: string;
  name: string;
  amountFen: number;
  budgetCommittedFen: number;
  budgetOccurrenceFen: number;
  actualCostFen: number;
  usageBasisPoints: number | null;
  usageConfigured: boolean;
  usageWarning: boolean;
}

export interface FinanceProjectSummary {
  id: string;
  name: string;
  year: number | null;
  status: ProjectStatus;
  frameworkId: string | null;
  version: number;
}

export interface FrameworkFinanceSummary {
  framework: FrameworkSummary;
  asOf: string;
  confirmedBudgetFen: number;
  budgetOccurrenceFen: number;
  actualCostFen: number;
  agreementReservedFen: number;
  frameworkUsageBasisPoints: number | null;
  frameworkUsageConfigured: boolean;
  frameworkUsageWarning: boolean;
  annualProgressBasisPoints: number | null;
  annualProgressConfigured: boolean;
  budgetOverFrameworkWarning: boolean;
  agreements: FinanceAgreementMetric[];
}

export type AnalysisLagMode = 'ratio' | 'gap';
export type QuarterStatus = 'upcoming' | 'in_progress' | 'ended';
export type MilestoneDatePrecision = 'month' | 'day' | 'unknown';
export type MilestoneStatus = 'open' | 'completed';
export type NotificationOutboxStatus = 'pending' | 'leased' | 'sent' | 'failed' | 'unknown';
export type BackupKind = 'daily' | 'monthly';
export type BackupStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface AnalysisRuleSummary {
  id: string;
  version: number;
  mode: AnalysisLagMode;
  thresholdBasisPoints: number;
  effectiveFrom: string;
  createdAt: string;
}

export interface MonthlyPlanSummary {
  id: string;
  projectId: string;
  businessYear: number;
  month: number;
  targetAmountFen: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface QuarterProgressSummary {
  quarter: 1 | 2 | 3 | 4;
  cumulativeTargetBasisPoints: number;
  status: QuarterStatus;
}

export interface FrameworkProgressSummary {
  frameworkId: string;
  frameworkCode: string;
  frameworkName: string;
  businessYear: number;
  asOf: string;
  annualTargetFen: number;
  annualTargetConfigured: boolean;
  plannedToDateFen: number;
  actualToDateFen: number;
  plannedProgressBasisPoints: number | null;
  actualProgressBasisPoints: number | null;
  attainmentBasisPoints: number | null;
  lagging: boolean;
  planSource: 'custom' | 'default';
  rule: AnalysisRuleSummary;
  quarters: QuarterProgressSummary[];
}

export interface ProjectGapSummary {
  projectId: string;
  projectName: string;
  plannedToDateFen: number;
  actualToDateFen: number;
  gapFen: number;
}

export interface MonthlyReportSummary {
  id: string;
  frameworkId: string;
  businessMonth: string;
  revision: number;
  dataCutoffDate: string;
  ruleVersion: number;
  rule: AnalysisRuleSummary;
  snapshot: {
    progress: FrameworkProgressSummary;
    projectGaps: ProjectGapSummary[];
  };
  createdAt: string;
}

export interface MilestoneSummary {
  id: string;
  businessYear: number;
  title: string;
  owner: string | null;
  projectId: string | null;
  datePrecision: MilestoneDatePrecision;
  month: number | null;
  specificDate: string | null;
  leadDays: number[];
  status: MilestoneStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MilestoneDueSummary extends MilestoneSummary {
  dueMonth: string | null;
  dueDate: string | null;
  needsDate: boolean;
  reminderDue: boolean;
  reminderLeadDays: number | null;
  overdue: boolean;
}

export interface NotificationContactSummary {
  id: string;
  memberId: string;
  address: string;
  verifiedAt: string | null;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AlertEventSummary {
  id: string;
  ruleKey: string;
  ruleVersion: number;
  objectType: string;
  objectId: string;
  periodKey: string;
  severity: 'info' | 'warning' | 'critical';
  state: 'active' | 'resolved';
  message: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

export interface NotificationOutboxSummary {
  id: string;
  eventId: string;
  recipient: string;
  status: NotificationOutboxStatus;
  leaseToken: string | null;
  leasedAt: string | null;
  leaseUntil: string | null;
  attemptCount: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackupSummary {
  id: string;
  backupDate: string;
  kind: BackupKind;
  status: BackupStatus;
  currentTableIndex: number;
  cursorRowid: number;
  manifestKey: string | null;
  chunkCount: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackupVerificationSummary {
  backupId: string;
  verified: boolean;
  missingObjects: string[];
  mismatchedObjects: string[];
  verifiedAt: string | null;
}

export interface ReserveRemainingCategorySummary {
  reserveCategoryId: string;
  categoryKey: string;
  label: string;
  knownCurrentAmountFen: number;
}

export interface ReserveRemainingSummary {
  currentMaterialQuantityScaled: number;
  knownCurrentMaterialAmountFen: number;
  missingPriceCount: number;
  unclassifiedCurrentMaterialFen: number;
  releasedProjectCount: number;
  unscopedCommonCostFen: number;
  categories: ReserveRemainingCategorySummary[];
}

export interface AnalysisDashboardSummary {
  asOf: string;
  projectCount: number;
  demandCount: number;
  unreleasedProjectCount: number;
  pendingSettlementCount: number;
  activeAlertCount: number;
}

export type LifecycleState = 'implemented_settled' | 'implemented_unsettled' | 'unimplemented_settled' | 'unimplemented_unsettled';

export interface ReleaseLineInput {
  demandMaterialId: string;
  quantityScaled: number;
}

export interface CreateReleaseBatchRequest {
  projectId: string;
  expectedProjectVersion: number;
  releaseDate: string;
  note: string | null;
  lines: ReleaseLineInput[];
}

export interface ReleaseLineSummary extends ReleaseLineInput {
  id: string;
  releaseBatchId: string;
  snapshot: {
    demandId: string;
    lineName: string;
    section: string;
    rawModel: string;
    unit: string | null;
    projectVersion: number;
    reserveVersion: number;
  };
}

export interface ReleaseBatchSummary {
  id: string;
  projectId: string;
  releaseDate: string;
  note: string | null;
  projectVersionSnapshot: number;
  reserveVersionSnapshot: number;
  projectVersion: number;
  lines: ReleaseLineSummary[];
  createdAt: string;
}

export interface ImplementationLineInput {
  releaseLineId: string | null;
  description: string | null;
  unit: string | null;
  completedQuantityScaled: number;
  actualUsedQuantityScaled: number | null;
}

export interface CreateImplementationRequest {
  historical: boolean;
  projectId: string | null;
  expectedProjectVersion: number | null;
  recordDate: string;
  personnel: string | null;
  note: string | null;
  lines: ImplementationLineInput[];
}

export interface ImplementationLineSummary extends ImplementationLineInput {
  id: string;
  implementationId: string;
  projectId: string | null;
  demandMaterialId: string | null;
}

export interface ImplementationRecordSummary {
  id: string;
  projectId: string | null;
  historical: boolean;
  recordDate: string;
  personnel: string | null;
  note: string | null;
  version: number;
  projectVersion: number | null;
  lines: ImplementationLineSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface HistoricalImplementationLinkInput {
  implementationLineId: string;
  demandMaterialId: string;
}

export interface LinkHistoricalImplementationRequest {
  expectedVersion: number;
  projectId: string;
  expectedProjectVersion: number;
  links: HistoricalImplementationLinkInput[];
}

export interface SettlementCoverageInput {
  demandMaterialId: string;
  quantityScaled: number;
}

export interface SettlementAgreementAllocationInput {
  agreementId: string;
  amountFen: number;
}

export interface CreateSettlementRequest {
  projectId: string;
  expectedProjectVersion: number;
  settlementDate: string;
  amountFen: number;
  final: boolean;
  note: string | null;
  coverage: SettlementCoverageInput[];
  agreementAllocations: SettlementAgreementAllocationInput[];
}

export interface SettlementSummary {
  id: string;
  projectId: string;
  settlementDate: string;
  amountFen: number;
  final: boolean;
  note: string | null;
  version: number;
  voidedAt: string | null;
  voidReason: string | null;
  projectVersion: number;
  coverage: SettlementCoverageInput[];
  agreementAllocations: SettlementAgreementAllocationInput[];
  createdAt: string;
  updatedAt: string;
}

export interface VoidSettlementRequest {
  expectedVersion: number;
  expectedProjectVersion: number;
  reason: string;
}

export interface LifecycleLineSummary {
  demandId: string;
  demandMaterialId: string;
  lineName: string;
  section: string;
  rawModel: string;
  unit: string | null;
  allocatedQuantityScaled: number;
  releasedQuantityScaled: number;
  implementedQuantityScaled: number;
  settledQuantityScaled: number;
  implementationComplete: boolean;
  settlementComplete: boolean;
  state: LifecycleState;
}

export interface DemandLifecycleSummary {
  demandId: string;
  lineName: string;
  section: string;
  implementationComplete: boolean;
  settlementComplete: boolean;
  state: LifecycleState;
}

export interface SettlementTodoSummary {
  needed: boolean;
  implementationCompletedDate: string | null;
  dueDate: string | null;
  finalSettlementId: string | null;
}

export interface ProjectLifecycleSummary {
  projectId: string;
  projectVersion: number;
  implementationComplete: boolean;
  settlementComplete: boolean;
  projectState: LifecycleState;
  lines: LifecycleLineSummary[];
  demands: DemandLifecycleSummary[];
  settlementTodo: SettlementTodoSummary;
}

export interface AttachmentSummary {
  id: string;
  projectId: string;
  objectType: 'project' | 'release' | 'implementation' | 'settlement';
  objectId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}
