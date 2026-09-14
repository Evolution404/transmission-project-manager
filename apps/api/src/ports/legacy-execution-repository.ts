import type {
  ImplementationRecordSummary,
  ProjectLifecycleSummary,
  ReleaseBatchSummary,
  SettlementSummary,
} from '@tpm/shared';

export interface LegacyProjectState {
  id: string;
  name: string;
  frameworkId: string | null;
  status: 'draft' | 'confirmed';
  reserveVersion: number;
  version: number;
  updatedAt: string;
}

export interface LegacyScopeItem {
  allocationId: string;
  demandMaterialId: string;
  quantityScaled: number;
  rawModel: string;
  unit: string | null;
  demandId: string;
  lineName: string;
  section: string;
}

export interface LegacyReleaseLineState {
  id: string;
  releaseBatchId: string;
  projectId: string;
  demandMaterialId: string;
  quantityScaled: number;
  snapshotJson: string;
  createdAt: string;
}

export interface LegacyImplementationState {
  summary: ImplementationRecordSummary;
  rawLines: readonly {
    id: string;
    releaseLineId: string | null;
    demandMaterialId: string | null;
    description: string | null;
    unit: string | null;
    completedQuantityScaled: number;
    actualUsedQuantityScaled: number | null;
  }[];
}

export interface LegacySettlementState {
  summary: SettlementSummary;
  projectId: string;
  version: number;
  voidedAt: string | null;
  final: boolean;
}

export interface LegacyWriteMeta {
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
  statusCode: number;
  now: string;
}

export interface LegacyExecutionRepository {
  findProject(id: string): Promise<LegacyProjectState | null>;
  loadProjectScope(projectId: string): Promise<readonly LegacyScopeItem[]>;
  releasedTotals(projectId: string): Promise<ReadonlyMap<string, number>>;
  implementedTotals(projectId: string): Promise<ReadonlyMap<string, number>>;
  implementedReleaseTotals(projectId: string): Promise<ReadonlyMap<string, number>>;
  activeSettlementTotals(projectId: string): Promise<ReadonlyMap<string, number>>;
  listReleaseBatches(projectId: string): Promise<readonly ReleaseBatchSummary[]>;
  findReleaseLines(projectId: string): Promise<readonly LegacyReleaseLineState[]>;
  listImplementations(input: { projectId: string | null; unlinked: boolean }): Promise<readonly ImplementationRecordSummary[]>;
  findImplementation(id: string): Promise<LegacyImplementationState | null>;
  listSettlements(projectId: string): Promise<readonly SettlementSummary[]>;
  findSettlement(id: string): Promise<LegacySettlementState | null>;
  lifecycle(projectId: string): Promise<ProjectLifecycleSummary | null>;

  createReleaseBatch(input: {
    projectId: string;
    expectedProjectVersion: number;
    batch: ReleaseBatchSummary;
    meta: LegacyWriteMeta;
  }): Promise<void>;
  createHistoricalImplementation(input: { summary: ImplementationRecordSummary; meta: LegacyWriteMeta }): Promise<void>;
  createImplementation(input: {
    expectedProjectVersion: number;
    summary: ImplementationRecordSummary;
    meta: LegacyWriteMeta;
  }): Promise<void>;
  linkHistoricalImplementation(input: {
    expectedProjectVersion: number;
    expectedRecordVersion: number;
    summary: ImplementationRecordSummary;
    meta: LegacyWriteMeta;
  }): Promise<void>;
  createSettlement(input: {
    expectedProjectVersion: number;
    summary: SettlementSummary;
    meta: LegacyWriteMeta;
  }): Promise<void>;
  voidSettlement(input: {
    expectedProjectVersion: number;
    expectedSettlementVersion: number;
    summary: SettlementSummary;
    reason: string;
    meta: LegacyWriteMeta;
  }): Promise<void>;
}
