import type { LifecycleState } from './project-execution.ts';

export interface ReleaseLineInput {
  demandMaterialId: string;
  quantityScaled: number;
}

export interface CreateReleaseBatchRequest {
  projectId: string;
  expectedProjectVersion: number;
  releaseDate: string;
  note: string | null;
  lines: ReleaseLineInput[];
}

export interface ReleaseLineSummary extends ReleaseLineInput {
  id: string;
  releaseBatchId: string;
  snapshot: {
    demandId: string;
    lineName: string;
    section: string;
    rawModel: string;
    unit: string | null;
    projectVersion: number;
    reserveVersion: number;
  };
}

export interface ReleaseBatchSummary {
  id: string;
  projectId: string;
  releaseDate: string;
  note: string | null;
  projectVersionSnapshot: number;
  reserveVersionSnapshot: number;
  projectVersion: number;
  lines: ReleaseLineSummary[];
  createdAt: string;
}

export interface ImplementationLineInput {
  releaseLineId: string | null;
  description: string | null;
  unit: string | null;
  completedQuantityScaled: number;
  actualUsedQuantityScaled: number | null;
}

export interface CreateImplementationRequest {
  historical: boolean;
  projectId: string | null;
  expectedProjectVersion: number | null;
  recordDate: string;
  personnel: string | null;
  note: string | null;
  lines: ImplementationLineInput[];
}

export interface ImplementationLineSummary extends ImplementationLineInput {
  id: string;
  implementationId: string;
  projectId: string | null;
  demandMaterialId: string | null;
}

export interface ImplementationRecordSummary {
  id: string;
  projectId: string | null;
  historical: boolean;
  recordDate: string;
  personnel: string | null;
  note: string | null;
  version: number;
  projectVersion: number | null;
  lines: ImplementationLineSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface HistoricalImplementationLinkInput {
  implementationLineId: string;
  demandMaterialId: string;
}

export interface LinkHistoricalImplementationRequest {
  expectedVersion: number;
  projectId: string;
  expectedProjectVersion: number;
  links: HistoricalImplementationLinkInput[];
}

export interface SettlementCoverageInput {
  demandMaterialId: string;
  quantityScaled: number;
}

export interface SettlementAgreementAllocationInput {
  agreementId: string;
  amountFen: number;
}

export interface CreateSettlementRequest {
  projectId: string;
  expectedProjectVersion: number;
  settlementDate: string;
  amountFen: number;
  final: boolean;
  note: string | null;
  coverage: SettlementCoverageInput[];
  agreementAllocations: SettlementAgreementAllocationInput[];
}

export interface SettlementSummary {
  id: string;
  projectId: string;
  settlementDate: string;
  amountFen: number;
  final: boolean;
  note: string | null;
  version: number;
  voidedAt: string | null;
  voidReason: string | null;
  projectVersion: number;
  coverage: SettlementCoverageInput[];
  agreementAllocations: SettlementAgreementAllocationInput[];
  createdAt: string;
  updatedAt: string;
}

export interface VoidSettlementRequest {
  expectedVersion: number;
  expectedProjectVersion: number;
  reason: string;
}

export interface LifecycleLineSummary {
  demandId: string;
  demandMaterialId: string;
  lineName: string;
  section: string;
  rawModel: string;
  unit: string | null;
  allocatedQuantityScaled: number;
  releasedQuantityScaled: number;
  implementedQuantityScaled: number;
  settledQuantityScaled: number;
  implementationComplete: boolean;
  settlementComplete: boolean;
  state: LifecycleState;
}

export interface DemandLifecycleSummary {
  demandId: string;
  lineName: string;
  section: string;
  implementationComplete: boolean;
  settlementComplete: boolean;
  state: LifecycleState;
}

export interface SettlementTodoSummary {
  needed: boolean;
  implementationCompletedDate: string | null;
  dueDate: string | null;
  finalSettlementId: string | null;
}

export interface ProjectLifecycleSummary {
  projectId: string;
  projectVersion: number;
  implementationComplete: boolean;
  settlementComplete: boolean;
  projectState: LifecycleState;
  lines: LifecycleLineSummary[];
  demands: DemandLifecycleSummary[];
  settlementTodo: SettlementTodoSummary;
}

export interface AttachmentSummary {
  id: string;
  projectId: string;
  objectType: 'project' | 'release' | 'implementation' | 'settlement';
  objectId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}
