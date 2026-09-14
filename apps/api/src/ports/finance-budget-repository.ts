import type { BudgetVersionSummary, ProjectBudgetSummary } from '@tpm/shared';

interface BudgetMutationMeta {
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
}

export interface BudgetAllocationWrite {
  id: string;
  agreementId: string;
  amountFen: number;
}

export interface CreateBudgetRecord extends BudgetMutationMeta {
  budget: ProjectBudgetSummary;
  allocations: readonly BudgetAllocationWrite[];
}

export interface UpdateBudgetRecord extends BudgetMutationMeta {
  before: ProjectBudgetSummary;
  next: ProjectBudgetSummary;
  expectedVersion: number;
  allocations: readonly BudgetAllocationWrite[];
}

export interface ConfirmBudgetRecord extends BudgetMutationMeta {
  before: ProjectBudgetSummary;
  next: ProjectBudgetSummary;
  expectedVersion: number;
  budgetVersionId: string;
  allocations: readonly BudgetAllocationWrite[];
}

export interface FinanceBudgetRepository {
  listBudgets(projectId: string | null): Promise<readonly ProjectBudgetSummary[]>;
  findBudget(id: string): Promise<ProjectBudgetSummary | null>;
  getBudgetHistory(id: string): Promise<readonly BudgetVersionSummary[] | null>;
  createBudget(input: CreateBudgetRecord): Promise<void>;
  updateBudget(input: UpdateBudgetRecord): Promise<void>;
  confirmBudget(input: ConfirmBudgetRecord): Promise<void>;
}
