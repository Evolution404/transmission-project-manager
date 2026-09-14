import type { ImportMappingTemplate } from '@tpm/shared';

export interface CreateImportMappingRecord {
  template: ImportMappingTemplate;
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
}

export interface ImportMappingRepository {
  list(): Promise<readonly ImportMappingTemplate[]>;
  create(input: CreateImportMappingRecord): Promise<void>;
}
