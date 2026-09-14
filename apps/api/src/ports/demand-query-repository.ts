import type { DemandDetail, DemandSummary } from '@tpm/shared';

export interface DemandPageCursor {
  createdAt: string;
  id: string;
}

export interface DemandPage {
  items: readonly DemandSummary[];
  nextCursor: DemandPageCursor | null;
}

export interface DemandQueryRepository {
  list(input: { query: string; cursor: DemandPageCursor | null; limit: number }): Promise<DemandPage>;
  getById(id: string): Promise<DemandDetail | null>;
}
