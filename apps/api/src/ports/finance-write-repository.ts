import type { AgreementSummary, FrameworkSummary } from '@tpm/shared';

interface MutationMeta {
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
}

export interface CreateFrameworkRecord extends MutationMeta {
  framework: FrameworkSummary;
  versionId: string;
}

export interface UpdateFrameworkRecord extends MutationMeta {
  before: FrameworkSummary;
  next: FrameworkSummary;
  expectedVersion: number;
  reason: string | null;
  versionId: string;
}

export interface BindProjectFrameworkRecord extends MutationMeta {
  projectId: string;
  beforeFrameworkId: string | null;
  frameworkId: string;
  expectedVersion: number;
  nextVersion: number;
  now: string;
}

export interface CreateAgreementRecord extends MutationMeta {
  agreement: AgreementSummary;
  versionId: string;
}

export interface UpdateAgreementRecord extends MutationMeta {
  before: AgreementSummary;
  next: AgreementSummary;
  expectedVersion: number;
  reason: string | null;
  versionId: string;
}

export interface FinanceWriteRepository {
  bindProjectFramework(input: BindProjectFrameworkRecord): Promise<void>;
  createFramework(input: CreateFrameworkRecord): Promise<void>;
  updateFramework(input: UpdateFrameworkRecord): Promise<void>;
  createAgreement(input: CreateAgreementRecord): Promise<void>;
  updateAgreement(input: UpdateAgreementRecord): Promise<void>;
}
