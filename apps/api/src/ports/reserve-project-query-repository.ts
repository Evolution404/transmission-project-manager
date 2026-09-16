import type { ProjectMaterialRequirementSummary, ReserveProjectSummary } from '@tpm/shared';

export interface ReserveProjectState {
  id: string;
  frameworkId: string | null;
  status: 'draft' | 'confirmed';
  reserveVersion: number;
  version: number;
}

export interface ProjectMaterialInputCandidate {
  id: string | null;
  materialId: string | null;
  model: string;
  unit: string;
  requiredQuantityScaled: number;
  unitPriceScaled: number | null;
  reserveCategoryId: string | null;
}

export interface ResolvedProjectMaterialInput extends ProjectMaterialInputCandidate {
  amountFen: number | null;
}

export interface ProjectMaterialRevisionSummary {
  id: string;
  projectId: string;
  projectVersion: number;
  reason: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export type ReserveProjectListStage = 'all' | 'reserve';

export interface ReserveProjectListCursor {
  createdAt: string;
  id: string;
}

export interface ReserveProjectListInput {
  limit: number;
  stage: ReserveProjectListStage;
  cursor: ReserveProjectListCursor | null;
  access: { projectIds: readonly string[]; frameworkIds: readonly string[] } | null;
}

export interface ReserveProjectQueryRepository {
  list(input: ReserveProjectListInput): Promise<readonly ReserveProjectSummary[]>;
  find(projectId: string): Promise<ReserveProjectSummary | null>;
  findState(projectId: string): Promise<ReserveProjectState | null>;
  validateDemandIds(ids: readonly string[]): Promise<boolean>;
  resolveMaterials(items: readonly ProjectMaterialInputCandidate[]): Promise<readonly ResolvedProjectMaterialInput[] | null>;
  listMaterialRevisions(projectId: string): Promise<readonly ProjectMaterialRevisionSummary[]>;
  listUsedDemandIds(projectId: string): Promise<readonly string[]>;
  getAssignedMaterialQuantities(projectId: string): Promise<ReadonlyMap<string, number>>;
  listCurrentMaterials(projectId: string): Promise<readonly ProjectMaterialRequirementSummary[]>;
}
