export interface DemandMaterialWrite {
  id: string;
  rawModel: string;
  materialId: string | null;
  quantityScaled: number;
  unit: string | null;
}

export interface DemandMaterialWriteState {
  id: string;
  version: number;
}

export interface AppendDemandMaterialsRecord {
  demandId: string;
  expectedVersion: number;
  rows: readonly DemandMaterialWrite[];
  now: string;
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
}

export interface DemandMaterialWriteRepository {
  findState(demandId: string): Promise<DemandMaterialWriteState | null>;
  append(input: AppendDemandMaterialsRecord): Promise<void>;
}
