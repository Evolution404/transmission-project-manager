import type { AgreementSummary } from '@tpm/shared';

export interface FinanceSummaryAgreementFacts {
  agreement: AgreementSummary;
  budgetCommittedFen: number;
  budgetOccurrenceFen: number;
  actualCostFen: number;
}

export interface FinanceSummaryFacts {
  confirmedBudgetFen: number;
  budgetOccurrenceFen: number;
  actualCostFen: number;
  agreements: FinanceSummaryAgreementFacts[];
}

export interface FinanceSummaryRepository {
  getFacts(frameworkId: string, asOf: string): Promise<FinanceSummaryFacts>;
}
