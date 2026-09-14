import type { ReserveProjectSummary } from '@tpm/shared';
import type { ResolvedProjectMaterialInput } from './reserve-project-query-repository.ts';

interface MutationMeta {
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
  now: string;
}

export interface CreateReserveProjectRecord extends MutationMeta {
  project: { id: string; name: string; year: number | null; owner: string | null };
  demandLinks: readonly { id: string; demandId: string }[];
  materials: readonly { id: string; item: ResolvedProjectMaterialInput }[];
  auditAfter: unknown;
}

export interface ReplaceReserveProjectDemandsRecord extends MutationMeta {
  projectId: string;
  expectedVersion: number;
  beforeDemandIds: readonly string[];
  demandLinks: readonly { id: string; demandId: string }[];
}

export interface ReplaceReserveProjectMaterialsRecord extends MutationMeta {
  projectId: string;
  expectedVersion: number;
  reason: string;
  revisionId: string;
  before: unknown;
  after: unknown;
  materials: readonly { id: string; existing: boolean; item: ResolvedProjectMaterialInput }[];
}

export interface ConfirmReserveProjectRecord extends MutationMeta {
  projectId: string;
  expectedVersion: number;
  previousReserveVersion: number;
  reserveVersion: number;
  versionId: string;
  snapshot: ReserveProjectSummary;
  reason: string | null;
  auditAfter: unknown;
}

export interface ReserveProjectWriteRepository {
  create(input: CreateReserveProjectRecord): Promise<void>;
  replaceDemands(input: ReplaceReserveProjectDemandsRecord): Promise<void>;
  replaceMaterials(input: ReplaceReserveProjectMaterialsRecord): Promise<void>;
  confirm(input: ConfirmReserveProjectRecord): Promise<void>;
}
