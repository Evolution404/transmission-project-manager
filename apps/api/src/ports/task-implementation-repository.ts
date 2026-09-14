export interface TaskImplementationHeader {
  id: string;
  projectId: string;
  frameworkId: string | null;
  plannedQuantityScaled: number;
  implementationVersion: number;
}

export interface TaskImplementationScopeState {
  id: string;
  plannedQuantityScaled: number;
  usedQuantityScaled: number;
}

export interface TaskImplementationMaterialState {
  id: string;
  requiredQuantityScaled: number;
  usedQuantityScaled: number;
}

export interface TaskImplementationValidationState {
  previousCompletedQuantityScaled: number;
  scopes: readonly TaskImplementationScopeState[];
  materials: readonly TaskImplementationMaterialState[];
  finalSettlementId: string | null;
  firstImplementationDate: string | null;
}

export interface TaskImplementationEvent {
  id: string;
  taskId: string;
  recordDate: string;
  completedQuantityScaled: number;
  scopeLines: readonly { taskDemandScopeId: string; completedQuantityScaled: number }[];
  materialUsages: readonly { taskMaterialRequirementId: string; quantityScaled: number }[];
  note: string | null;
  implementationVersion: number;
  createdAt: string;
}

export interface CreateTaskImplementationRecord {
  event: TaskImplementationEvent;
  expectedImplementationVersion: number;
  scopeWrites: readonly { id: string; taskDemandScopeId: string; completedQuantityScaled: number }[];
  usageWrites: readonly { id: string; taskMaterialRequirementId: string; quantityScaled: number }[];
  reminder: {
    firstImplementationDate: string;
    dueDate: string;
    status: 'open' | 'closed';
    finalSettlementId: string | null;
  };
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
}

export interface TaskImplementationRepository {
  findTaskHeader(taskId: string): Promise<TaskImplementationHeader | null>;
  loadValidationState(taskId: string): Promise<TaskImplementationValidationState>;
  createImplementation(input: CreateTaskImplementationRecord): Promise<void>;
}
