export interface SupplyTotals {
  reportedQuantityScaled: number;
  shippedQuantityScaled: number;
  arrivedQuantityScaled: number;
}

export interface TaskMaterialSupplyState {
  id: string;
  taskId: string;
  projectId: string;
  frameworkId: string | null;
  projectMaterialRequirementId: string | null;
  materialId: string | null;
  model: string;
  unit: string;
  requiredQuantityScaled: number;
  supplyVersion: number;
  totals: SupplyTotals;
}

export interface CreatedSupplyEvent {
  id: string;
  taskMaterialRequirementId: string;
  taskId: string;
  stage: 'reported' | 'shipped' | 'arrived';
  quantityScaled: number;
  eventDate: string;
  note: string | null;
  supplyVersion: number;
  totals: SupplyTotals;
  createdAt: string;
}

export interface CreateSupplyEventRecord {
  event: CreatedSupplyEvent;
  beforeTotals: SupplyTotals;
  expectedSupplyVersion: number;
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
}

export interface TaskSupplyRepository {
  findSupplyState(taskMaterialRequirementId: string): Promise<TaskMaterialSupplyState | null>;
  createSupplyEvent(input: CreateSupplyEventRecord): Promise<void>;
}
