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
  stage: 'p4';
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
  createdAt: string;
}

export interface DemandMaterialSummary {
  id: string;
  rawModel: string;
  quantityScaled: number;
  unit: string | null;
  material: MaterialSummary | null;
}

export interface DemandDetail extends DemandSummary {
  source: {
    batchId: string;
    fileName: string;
    fileSha256: string;
    sheetName: string;
    rowNumber: number;
    raw: Record<string, unknown>;
  };
  materials: DemandMaterialSummary[];
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
  source: { fileName: string; sheetName: string; rowNumber: number };
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
  source: { fileName: string; sheetName: string; rowNumber: number };
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
