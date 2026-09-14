import type { TaskDemandScopeSummary, TaskMaterialRequirementSummary } from '@tpm/shared';

export interface ProjectTaskMaterialAvailability {
  id: string;
  materialId: string | null;
  model: string;
  unit: string;
  requiredQuantityScaled: number;
  assignedQuantityScaled: number;
}

export interface CreatedProjectTaskSummary {
  id: string;
  projectId: string;
  projectReleaseId: string;
  name: string;
  description: string | null;
  scopeText: string | null;
  owner: string | null;
  plannedDate: string | null;
  plannedQuantityScaled: number;
  unit: string;
  version: number;
  implementationVersion: number;
  settlementVersion: number;
  projectVersion: number;
  demandScopes: TaskDemandScopeSummary[];
  materials: TaskMaterialRequirementSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectTaskRecord {
  task: CreatedProjectTaskSummary;
  expectedProjectVersion: number;
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
}

export interface ProjectTaskRepository {
  listLinkedDemandIds(projectId: string): Promise<readonly string[]>;
  listProjectMaterialAvailability(projectId: string): Promise<readonly ProjectTaskMaterialAvailability[]>;
  createTask(input: CreateProjectTaskRecord): Promise<void>;
}
