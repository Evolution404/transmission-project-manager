import type { CategoryMappingSummary, ReserveCategorySummary } from '@tpm/shared';

export interface CreateReserveCategoryRecord {
  category: ReserveCategorySummary;
  actorId: string;
  now: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
}

export interface UpsertCategoryMappingRecord {
  mapping: CategoryMappingSummary;
  expectedVersion: number | null;
  actorId: string;
  now: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
  before: CategoryMappingSummary | null;
}

export interface ReserveCategoryWriteRepository {
  findCategory(id: string): Promise<ReserveCategorySummary | null>;
  findMapping(demandCategory: string): Promise<CategoryMappingSummary | null>;
  createCategory(input: CreateReserveCategoryRecord): Promise<void>;
  upsertMapping(input: UpsertCategoryMappingRecord): Promise<void>;
}
