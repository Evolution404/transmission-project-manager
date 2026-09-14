import type { ProjectSummary } from '@tpm/shared';

export interface ProjectAllocationWrite {
  id: string;
  demandMaterialId: string;
  quantityScaled: number;
}

export interface AllocationFailure {
  status: 404 | 422;
  code: 'DEMAND_MATERIAL_NOT_FOUND' | 'ALLOCATION_EXCEEDS_REMAINING';
  message: string;
  details?: { demandMaterialId: string; remainingQuantityScaled: number };
}

export interface CreateProjectRecord {
  project: ProjectSummary;
  allocations: ProjectAllocationWrite[];
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
}

export interface ProjectWriteRepository {
  create(input: CreateProjectRecord): Promise<void>;
  findAllocationFailure(allocations: readonly Pick<ProjectAllocationWrite, 'demandMaterialId' | 'quantityScaled'>[]): Promise<AllocationFailure | null>;
}
