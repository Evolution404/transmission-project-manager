import type { ProjectStatus } from './reserve-planning';

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
