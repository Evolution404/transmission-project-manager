export interface TaskSettlementHeader {
  id: string;
  projectId: string;
  frameworkId: string | null;
  plannedQuantityScaled: number;
  settlementVersion: number;
}

export interface TaskSettlementScopeState {
  id: string;
  plannedQuantityScaled: number;
  settledQuantityScaled: number;
}

export interface TaskSettlementValidationState {
  previousCoverageQuantityScaled: number;
  scopes: readonly TaskSettlementScopeState[];
}

export interface TaskSettlementEvent {
  id: string;
  taskId: string;
  settlementDate: string;
  coverageQuantityScaled: number;
  amountFen: number;
  final: boolean;
  note: string | null;
  coverage: readonly { taskDemandScopeId: string; quantityScaled: number }[];
  agreementAllocations: readonly { agreementId: string; amountFen: number }[];
  version: number;
  settlementVersion: number;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskSettlementRecord {
  event: TaskSettlementEvent;
  expectedSettlementVersion: number;
  coverageWrites: readonly { id: string; taskDemandScopeId: string; quantityScaled: number }[];
  allocationWrites: readonly { id: string; agreementId: string; amountFen: number }[];
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
}

export interface TaskSettlementVoidState {
  id: string;
  taskId: string;
  projectId: string;
  frameworkId: string | null;
  recordVersion: number;
  settlementVersion: number;
  voidedAt: string | null;
  final: boolean;
  firstImplementationDate: string | null;
  replacementFinalId: string | null;
}

export interface VoidTaskSettlementRecord {
  settlementId: string;
  taskId: string;
  expectedRecordVersion: number;
  expectedSettlementVersion: number;
  final: boolean;
  firstImplementationDate: string | null;
  replacementFinalId: string | null;
  reason: string;
  now: string;
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
  responseData: unknown;
}

export interface TaskSettlementRepository {
  findTaskHeader(taskId: string): Promise<TaskSettlementHeader | null>;
  loadValidationState(taskId: string): Promise<TaskSettlementValidationState>;
  createSettlement(input: CreateTaskSettlementRecord): Promise<void>;
  findVoidState(settlementId: string): Promise<TaskSettlementVoidState | null>;
  voidSettlement(input: VoidTaskSettlementRecord): Promise<void>;
}
