import type { FinancialEntrySummary } from '@tpm/shared';

export interface FinancialEntryCursor {
  businessDate: string;
  createdAt: string;
  id: string;
}

export interface FinancialEntryListInput {
  frameworkId: string | null;
  projectId: string | null;
  cursor: FinancialEntryCursor | null;
  limit: number;
}

interface EntryMutationMeta {
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
}

export interface FinancialEntryAllocationWrite {
  id: string;
  agreementId: string;
  amountFen: number;
}

export interface CreateFinancialEntryRecord extends EntryMutationMeta {
  entry: FinancialEntrySummary;
  allocations: readonly FinancialEntryAllocationWrite[];
}

export interface ReverseFinancialEntryRecord extends EntryMutationMeta {
  original: FinancialEntrySummary;
  reversal: FinancialEntrySummary;
  allocations: readonly FinancialEntryAllocationWrite[];
}

export interface FinanceEntryRepository {
  listEntries(input: FinancialEntryListInput): Promise<readonly FinancialEntrySummary[]>;
  findEntry(id: string): Promise<FinancialEntrySummary | null>;
  hasReversal(entryId: string): Promise<boolean>;
  createEntry(input: CreateFinancialEntryRecord): Promise<void>;
  reverseEntry(input: ReverseFinancialEntryRecord): Promise<void>;
}
