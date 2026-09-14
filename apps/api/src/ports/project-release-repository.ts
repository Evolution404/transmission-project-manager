import type { ProjectReleaseSummary } from '@tpm/shared';

export interface ExecutionProjectState {
  id: string;
  name: string;
  year: number | null;
  owner: string | null;
  status: 'draft' | 'confirmed';
  reserveVersion: number;
  frameworkId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type ProjectReleaseSnapshot = ProjectReleaseSummary['snapshot'];

export interface CreateProjectReleaseRecord {
  release: ProjectReleaseSummary;
  expectedProjectVersion: number;
  actorId: string;
  auditId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseJson: string;
}

export interface ProjectReleaseRepository {
  findProject(id: string): Promise<ExecutionProjectState | null>;
  findProjectReleaseId(projectId: string): Promise<string | null>;
  loadSnapshot(projectId: string, projectVersion: number, reserveVersion: number): Promise<ProjectReleaseSnapshot>;
  listReleases(projectId: string): Promise<readonly ProjectReleaseSummary[]>;
  createRelease(input: CreateProjectReleaseRecord): Promise<void>;
}
