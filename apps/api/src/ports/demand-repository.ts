import type { MaterialSummary } from '@tpm/shared';

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

export interface DemandRepository {
  findLine(lineId: string): Promise<ResolvedDemandLine | null>;
  findTowers(ids: readonly string[]): Promise<readonly ResolvedDemandTower[]>;
  findEnabledMaterials(ids: readonly string[]): Promise<readonly MaterialSummary[]>;
}
