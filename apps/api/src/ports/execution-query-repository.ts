import type { DemandExecutionSummary, ProjectTaskExecutionSummary } from '@tpm/shared';

export interface ExecutionProjectHeader {
  id: string;
  frameworkId: string | null;
  version: number;
  released: boolean;
}

export interface DemandExecutionAccess {
  summary: DemandExecutionSummary;
  projects: readonly { id: string; frameworkId: string | null }[];
}

export interface ExecutionQueryRepository {
  findProjectHeader(projectId: string): Promise<ExecutionProjectHeader | null>;
  listProjectTasks(projectId: string): Promise<readonly ProjectTaskExecutionSummary[]>;
  findDemandExecution(demandId: string): Promise<DemandExecutionAccess | null>;
  listProjectDemands(projectId: string): Promise<readonly DemandExecutionSummary[]>;
}
