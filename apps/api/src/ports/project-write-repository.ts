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

export interface ReplaceProjectAllocationsRecord {
  projectId: string;
  expectedVersion: number;
  now: string;
  allocations: ProjectAllocationWrite[];
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
}

export interface ProjectWriteState {
  id: string;
  name: string;
  year: number | null;
  owner: string | null;
  status: 'draft' | 'confirmed';
  reserveVersion: number;
  frameworkId: string | null;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProtectedProjectScopeItem {
  demandMaterialId: string;
  protectedQuantityScaled: number;
}

export interface ProjectCostLineWrite {
  id: string;
  kind: 'material' | 'construction' | 'other';
  demandAllocationId: string | null;
  label: string;
  unitPriceScaled: number | null;
  amountFen: number | null;
  source: string | null;
  priceDate: string | null;
  taxInclusive: boolean | null;
}

export interface ReplaceProjectCostsRecord {
  projectId: string;
  expectedVersion: number;
  now: string;
  lines: ProjectCostLineWrite[];
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
  auditAfter: unknown;
}

export interface ProjectCategoryAllocationWrite {
  id: string;
  costLineId: string;
  reserveCategoryId: string;
  amountFen: number;
}

export interface ReplaceProjectCategoryAllocationsRecord {
  projectId: string;
  expectedVersion: number;
  now: string;
  allocations: ProjectCategoryAllocationWrite[];
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
  auditAfter: unknown;
}

export interface ProjectWriteRepository {
  create(input: CreateProjectRecord): Promise<void>;
  replaceAllocations(input: ReplaceProjectAllocationsRecord): Promise<void>;
  replaceCosts(input: ReplaceProjectCostsRecord): Promise<void>;
  replaceCategoryAllocations(input: ReplaceProjectCategoryAllocationsRecord): Promise<void>;
  findProject(id: string): Promise<ProjectWriteState | null>;
  getProtectedScope(projectId: string): Promise<readonly ProtectedProjectScopeItem[]>;
  findAllocationFailure(allocations: readonly Pick<ProjectAllocationWrite, 'demandMaterialId' | 'quantityScaled'>[]): Promise<AllocationFailure | null>;
}
