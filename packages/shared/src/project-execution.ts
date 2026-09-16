export type LifecycleState = 'implemented_settled' | 'implemented_unsettled' | 'unimplemented_settled' | 'unimplemented_unsettled';

export interface ProjectDemandLinkSummary {
  id: string;
  demandId: string;
  sequenceNo: string;
  year: number | null;
  voltage: string;
  lineName: string;
  section: string;
  category: string | null;
  owner: string | null;
  createdAt: string;
}

export interface ProjectMaterialRequirementSummary {
  id: string;
  projectId: string;
  materialId: string | null;
  model: string;
  unit: string;
  requiredQuantityScaled: number;
  unitPriceScaled: number | null;
  amountFen: number | null;
  reserveCategoryId: string | null;
  reserveCategory: { id: string; key: string; label: string } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReserveProjectSummary {
  id: string;
  name: string;
  year: number | null;
  owner: string | null;
  status: 'draft' | 'confirmed';
  reserveVersion: number;
  frameworkId: string | null;
  version: number;
  demandLinks: ProjectDemandLinkSummary[];
  materialRequirements: ProjectMaterialRequirementSummary[];
  knownMaterialAmountFen: number;
  missingPriceCount: number;
  materialPriceCompletenessBasisPoints: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectReleaseSummary {
  id: string;
  projectId: string;
  releaseDate: string;
  note: string | null;
  projectVersionSnapshot: number;
  reserveVersionSnapshot: number;
  projectVersion: number;
  snapshot: {
    demandLinks: ProjectDemandLinkSummary[];
    materialRequirements: ProjectMaterialRequirementSummary[];
    projectVersion: number;
    reserveVersion: number;
  };
  createdAt: string;
}

export interface TaskDemandScopeSummary {
  id: string;
  taskId: string;
  demandId: string;
  plannedQuantityScaled: number;
  demand?: { sequenceNo: string; lineName: string; section: string };
}

export interface TaskMaterialRequirementSummary {
  id: string;
  taskId: string;
  projectMaterialRequirementId: string | null;
  materialId: string | null;
  model: string;
  unit: string;
  requiredQuantityScaled: number;
  supplyVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskMaterialSupplyTotals {
  taskMaterialRequirementId: string;
  model: string;
  unit: string;
  totals: {
    reportedQuantityScaled: number;
    shippedQuantityScaled: number;
    arrivedQuantityScaled: number;
  };
}

export interface DemandExecutionSummary {
  demandId: string;
  sequenceNo: string;
  lineName: string;
  section: string;
  plannedQuantityScaled: number;
  implementedQuantityScaled: number;
  settledQuantityScaled: number;
  implementationProgressBasisPoints: number;
  settlementProgressBasisPoints: number;
  implementationComplete: boolean;
  settlementComplete: boolean;
  state: LifecycleState;
}

export interface ProjectTaskExecutionSummary {
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
  demandScopes: TaskDemandScopeSummary[];
  materials: TaskMaterialRequirementSummary[];
  supplyTotals: TaskMaterialSupplyTotals[];
  implementedQuantityScaled: number;
  settledQuantityScaled: number;
  implementationComplete: boolean;
  settlementComplete: boolean;
  state: LifecycleState;
  settlementReminder: {
    needed: boolean;
    firstImplementationDate: string | null;
    dueDate: string | null;
    finalSettlementId: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ProjectExecutionSummary {
  projectId: string;
  projectVersion: number;
  released: boolean;
  tasks: ProjectTaskExecutionSummary[];
  demands: DemandExecutionSummary[];
  implementationComplete: boolean;
  settlementComplete: boolean;
  projectState: LifecycleState;
}

export type TaskQueueStatus = 'all' | 'implementation_pending' | 'settlement_pending';

export interface TaskQueueItemSummary {
  id: string;
  projectId: string;
  projectName: string;
  projectYear: number | null;
  projectOwner: string | null;
  name: string;
  scopeText: string | null;
  owner: string | null;
  plannedDate: string | null;
  plannedQuantityScaled: number;
  unit: string;
  supplyTotals: TaskMaterialSupplyTotals[];
  implementedQuantityScaled: number;
  settledQuantityScaled: number;
  implementationComplete: boolean;
  settlementComplete: boolean;
  state: LifecycleState;
  settlementReminder: {
    needed: boolean;
    firstImplementationDate: string | null;
    dueDate: string | null;
    finalSettlementId: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface TaskQueuePage {
  items: TaskQueueItemSummary[];
  nextCursor: string | null;
}
