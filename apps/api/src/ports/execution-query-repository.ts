import type { DemandExecutionSummary, ProjectTaskExecutionSummary, TaskQueueItemSummary, TaskQueueStatus } from '@tpm/shared';

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

export interface TaskQueueCursor {
  plannedKey: string;
  createdAt: string;
  id: string;
}

export interface TaskQueuePageResult {
  items: readonly TaskQueueItemSummary[];
  nextCursor: TaskQueueCursor | null;
}

export interface ExecutionQueryRepository {
  findProjectHeader(projectId: string): Promise<ExecutionProjectHeader | null>;
  listProjectTasks(projectId: string): Promise<readonly ProjectTaskExecutionSummary[]>;
  listTaskQueue(input: {
    memberId: string;
    unrestricted: boolean;
    query: string;
    status: TaskQueueStatus;
    plannedBefore?: string | null;
    cursor: TaskQueueCursor | null;
    limit: number;
  }): Promise<TaskQueuePageResult>;
  findDemandExecution(demandId: string): Promise<DemandExecutionAccess | null>;
  listProjectDemands(projectId: string): Promise<readonly DemandExecutionSummary[]>;
}
