import type { CategoryMappingSummary, ProjectDetail, ProjectSummary, ProjectVersionSummary, ReserveCandidate, ReserveCategorySummary } from '@tpm/shared';

export interface ReserveCandidatePage {
  items: readonly ReserveCandidate[];
  nextCursor: string | null;
}

export interface ProjectSuggestionGroup {
  year: number | null;
  category: string | null;
  voltage: string;
  lineName: string;
  itemCount: number;
}

export interface ProjectPageCursor {
  createdAt: string;
  id: string;
}

export interface ProjectPage {
  items: readonly ProjectSummary[];
  nextCursor: ProjectPageCursor | null;
}

export interface ProjectQueryRepository {
  listCandidates(input: { limit: number; cursor: string | null }): Promise<ReserveCandidatePage>;
  listSuggestions(limit: number): Promise<readonly ProjectSuggestionGroup[]>;
  listProjects(input: { allowedProjectIds: readonly string[] | null; cursor: ProjectPageCursor | null; limit: number }): Promise<ProjectPage>;
  getProjectDetail(id: string): Promise<ProjectDetail | null>;
  listReserveCategories(): Promise<readonly ReserveCategorySummary[]>;
  listCategoryMappings(): Promise<readonly CategoryMappingSummary[]>;
  getProjectHistory(projectId: string): Promise<readonly ProjectVersionSummary[] | null>;
}
