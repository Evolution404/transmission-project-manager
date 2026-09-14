import type { DemandLocationType, MaterialSummary } from '@tpm/shared';

export interface ResolvedDemandLine {
  id: string;
  lineName: string;
  enabled: boolean;
  voltageLevelId: string;
  voltageName: string;
  voltageEnabled: boolean;
}

export interface ResolvedDemandTower {
  id: string;
  towerNo: string;
  sortIndex: number;
  lineId: string;
  enabled: boolean;
}

export interface StructuredDemandMaterialWrite {
  id: string;
  rawModel: string;
  materialId: string | null;
  quantityScaled: number;
  unit: string | null;
}

export interface CreateStructuredDemandRecord {
  id: string;
  sourceKey: string;
  sequenceNo: string;
  year: number | null;
  voltageLevelId: string;
  lineId: string;
  locationType: DemandLocationType;
  startTowerId: string | null;
  endTowerId: string | null;
  voltageName: string;
  lineName: string;
  sectionText: string;
  category: string | null;
  owner: string | null;
  businessSignature: string;
  rawJson: string;
  actorId: string;
  now: string;
  materials: StructuredDemandMaterialWrite[];
  materialVersions: Record<string, number>;
  responseJson: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  auditId: string;
  auditAfter: unknown;
}

export interface DemandRepository {
  findLine(lineId: string): Promise<ResolvedDemandLine | null>;
  findTowers(ids: readonly string[]): Promise<readonly ResolvedDemandTower[]>;
  findEnabledMaterials(ids: readonly string[]): Promise<readonly MaterialSummary[]>;
  createStructured(input: CreateStructuredDemandRecord): Promise<void>;
}
