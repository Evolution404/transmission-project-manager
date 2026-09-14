import type { MaterialSummary } from '@tpm/shared';

export interface CreateMaterialRecord {
  material: MaterialSummary;
  actorId: string;
  now: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
}

export interface MaterialRepository {
  list(input: { query: string; limit: number }): Promise<readonly MaterialSummary[]>;
  create(input: CreateMaterialRecord): Promise<void>;
}
