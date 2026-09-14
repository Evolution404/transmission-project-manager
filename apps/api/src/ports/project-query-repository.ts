import type { ReserveCandidate } from '@tpm/shared';

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

export interface ProjectQueryRepository {
  listCandidates(input: { limit: number; cursor: string | null }): Promise<ReserveCandidatePage>;
  listSuggestions(limit: number): Promise<readonly ProjectSuggestionGroup[]>;
}
