import type {
  AgreementSummary,
  AgreementVersionSummary,
  FinanceProjectSummary,
  FrameworkSummary,
  FrameworkVersionSummary,
} from '@tpm/shared';

export interface FinanceQueryRepository {
  listProjects(): Promise<readonly FinanceProjectSummary[]>;
  findProject(id: string): Promise<FinanceProjectSummary | null>;
  hasProjectFinanceHistory(id: string): Promise<boolean>;
  listFrameworks(): Promise<readonly FrameworkSummary[]>;
  findFramework(id: string): Promise<FrameworkSummary | null>;
  getFrameworkHistory(id: string): Promise<readonly FrameworkVersionSummary[] | null>;
  listAgreements(frameworkId: string | null): Promise<readonly AgreementSummary[]>;
  findAgreement(id: string): Promise<AgreementSummary | null>;
  getAgreementHistory(id: string): Promise<readonly AgreementVersionSummary[] | null>;
}
